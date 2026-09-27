/**
 * Rã nguyên liệu theo doanh thu (phần có chạm DB) — tách khỏi app/api/inventory/route.ts để script
 * sửa dữ liệu trên server (scripts/rerun-explosions.mjs) dùng lại đúng logic của nút Rã / rã lại,
 * không phải viết lại. Phần tính thuần nằm ở lib/production-explosion.ts.
 */
import { Prisma } from "@prisma/custom-client";
import type { TxClient } from "@/lib/prisma";
import { businessError, cleanText } from "@/lib/phase3";
import { nextStockDocCode, postInventoryTransaction, reverseStockEffect } from "@/lib/inventory-stock";
import { explodeSalesDemand, explodeSalesDemandWithDepartments, type ExplosionRecipe } from "@/lib/production-explosion";
import { loadNonInventoryRevenueGroups, tracksInventory, type CategoryLookupClient } from "@/lib/revenue-source";
import { buildRevenueDepartmentResolver, departmentFromWarehouseGroup, REVENUE_DEPARTMENT_CODES } from "@/lib/revenue-department";

const quantityEpsilon = 0.000001;

/** Một lần rã (RA-...) cần gỡ / rã lại. */
export type AffectedExplosionRun = { runCode: string; branchCode: string; date: Date; productCodes: string[] };

export type ExplosionRunInput = {
  branchCode: string;
  warehouseCode: string;
  toWarehouseCode: string;
  kitchenWarehouseCode: string;
  barWarehouseCode: string;
  dateFrom: Date;
  dateTo: Date;
  note: string;
  createdBy: string;
  /** Rã lại một lần rã cũ: chỉ lấy đúng các dòng doanh thu này. */
  rowIds?: string[];
};

/**
 * Kho thực dùng cho một lần rã (khách chốt 27/09/2026: chế biến chỉ ở kho BẾP / kho BAR, không
 * bao giờ ở kho văn phòng / kho tổng):
 *   - kho bếp / kho bar không chỉ định (lần rã cũ chưa có hai ô này, rã lại khi sửa định lượng
 *     đọc nhật ký cũ) thì lấy kho bếp / kho bar DUY NHẤT của cửa hàng theo nhóm kho;
 *   - kho mặc định (xuất NVL, nhập BTP/TP) không thuộc nhóm bếp/bar thì đổi về kho bếp (không có
 *     kho bếp thì kho bar). Cửa hàng chưa khai nhóm kho nào thì giữ nguyên như cũ.
 * Đặt ở lõi rã nên nút Rã, rã lại khi sửa định lượng và script rerun:explosions cùng một luật.
 */
export async function resolveExplosionWarehouses(
  tx: TxClient,
  input: Pick<ExplosionRunInput, "branchCode" | "warehouseCode" | "toWarehouseCode" | "kitchenWarehouseCode" | "barWarehouseCode">,
) {
  const branchWarehouses = await tx.masterDataItem.findMany({
    where: { type: "WAREHOUSE", branch: input.branchCode, status: "ACTIVE" },
    select: { code: true, group: true },
  });
  const departmentOfWarehouse = (code: string) => departmentFromWarehouseGroup(branchWarehouses.find((row) => row.code === code)?.group);
  const onlyWarehouseOf = (department: string) => {
    const found = branchWarehouses.filter((row) => departmentFromWarehouseGroup(row.group) === department);
    return found.length === 1 ? found[0].code : "";
  };
  const kitchenWarehouseCode = input.kitchenWarehouseCode || onlyWarehouseOf(REVENUE_DEPARTMENT_CODES.KITCHEN);
  const barWarehouseCode = input.barWarehouseCode || onlyWarehouseOf(REVENUE_DEPARTMENT_CODES.BAR);
  const isProduction = (code: string) => {
    const department = departmentOfWarehouse(code);
    return department === REVENUE_DEPARTMENT_CODES.KITCHEN || department === REVENUE_DEPARTMENT_CODES.BAR;
  };
  const productionFallback = kitchenWarehouseCode || barWarehouseCode;
  const warehouseCode = isProduction(input.warehouseCode) || !productionFallback ? input.warehouseCode : productionFallback;
  const toWarehouseCode = isProduction(input.toWarehouseCode) || !productionFallback ? input.toWarehouseCode : productionFallback;
  return { warehouseCode, toWarehouseCode, kitchenWarehouseCode, barWarehouseCode };
}

