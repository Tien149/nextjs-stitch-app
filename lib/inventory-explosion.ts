/**
 * Rã nguyên liệu theo doanh thu (phần có chạm DB) — tách khỏi app/api/inventory/route.ts để script
 * sửa dữ liệu trên server (scripts/rerun-explosions.mjs) dùng lại đúng logic của nút Rã / rã lại,
 * không phải viết lại. Phần tính thuần nằm ở lib/production-explosion.ts.
 */
import { Prisma } from "@prisma/custom-client";
import type { TxClient } from "@/lib/prisma";
import { businessError, cleanText, isPeriodLocked } from "@/lib/phase3";
import { nextStockDocCode, postInventoryTransaction, repostInventoryTransaction, reverseStockEffect } from "@/lib/inventory-stock";
import { syncTransferInternalDebt } from "@/lib/inventory-transfer";
import { explosionPostedStatus, loadPendingExplosionSources, releaseExplosionSources } from "@/lib/explosion-sources";
import { explodeSalesDemand, explodeSalesDemandWithDepartments, type ExplosionRecipe } from "@/lib/production-explosion";
import { loadNonInventoryRevenueGroups, tracksInventory, type CategoryLookupClient } from "@/lib/revenue-source";
import { buildRevenueDepartmentResolver, departmentFromWarehouseGroup, REVENUE_DEPARTMENT_CODES } from "@/lib/revenue-department";
import { explosionPostingDate, saleDayStart } from "@/lib/revenue-date";

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
  /**
   * Rã TỚI GIỜ (1–23, giờ Việt Nam) của ngày cuối: chỉ lấy doanh thu ngày đó có giờ bán nhỏ hơn,
   * phiếu mang đúng giờ đó (kiểm kê chốt theo giờ — lib/stocktake-batch.ts). Trống = cả ngày.
   */
  timeTo?: number | null;
  /** Rã lại một lần rã cũ: giữ nguyên ngày giờ phiếu của lần gốc. */
  postingDate?: Date;
  /** Rã lại một lần rã cũ: chỉ lấy đúng các dòng doanh thu này. */
  rowIds?: string[];
  /** Rã lại một lần rã cũ: đúng các phiếu điều chuyển / kiểm kê của lần đó (đi cùng rowIds). */
  transferIds?: string[];
  stocktakeIds?: string[];
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

/**
 * Điều chuyển bán thành phẩm vừa được rã: định giá lại theo luật đơn giá điều chuyển (BTP = bình
 * quân nhập chế biến trong tháng — giờ đã có phiếu chế biến của chính số chuyển đi), rồi đồng bộ
 * công nợ nội bộ theo trị giá mới. Công nợ nội bộ đã gạch thì giữ giá cũ, không chặn cả lần rã.
 */
async function repriceTransfer(tx: TxClient, transactionId: string) {
  const transfer = await tx.inventoryTransaction.findUnique({ where: { id: transactionId }, include: { lines: true } });
  if (!transfer) return { code: transactionId, repriced: false };
  // Định giá lại đổi cả giá trị kho bên nhận: kỳ của cửa hàng nhận đã khoá thì giữ giá cũ.
  if (transfer.toBranchCode && await isPeriodLocked(transfer.transactionDate, transfer.toBranchCode)) {
    return { code: transfer.code, repriced: false };
  }
  const debtCodes = [transfer.internalReceivableDebtCode, transfer.internalPayableDebtCode].filter((code): code is string => !!code);
  if (debtCodes.length > 0) {
    const settled = await tx.debtRecord.count({ where: { code: { in: debtCodes }, deletedAt: null, settlements: { some: {} } } });
    if (settled > 0) return { code: transfer.code, repriced: false };
  }
  await repostInventoryTransaction(tx, transfer, {
    transactionDate: transfer.transactionDate,
    branchCode: transfer.branchCode,
    warehouseCode: transfer.warehouseCode,
    toWarehouseCode: transfer.toWarehouseCode,
    toBranchCode: transfer.toBranchCode,
    subType: transfer.subType,
    partnerCode: transfer.partnerCode,
    referenceCode: transfer.referenceCode,
    note: transfer.note,
    lines: transfer.lines.map((line) => ({
      itemId: line.itemId,
      inputQuantity: line.inputQuantity ?? line.quantity,
      inputUnitCode: line.inputUnitCode ?? "",
      inputUnitCost: line.inputUnitCost ?? line.unitCost,
    })),
  });
  await syncTransferInternalDebt(tx, transfer.id);
  return { code: transfer.code, repriced: true };
}