export async function executeExplosion(tx: TxClient, input: ExplosionRunInput) {
  const { branchCode, dateFrom, dateTo } = input;
  const warehouses = await resolveExplosionWarehouses(tx, input);
  const { warehouseCode, toWarehouseCode, kitchenWarehouseCode, barWarehouseCode } = warehouses;
  const rangeEnd = new Date(dateTo);
  rangeEnd.setHours(23, 59, 59, 999);
  const pendingRows = await tx.revenueImportRow.findMany({
    where: {
      inventoryStatus: "PENDING",
      productCode: { not: null },
      productQuantity: { gt: 0 },
      branchCode,
      // Rã lại một lần rã cũ: đúng các dòng doanh thu của lần đó, không quét lại khoảng ngày
      // (quét lại sẽ kéo cả dòng mới import sau vào lần rã cũ).
      ...(input.rowIds ? { id: { in: input.rowIds } } : { saleDate: { gte: dateFrom, lte: rangeEnd } }),
      deletedAt: null,
    },
  });
  if (pendingRows.length === 0) return { kind: "EMPTY" as const };

  // Phụ thu / dịch vụ không rút gì khỏi kho: loại khỏi lần rã này rồi thả hẳn khỏi hàng chờ,
  // nếu không nút Rã sẽ chết vì "không tìm thấy mặt hàng" hoặc xuất bán thẳng làm tồn âm.
  const nonInventoryGroups = await loadNonInventoryRevenueGroups(tx as unknown as CategoryLookupClient);
  const skippedRows = pendingRows.filter((row) => !tracksInventory(row.revenueSource, nonInventoryGroups));
  const inventoryRows = pendingRows.filter((row) => tracksInventory(row.revenueSource, nonInventoryGroups));
  if (inventoryRows.length === 0) {
    await tx.revenueImportRow.updateMany({
      where: { id: { in: skippedRows.map((row) => row.id) } },
      data: { inventoryStatus: "NOT_REQUIRED" },
    });
    return { kind: "ALL_SKIPPED" as const, skippedRows: skippedRows.length };
  }

  const recipeVersions = await tx.recipe.findMany({
    where: { deletedAt: null },
    include: { lines: { include: { item: true } } },
  });
  const plan = explodeSalesDemand({
    demands: inventoryRows.map((row) => ({ productCode: row.productCode || "", quantity: row.productQuantity || 0 })),
    recipes: recipeVersions as unknown as ExplosionRecipe[],
    date: dateTo,
    // Rã theo công thức của đúng cửa hàng này; nơi chưa khai riêng thì ăn bản dùng chung.
    branchCode,
  });

  // Mã món có mặt trong lần rã: cả món bán lẫn bán thành phẩm trung gian.
  const planProductCodes = [
    ...plan.productions.map((step) => step.productCode),
    // Thành phần của combo trừ ở kho của chính nó nên cũng phải suy được bộ phận.
    ...plan.productions.flatMap((step) => step.components.map((component) => component.item.code)),
    ...plan.producedSales.map((sale) => sale.productCode),
    ...plan.directSales.map((sale) => sale.productCode),
  ];
  // prisma ở đây đã gắn extension xoá mềm nên kiểu không khớp TransactionClient thuần,
  // giống cách các chỗ khác gọi resolver này.
  const resolveDepartment = await buildRevenueDepartmentResolver(
    tx as unknown as Prisma.TransactionClient,
    planProductCodes,
  );
  // Nhóm doanh thu ghi trên chính dòng POS: món chưa gán nhóm trong danh mục vẫn suy được
  // bếp/bar nếu file POS có khai.
  const revenueSourceByProduct = new Map<string, string | null>();
  for (const row of inventoryRows) {
    const code = (row.productCode || "").toUpperCase();
    if (code && !revenueSourceByProduct.has(code)) revenueSourceByProduct.set(code, row.revenueSource);
  }
  // Nhóm doanh thu khai sẵn trên danh mục mặt hàng: dùng khi dòng POS không nói được gì.
  const itemRevenueGroups = await tx.inventoryItem.findMany({
    where: { code: { in: [...new Set(planProductCodes.map((code) => code.toUpperCase()))] } },
    select: { code: true, revenueGroup: true },
  });
  const revenueGroupByItem = new Map(itemRevenueGroups.map((item) => [item.code.toUpperCase(), item.revenueGroup]));
  const undecidedProducts = new Set<string>();
  /**
   * Kho của một món theo bộ phận; không suy được bộ phận thì trả null để dùng kho mặc định.
   *
   * Xét NHÓM DOANH THU trước (đúng câu khách nói: đồ ăn về bếp, đồ uống về bar), chỉ khi
   * món không có nhóm doanh thu mới rơi về Phân nhóm mặt hàng. Ngược thứ tự thì món cà phê
   * lỡ gán phân nhóm "Món Bếp" sẽ bị trừ kho Bếp dù nhóm doanh thu là Đồ uống.
   */
  const departmentOfProduct = (productCode: string) => {
    const code = (productCode || "").toUpperCase();
    const revenueSource = revenueSourceByProduct.get(code) || revenueGroupByItem.get(code) || null;
    return resolveDepartment({ revenueSource }) || resolveDepartment({ productCode: code });
  };
  const departmentWarehouseOf = (productCode: string) => {
    const code = (productCode || "").toUpperCase();
    const department = departmentOfProduct(code);
    if (department === REVENUE_DEPARTMENT_CODES.KITCHEN && kitchenWarehouseCode) return kitchenWarehouseCode;
    if (department === REVENUE_DEPARTMENT_CODES.BAR && barWarehouseCode) return barWarehouseCode;
    if (!department && (kitchenWarehouseCode || barWarehouseCode)) undecidedProducts.add(code);
    return null;
  };

  /**
   * Bán thành phẩm đi theo kho của MÓN BÁN dùng nó (khách chốt 27/09/2026): rã riêng từng bộ
   * phận của món bán — xem explodeSalesDemandByDepartment. Nhóm bếp / bar thì MỌI bước chế biến
   * (kể cả BTP) và xuất bán đều ở kho bếp / bar; chỉ nhóm món chưa suy được bộ phận mới đoán kho
   * theo từng bước rồi rơi về kho mặc định như cũ. Trước đây BTP tự suy kho theo chính nó, không
   * có nhóm doanh thu nên rơi hết về "Kho xuất NVL" mặc định (Kho văn phòng).
   */
  const soldDepartmentOf = (productCode: string) => {
    const department = departmentOfProduct(productCode);
    if (department === REVENUE_DEPARTMENT_CODES.KITCHEN && kitchenWarehouseCode) return department;
    if (department === REVENUE_DEPARTMENT_CODES.BAR && barWarehouseCode) return department;
    return null;
  };
  // Combo nhập kho / xuất bán ở kho BẾP, từng thành phần trừ ở kho của chính nó (khách chốt
  // 27/09/2026) — xem explodeSalesDemandWithDepartments.
  const departmentPlan = explodeSalesDemandWithDepartments({
    demands: inventoryRows.map((row) => ({ productCode: row.productCode || "", quantity: row.productQuantity || 0 })),
    recipes: recipeVersions as unknown as ExplosionRecipe[],
    date: dateTo,
    branchCode,
  }, {
    departmentOf: soldDepartmentOf,
    comboDepartment: kitchenWarehouseCode ? REVENUE_DEPARTMENT_CODES.KITCHEN : null,
  });
  const groupWarehouseOf = (department: string | null) => (department === REVENUE_DEPARTMENT_CODES.KITCHEN
    ? kitchenWarehouseCode
    : department === REVENUE_DEPARTMENT_CODES.BAR ? barWarehouseCode : null);

  const result = await (async () => {
    const runCode = await nextStockDocCode(tx, "RA", dateTo);
    const documents = [];
    let sequence = 0;
    // 1) Chế biến từng cấp theo đúng thứ tự BTP → TP → combo. Mỗi bước nhập thành phẩm vào kho
    //    theo bộ phận của bước; nguyên liệu trừ ở kho theo bộ phận của TỪNG nguyên liệu (combo có
    //    thành phần ở nhiều kho) — mỗi kho một phiếu xuất chế biến.
    for (const step of departmentPlan.productions) {
      sequence += 1;
      const productItem = await tx.inventoryItem.findUnique({ where: { code: step.productCode } });
      if (!productItem) businessError(`Không tìm thấy sản phẩm ${step.productCode}`);
      // Chưa suy được bộ phận thì đoán theo chính sản phẩm như cũ, rồi rơi về kho mặc định.
      const stepWarehouse = groupWarehouseOf(step.department) || departmentWarehouseOf(step.productCode);
      const issueGroups = new Map<string, typeof step.components>();
      for (const component of step.components) {
        const warehouse = groupWarehouseOf(component.department) || stepWarehouse || warehouseCode;
        issueGroups.set(warehouse, [...(issueGroups.get(warehouse) || []), component]);
      }
      let totalCost = 0;
      let issueIndex = 0;
      for (const [warehouse, components] of issueGroups) {
        issueIndex += 1;
        const issue = await postInventoryTransaction(tx, {
          code: `${runCode}-${sequence}X${issueIndex > 1 ? issueIndex : ""}`,
          transactionType: "XUAT_CHE_BIEN",
          transactionDate: dateTo,
          branchCode,
          warehouseCode: warehouse,
          referenceType: "PRODUCTION",
          referenceCode: runCode,
          note: `Rã nguyên liệu ${step.productCode} (${input.note || "theo doanh thu"})`,
          createdBy: input.createdBy,
          lines: components.map((component) => ({
            itemId: component.item.id,
            inputQuantity: component.quantityBase,
            inputUnitCode: "",
            inputUnitCost: 0,
          })),
        });
        totalCost += issue.lines.reduce((sum, line) => sum + line.totalCost, 0);
        documents.push(issue);
      }
      const receipt = await postInventoryTransaction(tx, {
        code: `${runCode}-${sequence}N`,
        transactionType: "NHAP_CHE_BIEN",
        transactionDate: dateTo,
        branchCode,
        warehouseCode: stepWarehouse || toWarehouseCode,
        referenceType: "PRODUCTION",
        referenceCode: runCode,
        note: `Nhập chế biến ${step.productCode} từ rã nguyên liệu`,
        createdBy: input.createdBy,
        lines: [{
          itemId: productItem?.id || "",
          inputQuantity: step.quantityBase,
          inputUnitCode: productItem?.unit || "",
          inputUnitCost: step.quantityBase > 0 ? totalCost / step.quantityBase : 0,
        }],
      });
      documents.push(receipt);
    }
    // 2) Xuất bán: sản phẩm vừa chế biến xuất từ kho nhập chế biến, hàng bán thẳng
    //    (không định lượng) xuất từ kho nguyên liệu.
    // Món chế biến xuất bán từ đúng kho vừa nhập vào, hàng bán thẳng xuất từ kho nguyên
    // liệu của bộ phận bán món đó — nên phải gom lại theo KHO THỰC TẾ, không phải hai nhóm
    // cố định như trước.
    const saleGroupMap = new Map<string, { warehouse: string; sales: typeof plan.producedSales; label: string }>();
    const pushSale = (sale: typeof plan.producedSales[number], warehouse: string, label: string) => {
      const key = `${warehouse}|${label}`;
      const group = saleGroupMap.get(key) || { warehouse, sales: [], label };
      group.sales.push(sale);
      saleGroupMap.set(key, group);
    };
    for (const sale of departmentPlan.producedSales) pushSale(sale, groupWarehouseOf(sale.department) || departmentWarehouseOf(sale.productCode) || toWarehouseCode, "chế biến");
    for (const sale of departmentPlan.directSales) pushSale(sale, groupWarehouseOf(sale.department) || departmentWarehouseOf(sale.productCode) || warehouseCode, "bán thẳng");
    const saleGroups = [...saleGroupMap.values()];
    for (const group of saleGroups) {
      if (group.sales.length === 0) continue;
      const lines = [];
      for (const sale of group.sales) {
        const item = await tx.inventoryItem.findUnique({ where: { code: sale.productCode } });
        if (!item) businessError(`Không tìm thấy mặt hàng ${sale.productCode} để xuất bán`);
        lines.push({ itemId: item?.id || "", inputQuantity: sale.quantityBase, inputUnitCode: item?.unit || "", inputUnitCost: 0 });
      }
      sequence += 1;
      documents.push(await postInventoryTransaction(tx, {
        code: `${runCode}-${sequence}XB`,
        transactionType: "XUAT_BAN",
        transactionDate: dateTo,
        branchCode,
        warehouseCode: group.warehouse,
        referenceType: "PRODUCTION",
        referenceCode: runCode,
        note: `Xuất bán theo rã nguyên liệu ${runCode} (${group.label})`,
        createdBy: input.createdBy,
        lines,
      }));
    }
    // 3) Đánh dấu các dòng doanh thu đã rã kèm mã lần rã, để hoàn tác được cả cụm
    //    (REVERT_EXPLOSION) và không rã trùng lần sau.
    await tx.revenueImportRow.updateMany({
      where: { id: { in: inventoryRows.map((row) => row.id) } },
      data: { inventoryStatus: `POSTED:${runCode}` },
    });
    // Dòng không theo dõi tồn kho thì thả hẳn, KHÔNG gắn mã lần rã: hoàn tác lần rã này
    // cũng không được đẩy chúng trở lại hàng chờ.
    if (skippedRows.length > 0) {
      await tx.revenueImportRow.updateMany({
        where: { id: { in: skippedRows.map((row) => row.id) } },
        data: { inventoryStatus: "NOT_REQUIRED" },
      });
    }
    return { runCode, documents };
  })();

  /**
   * Rã xong vẫn phải nói thẳng hai thứ luật xuất âm để lại, nếu không kế toán tưởng đã xong:
   *   - mã bị xuất âm: tồn đang nợ đúng bằng số âm, chờ khai tồn đầu kỳ / nhập mua bù;
   *   - mã xuất với giá vốn 0: kho chưa có giá nào để lấy, nên phiếu xuất ghi 0 đồng —
   *     báo cáo giá vốn thiếu đúng phần này cho tới khi có giá rồi tính lại.
   */
  const issuedLines = result.documents
    .filter((doc) => doc.transactionType.startsWith("XUAT_"))
    .flatMap((doc) => doc.lines);
  const zeroCostItems = [...new Set(issuedLines.filter((line) => (line.unitCost || 0) <= 0).map((line) => line.item.code))];
  const negativeBalances = issuedLines.length === 0 ? [] : await tx.inventoryBalance.findMany({
    where: {
      itemId: { in: [...new Set(issuedLines.map((line) => line.itemId))] },
      warehouseCode: { in: [...new Set(result.documents.map((doc) => doc.warehouseCode))] },
      quantity: { lt: -quantityEpsilon },
    },
    include: { item: { select: { code: true } } },
  });
  const negativeItems = negativeBalances.map((balance) => ({
    itemCode: balance.item.code,
    warehouseCode: balance.warehouseCode,
    quantity: balance.quantity,
  }));

  return {
    kind: "POSTED" as const,
    runCode: result.runCode,
    /** Kho thực dùng (sau resolveExplosionWarehouses) — ghi vào nhật ký lần rã. */
    warehouses,
    documents: result.documents,
    plan,
    revenueRows: inventoryRows.length,
    skippedRows: skippedRows.length,
    undecidedProducts: [...undecidedProducts],
    negativeItems,
    zeroCostItems,
  };
}


/** Kho + khoảng ngày của lần rã gốc: đọc từ nhật ký lúc rã; thiếu nhật ký thì suy từ phiếu. */
export async function explosionRunSettings(
  tx: TxClient,
  run: AffectedExplosionRun,
  documents: Array<{ warehouseCode: string }>,
) {
  const log = await tx.auditLog.findFirst({
    where: { action: "EXPLODE_PRODUCTION", entityCode: run.runCode, status: "SUCCESS" },
    orderBy: { occurredAt: "desc" },
  });
  let meta: Record<string, unknown> = {};
  try {
    meta = log?.metadataJson ? JSON.parse(log.metadataJson) as Record<string, unknown> : {};
  } catch {
    meta = {};
  }
  // Không có nhật ký: kho xuất hiện nhiều nhất trên các phiếu của lần rã làm kho mặc định.
  const counts = new Map<string, number>();
  for (const doc of documents) counts.set(doc.warehouseCode, (counts.get(doc.warehouseCode) || 0) + 1);
  const fallbackWarehouse = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  const warehouseCode = cleanText(meta.warehouseCode) || fallbackWarehouse;
  return {
    warehouseCode,
    toWarehouseCode: cleanText(meta.toWarehouseCode) || warehouseCode,
    kitchenWarehouseCode: cleanText(meta.kitchenWarehouseCode),
    barWarehouseCode: cleanText(meta.barWarehouseCode),
    dateFrom: meta.dateFrom ? new Date(String(meta.dateFrom)) : run.date,
  };
}