export async function executeExplosion(tx: TxClient, input: ExplosionRunInput) {
  const { branchCode, dateFrom, dateTo } = input;
  const warehouses = await resolveExplosionWarehouses(tx, input);
  const { warehouseCode, toWarehouseCode, kitchenWarehouseCode, barWarehouseCode } = warehouses;
  const rangeEnd = new Date(dateTo);
  rangeEnd.setHours(23, 59, 59, 999);
  const timeTo = input.rowIds ? null : input.timeTo ?? null;
  const postedAt = input.postingDate || explosionPostingDate(dateTo, timeTo);
  const lastDay = saleDayStart(dateTo);
  /**
   * Rã tới giờ: các ngày trước lấy trọn, ngày cuối chỉ lấy dòng có giờ bán < giờ chọn. Dòng ngày
   * cuối không có giờ (file POS chỉ ghi ngày) không chia được nên để lại hàng chờ.
   */
  const dateScope = timeTo === null
    ? { saleDate: { gte: dateFrom, lte: rangeEnd } }
    : { OR: [
      { saleDate: { gte: dateFrom, lt: lastDay } },
      { saleDate: { gte: lastDay, lte: rangeEnd }, saleHour: { lt: timeTo } },
    ] };
  const pendingRows = await tx.revenueImportRow.findMany({
    where: {
      inventoryStatus: "PENDING",
      productCode: { not: null },
      productQuantity: { gt: 0 },
      branchCode,
      // Rã lại một lần rã cũ: đúng các dòng doanh thu của lần đó, không quét lại khoảng ngày
      // (quét lại sẽ kéo cả dòng mới import sau vào lần rã cũ).
      ...(input.rowIds ? { id: { in: input.rowIds } } : dateScope),
      deletedAt: null,
    },
  });
  // Dòng ngày cuối không có giờ bán nên không vào lần rã tới giờ — báo lại cho người dùng.
  const unsplitRows = timeTo === null ? 0 : await tx.revenueImportRow.count({
    where: { inventoryStatus: "PENDING", productCode: { not: null }, branchCode, deletedAt: null, saleDate: { gte: lastDay, lte: rangeEnd }, saleHour: null },
  });
  // Điều chuyển bán thành phẩm + kiểm dư bán thành phẩm đang chờ rã (khách chốt 28/09/2026).
  const sources = await loadPendingExplosionSources(tx, {
    branchCode,
    dateFrom,
    rangeEnd,
    ids: input.rowIds ? { transferIds: input.transferIds || [], stocktakeIds: input.stocktakeIds || [] } : undefined,
  });
  if (pendingRows.length === 0 && sources.length === 0) return { kind: "EMPTY" as const };

  // Phụ thu / dịch vụ không rút gì khỏi kho: loại khỏi lần rã này rồi thả hẳn khỏi hàng chờ,
  // nếu không nút Rã sẽ chết vì "không tìm thấy mặt hàng" hoặc xuất bán thẳng làm tồn âm.
  const nonInventoryGroups = await loadNonInventoryRevenueGroups(tx as unknown as CategoryLookupClient);
  const skippedRows = pendingRows.filter((row) => !tracksInventory(row.revenueSource, nonInventoryGroups));
  const inventoryRows = pendingRows.filter((row) => tracksInventory(row.revenueSource, nonInventoryGroups));
  if (inventoryRows.length === 0 && sources.length === 0) {
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
    const repricedTransfers: Array<{ code: string; repriced: boolean }> = [];
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
          transactionDate: postedAt,
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
        transactionDate: postedAt,
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
        transactionDate: postedAt,
        branchCode,
        warehouseCode: group.warehouse,
        referenceType: "PRODUCTION",
        referenceCode: runCode,
        note: `Xuất bán theo rã nguyên liệu ${runCode} (${group.label})`,
        createdBy: input.createdBy,
        lines,
      }));
    }
    // 3) Điều chuyển / kiểm dư bán thành phẩm: chế biến ngay tại KHO của phiếu (kho xuất của
    //    điều chuyển, kho được kiểm) vào đúng NGÀY phiếu — hàng nằm ở đâu thì nguyên liệu trừ ở
    //    đó. Không xuất bán: điều chuyển đã đưa hàng đi, còn kiểm kê là hàng đang nằm trong kho.
    for (const source of sources) {
      const label = source.kind === "TRANSFER" ? `điều chuyển ${source.code}` : `kiểm dư ${source.code}`;
      const sourcePlan = explodeSalesDemand({
        demands: source.demands,
        recipes: recipeVersions as unknown as ExplosionRecipe[],
        date: source.date,
        branchCode,
      });
      for (const step of sourcePlan.productions) {
        sequence += 1;
        const productItem = await tx.inventoryItem.findUnique({ where: { code: step.productCode } });
        if (!productItem) businessError(`Không tìm thấy sản phẩm ${step.productCode}`);
        const issue = await postInventoryTransaction(tx, {
          code: `${runCode}-${sequence}X`,
          transactionType: "XUAT_CHE_BIEN",
          transactionDate: source.date,
          branchCode,
          warehouseCode: source.warehouseCode,
          referenceType: "PRODUCTION",
          referenceCode: runCode,
          note: `Rã nguyên liệu ${step.productCode} cho ${label}`,
          createdBy: input.createdBy,
          lines: step.components.map((component) => ({
            itemId: component.item.id,
            inputQuantity: component.quantityBase,
            inputUnitCode: "",
            inputUnitCost: 0,
          })),
        });
        documents.push(issue);
        const totalCost = issue.lines.reduce((sum, line) => sum + line.totalCost, 0);
        documents.push(await postInventoryTransaction(tx, {
          code: `${runCode}-${sequence}N`,
          transactionType: "NHAP_CHE_BIEN",
          transactionDate: source.date,
          branchCode,
          warehouseCode: source.warehouseCode,
          referenceType: "PRODUCTION",
          referenceCode: runCode,
          note: `Nhập chế biến ${step.productCode} cho ${label}`,
          createdBy: input.createdBy,
          lines: [{
            itemId: productItem?.id || "",
            inputQuantity: step.quantityBase,
            inputUnitCode: productItem?.unit || "",
            inputUnitCost: step.quantityBase > 0 ? totalCost / step.quantityBase : 0,
          }],
        }));
      }
      // Kiểm dư mà định lượng đã bị gỡ sau lúc duyệt: không rã được thì vẫn phải lên kho, nhập
      // kiểm kê theo giá bình quân đang có (thuộc lần rã nên hoàn tác đi theo cả cụm).
      if (source.kind === "STOCKTAKE" && sourcePlan.directSales.length > 0) {
        const lines = [];
        for (const sale of sourcePlan.directSales) {
          const item = await tx.inventoryItem.findUnique({ where: { code: sale.productCode } });
          if (!item) businessError(`Không tìm thấy mặt hàng ${sale.productCode}`);
          lines.push({ itemId: item?.id || "", inputQuantity: sale.quantityBase, inputUnitCode: item?.unit || "", inputUnitCost: 0 });
        }
        sequence += 1;
        documents.push(await postInventoryTransaction(tx, {
          code: `${runCode}-${sequence}NK`,
          transactionType: "NHAP_KIEM_KE",
          transactionDate: source.date,
          branchCode,
          warehouseCode: source.warehouseCode,
          referenceType: "PRODUCTION",
          referenceCode: runCode,
          note: `Kiểm dư ${source.code} không còn định lượng để rã`,
          createdBy: input.createdBy,
          lines,
        }));
      }
      if (source.kind === "TRANSFER") {
        await tx.inventoryTransaction.update({ where: { id: source.id }, data: { explosionStatus: explosionPostedStatus(runCode) } });
        if (sourcePlan.productions.length > 0) repricedTransfers.push(await repriceTransfer(tx, source.id));
      } else {
        await tx.stocktakeSession.update({ where: { id: source.id }, data: { explosionStatus: explosionPostedStatus(runCode) } });
      }
    }
    // 4) Đánh dấu các dòng doanh thu đã rã kèm mã lần rã, để hoàn tác được cả cụm
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
    return { runCode, documents, repricedTransfers };
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
    /** Ngày giờ phiếu của lần rã (tới giờ chọn, hoặc 23:59:59 ngày cuối). */
    postedAt,
    unsplitRows,
    /** Kho thực dùng (sau resolveExplosionWarehouses) — ghi vào nhật ký lần rã. */
    warehouses,
    documents: result.documents,
    plan,
    revenueRows: inventoryRows.length,
    skippedRows: skippedRows.length,
    sources: sources.map((source) => ({ kind: source.kind, code: source.code, date: source.date, warehouseCode: source.warehouseCode })),
    /** Điều chuyển không định giá lại được vì công nợ nội bộ đã gạch — giữ giá cũ. */
    keptPriceTransfers: result.repricedTransfers.filter((row) => !row.repriced).map((row) => row.code),
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
  const reverted: Array<{
    run: AffectedExplosionRun;
    rowIds: string[];
    sources: { transferIds: string[]; stocktakeIds: string[] };
    settings: Awaited<ReturnType<typeof explosionRunSettings>>;
  }> = [];
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
    // Điều chuyển / kiểm kê của lần rã cũng về hàng chờ để rã lại đúng chúng.
    const sources = await releaseExplosionSources(tx, run.runCode);
    reverted.push({ run, rowIds, sources, settings });
  }

  const results: Array<{
    oldRunCode: string;
    newRunCode: string | null;
    branchCode: string;
    date: Date;
    settings: Awaited<ReturnType<typeof explosionRunSettings>>;
    documents: string[];
  }> = [];
  for (const { run, rowIds, sources, settings } of reverted.reverse()) {
    if (rowIds.length === 0 && sources.transferIds.length === 0 && sources.stocktakeIds.length === 0) {
      // Lần rã không còn dòng doanh thu / phiếu nào (đã bị xoá): gỡ xong là đúng, không rã lại.
      results.push({ oldRunCode: run.runCode, newRunCode: null, branchCode: run.branchCode, date: run.date, settings, documents: [] });
      continue;
    }
    const outcome = await executeExplosion(tx, {
      ...settings,
      branchCode: run.branchCode,
      dateTo: run.date,
      // Giữ nguyên ngày giờ phiếu của lần gốc (rã tới giờ / cả ngày / phiếu cũ 07:00).
      postingDate: run.date,
      rowIds,
      transferIds: sources.transferIds,
      stocktakeIds: sources.stocktakeIds,
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