/**
 * Rã lại các lần rã bị ảnh hưởng theo định lượng mới — đúng câu chị Bình chốt: "mọi thứ sửa và
 * làm lại được, chạy lại lịch sử thay vì tính ngược từng bước".
 *
 *   1. Gỡ hết các lần rã cũ trước (mới nhất trước): hoàn kho từng phiếu bằng reverseStockEffect
 *      (trừ ngược đúng số lượng + giá trị đã ghi, nên gỡ phiếu giữa kỳ vẫn khớp), xoá mềm phiếu,
 *      trả các dòng doanh thu về hàng chờ.
 *   2. Rã lại theo thứ tự thời gian, đúng các dòng doanh thu + kho + ngày chứng từ của lần gốc.
 *      Mã lần rã mới là mã mới (mã cũ còn nằm trong Thùng rác, ràng buộc unique tính cả nó).
 *
 * Chạy trong transaction của người gọi: lỗi ở bất kỳ lần rã nào thì cả thao tác sửa định lượng
 * huỷ theo, không bao giờ để lại cảnh đã gỡ mà chưa rã lại.
 */
export type ExplosionRunSettings = Awaited<ReturnType<typeof explosionRunSettings>>;

export async function rerunExplosions(
  tx: TxClient,
  runs: AffectedExplosionRun[],
  createdBy: string,
  options: {
    /** Đổi kho khi rã lại (lần rã cũ chọn sai kho / chưa có kho bếp-bar). Mặc định giữ kho gốc. */
    overrideSettings?: (run: AffectedExplosionRun, settings: ExplosionRunSettings) => ExplosionRunSettings;
    note?: (run: AffectedExplosionRun) => string;
  } = {},
) {
  const reverted: Array<{ run: AffectedExplosionRun; rowIds: string[]; settings: Awaited<ReturnType<typeof explosionRunSettings>> }> = [];
  for (const run of [...runs].reverse()) {
    const documents = await tx.inventoryTransaction.findMany({
      where: { referenceType: "PRODUCTION", referenceCode: run.runCode, deletedAt: null },
      include: { lines: true },
      orderBy: { createdAt: "desc" },
    });
    const original = await explosionRunSettings(tx, run, documents);
    const settings = options.overrideSettings ? options.overrideSettings(run, original) : original;
    for (const doc of documents) {
      await reverseStockEffect(tx, doc);
      await tx.inventoryTransaction.update({ where: { id: doc.id }, data: { deletedAt: new Date(), deletedBy: createdBy } });
    }
    const rows = await tx.revenueImportRow.findMany({ where: { inventoryStatus: `POSTED:${run.runCode}` }, select: { id: true } });
    const rowIds = rows.map((row) => row.id);
    if (rowIds.length > 0) {
      await tx.revenueImportRow.updateMany({ where: { id: { in: rowIds } }, data: { inventoryStatus: "PENDING" } });
    }
    reverted.push({ run, rowIds, settings });
  }

  const results: Array<{
    oldRunCode: string;
    newRunCode: string | null;
    branchCode: string;
    date: Date;
    settings: Awaited<ReturnType<typeof explosionRunSettings>>;
    documents: string[];
  }> = [];
  for (const { run, rowIds, settings } of reverted.reverse()) {
    if (rowIds.length === 0) {
      // Lần rã không còn dòng doanh thu nào (doanh thu đã bị xoá): gỡ xong là đúng, không rã lại.
      results.push({ oldRunCode: run.runCode, newRunCode: null, branchCode: run.branchCode, date: run.date, settings, documents: [] });
      continue;
    }
    const outcome = await executeExplosion(tx, {
      ...settings,
      branchCode: run.branchCode,
      dateTo: run.date,
      rowIds,
      note: options.note ? options.note(run) : `rã lại ${run.runCode} theo định lượng mới`,
      createdBy,
    });
    results.push({
      oldRunCode: run.runCode,
      newRunCode: outcome.kind === "POSTED" ? outcome.runCode : null,
      branchCode: run.branchCode,
      date: run.date,
      // Kho THỰC dùng (đã qua resolveExplosionWarehouses) để nhật ký lần rã mới ghi đúng kho.
      settings: outcome.kind === "POSTED" ? { ...settings, ...outcome.warehouses } : settings,
      documents: outcome.kind === "POSTED" ? outcome.documents.map((doc) => doc.code) : [],
    });
  }
  return results;
}

