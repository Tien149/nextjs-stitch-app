/**
 * Nhận hàng PO (RECEIVE_ORDER / RECEIVE_ORDERS ở app/api/procurement): kiểm số nhận, đơn giá, thuế,
 * chiết khấu, dòng thêm, nhóm tài sản ở `prepareOrderReceive`; ghi phiếu NM, dòng PO, tài sản/CCDC,
 * công nợ NCC và bản ghi lần nhận ở `postOrderReceive`. Form Nhập kho nhận GỘP nhiều PO của cùng NCC
 * (khách 27/10/2026): mỗi PO vẫn chạy trọn hai bước này, chung một transaction.
 */
import type { DemoSession } from "@/lib/auth-demo";
import { assertBranchAccess } from "@/lib/accounting";
import { resolveAssetGroupForReceive } from "@/lib/asset-group-rules";
import { nextAssetCode } from "@/lib/asset-code-generator";
import { postInventoryTransaction, nextStockDocCode } from "@/lib/inventory-stock";
import { parseVatRate } from "@/lib/inventory-vat";
import { businessError, cleanText, isPeriodLocked, toNumber } from "@/lib/phase3";
import { prisma, type TxClient } from "@/lib/prisma";
import { purchaseLineFigures, resolveDiscount } from "@/lib/purchase-discount";
import { purchaseLineAmount } from "@/lib/purchase-payable";
import { syncRequestCompletion } from "@/lib/purchase-request-open-lines";
import { conversionRateForUnit, defaultPurchaseUnit, purchaseUnitOptions, receiveUnitFor } from "@/lib/unit-conversion";
import { assertWarehouseAccess } from "@/lib/warehouse-scope";

/**
 * Chia chi phí mua hàng của lượt nhận gộp cho từng PO theo tiền hàng nhập kho của PO (`weights`);
 * PO có trọng số cuối cùng nhận phần lẻ để tổng khớp đúng số khai. Tổng trọng số 0 thì trả toàn 0.
 */
export function allocateReceivePurchaseCost(weights: number[], purchaseCost: number) {
  const total = weights.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (!(purchaseCost > 0) || total <= 0) return weights.map(() => 0);
  const last = weights.reduce((found, value, index) => (value > 0 ? index : found), -1);
  let allocated = 0;
  return weights.map((value, index) => {
    if (value <= 0) return 0;
    const share = index === last ? purchaseCost - allocated : Math.round((purchaseCost * value) / total);
    allocated += share;
    return share;
  });
}

/** Phần chung của một dòng PO tạo mới lúc nhận hàng (dòng thêm ngay trên phiếu nhận). */
function receiveLineTemplate(orderId: string) {
  return { orderId, receivedQuantity: 0, imageUrl: null as string | null, requestLineId: null as string | null };
}

/**
 * Đọc + kiểm một lần nhận PO trước khi vào transaction (số nhận theo dòng, dòng thêm, đơn giá, thuế,
 * chiết khấu, nhóm tài sản). Tách riêng để form Nhập kho nhận GỘP nhiều PO của cùng NCC một lượt
 * (khách 27/10/2026) — mỗi PO vẫn một phiếu NM, một khoản công nợ, một lần nhận để Huỷ lần nhận.
 * `purchaseCost` do nơi gọi điền (chi phí mua hàng chia theo tiền hàng các PO).
 */
export async function prepareOrderReceive(session: DemoSession, input: Record<string, unknown>, receivedDate: Date) {
  const orderId = cleanText(input.orderId);
  const order = await prisma.purchaseOrder.findUnique({
    where: { id: orderId },
    include: { lines: { include: { item: { include: { unitConversions: { where: { deletedAt: null } } } } } } },
  });
  if (!order) businessError("Không tìm thấy PO");
  assertBranchAccess(session, order.branchCode);
  assertWarehouseAccess(session, order.warehouseCode);
  if (!["APPROVED", "PARTIALLY_RECEIVED"].includes(order.status)) businessError("PO không ở trạng thái có thể nhận hàng");
  if (await isPeriodLocked(receivedDate, order.branchCode)) businessError("Kỳ kế toán đã khóa");

  /**
   * Khớp số lượng nhận theo ID DÒNG PO, không theo mặt hàng: một PO có thể có hai dòng cùng
   * mặt hàng (hai mức giá), khớp theo itemId là cả hai dòng cùng nhận -> tồn kho và công nợ
   * gấp đôi. Dòng người dùng cố tình để 0 (giao thiếu) phải hiểu là KHÔNG nhận, chứ không
   * được rơi vào nhánh mặc định "nhận hết phần còn lại".
   */
  const hasLinePayload = Array.isArray(input.lines) && input.lines.length > 0;
  const requestedByLineId = new Map<string, number>();
  const requestedByItemId = new Map<string, number>();
  // Nhóm tài sản người nhận hàng chọn cho từng dòng Tài sản/CCDC (chỉ khớp được theo lineId).
  const requestedAssetGroupByLineId = new Map<string, string>();
  const requestedPriceByLineId = new Map<string, number>();
  /** ĐVT nhận khác ĐVT đặt (khách 27/10/2026) — số lượng + đơn giá dòng đó theo ĐVT này. */
  const requestedUnitByLineId = new Map<string, string>();
  /** Thuế suất GTGT + chiết khấu từng dòng khai lúc nhận (khách 26/10/2026) — như phiếu Nhập mua bên Kho. */
  const requestedTermsByLineId = new Map<string, { vatRate: number | null; discountRate: string; discountAmount: string }>();
  if (hasLinePayload) {
    for (const row of input.lines as Array<{ lineId?: unknown; id?: unknown; itemId?: unknown; quantity?: unknown; assetGroup?: unknown; unitCost?: unknown; unitCode?: unknown; vatRate?: unknown; discountRate?: unknown; discountAmount?: unknown }>) {
      const quantity = toNumber(row.quantity);
      if (!(quantity >= 0)) continue;
      const lineId = cleanText(row.lineId) || cleanText(row.id);
      // Đơn giá thực lúc nhận (theo ĐVT đặt) — PO duyệt khi chưa có giá thì nhập ở đây.
      if (lineId && toNumber(row.unitCost) > 0) requestedPriceByLineId.set(lineId, toNumber(row.unitCost));
      if (lineId && cleanText(row.unitCode)) requestedUnitByLineId.set(lineId, cleanText(row.unitCode));
      if (lineId && cleanText(row.assetGroup)) requestedAssetGroupByLineId.set(lineId, cleanText(row.assetGroup).toUpperCase());
      if (lineId) {
        const vat = parseVatRate(row.vatRate);
        if (!vat.ok) businessError(`Thuế suất GTGT [${cleanText(row.vatRate)}] không hợp lệ`);
        requestedTermsByLineId.set(lineId, { vatRate: vat.ok ? vat.rate : null, discountRate: cleanText(row.discountRate), discountAmount: cleanText(row.discountAmount) });
      }
      if (lineId) requestedByLineId.set(lineId, quantity);
      else {
        const itemId = cleanText(row.itemId);
        // Payload cũ chỉ có itemId: cộng dồn để hai dòng cùng mặt hàng không nhân đôi.
        if (itemId) requestedByItemId.set(itemId, (requestedByItemId.get(itemId) || 0) + quantity);
      }
    }
  }

  // Dòng cuối cùng của mỗi mặt hàng nhận nốt phần dư, để số gửi vượt vẫn chạm được chốt chặn
  // "nhận vượt số đã đặt" bên dưới thay vì bị âm thầm cắt bớt.
  const lastLineIdOfItem = new Map<string, string>();
  for (const line of order.lines) lastLineIdOfItem.set(line.itemId, line.id);

  const receiveLines = order.lines.map((line) => {
    const remaining = line.orderedQuantity - line.receivedQuantity;
    // ĐVT nhận: ĐVT đặt của dòng PO, hoặc ĐVT khác đã khai khi NCC giao khác ĐVT (khách 27/10/2026).
    const unit = receiveUnitFor(line, line.item, requestedUnitByLineId.get(line.id));
    if (!unit) businessError(`ĐVT ${requestedUnitByLineId.get(line.id)} chưa khai cho ${line.item.name} — thêm ở danh mục mặt hàng hoặc nhận theo ĐVT khác.`);
    const received = { ...line, receiveUnitCode: unit.unitCode, receiveRate: unit.conversionRate };
    if (!hasLinePayload) return { ...received, receiveQuantity: remaining };
    // Số nhận theo dòng gửi lên là theo ĐVT NHẬN của dòng (khách 21/10/2026) → quy về ĐVT tồn.
    if (requestedByLineId.has(line.id)) return { ...received, receiveQuantity: (requestedByLineId.get(line.id) as number) * unit.conversionRate };
    if (requestedByItemId.has(line.itemId)) {
      const left = requestedByItemId.get(line.itemId) as number;
      const take = lastLineIdOfItem.get(line.itemId) === line.id ? left : Math.min(remaining, left);
      requestedByItemId.set(line.itemId, left - take);
      return { ...received, receiveQuantity: take };
    }
    // Có gửi danh sách dòng mà dòng này không nằm trong đó = không nhận dòng này.
    return { ...received, receiveQuantity: 0 };
  })
    .map((line) => (requestedPriceByLineId.has(line.id) ? { ...line, unitCost: (requestedPriceByLineId.get(line.id) as number) / line.receiveRate, priceChanged: true } : { ...line, priceChanged: false }))
    .filter((line) => line.receiveQuantity > 0)
    .map((line) => ({ ...line, isNew: false }));
  // Nhận THỪA được (khách 26/10/2026): rau, thịt, cá cân lên hay lệch so với số đặt — không chặn
  // "vượt số còn lại" nữa; dòng nhận đủ/thừa thì coi như xong.

  /**
   * Dòng THÊM ngay lúc nhận (khách 26/10/2026): NCC giao thêm hàng gọi bổ sung chung phiếu — thành
   * dòng mới của chính PO này (số đặt = số nhận) để cuối tháng đối chiếu công nợ NCC theo một PO.
   */
  const extraInput = Array.isArray(input.extraLines) ? (input.extraLines as Array<Record<string, unknown>>) : [];
  const extraItems = extraInput.length === 0 ? [] : await prisma.inventoryItem.findMany({
    where: { id: { in: extraInput.map((row) => cleanText(row.itemId)).filter(Boolean) } },
    include: { unitConversions: { where: { deletedAt: null } } },
  });
  const extraItemById = new Map(extraItems.map((item) => [item.id, item]));
  const extraLines = extraInput.flatMap((row, index) => {
    const item = extraItemById.get(cleanText(row.itemId));
    if (!cleanText(row.itemId)) return [];
    if (!item) businessError("Có mặt hàng thêm lúc nhận không còn trong danh mục — tải lại trang rồi chọn lại.");
    if (item.status !== "ACTIVE") businessError(`Mặt hàng ${item.code} đang ngưng hoạt động`);
    if (item.itemType === "FINISHED") businessError(`${item.code} là thành phẩm — không mua qua PO.`);
    const quantity = toNumber(row.quantity);
    if (!(quantity > 0)) businessError(`Nhập số lượng nhận cho mặt hàng thêm ${item.name}`);
    const chosen = cleanText(row.unitCode);
    const allowed = chosen && purchaseUnitOptions(item.unit, item.unitConversions).some((option) => option.unitCode.toUpperCase() === chosen.toUpperCase());
    const { unitCode, conversionRate } = defaultPurchaseUnit(item.unit, item.unitConversions, allowed ? chosen : item.unit);
    const id = `extra-${index}`;
    const vat = parseVatRate(row.vatRate);
    if (!vat.ok) businessError(`Thuế suất GTGT [${cleanText(row.vatRate)}] không hợp lệ`);
    requestedTermsByLineId.set(id, { vatRate: vat.ok ? vat.rate : null, discountRate: cleanText(row.discountRate), discountAmount: cleanText(row.discountAmount) });
    if (cleanText(row.assetGroup)) requestedAssetGroupByLineId.set(id, cleanText(row.assetGroup).toUpperCase());
    const unitCost = toNumber(row.unitCost) / conversionRate;
    return [{
      ...receiveLineTemplate(order.id),
      id,
      itemId: item.id,
      item,
      unitCode,
      conversionRate,
      receiveUnitCode: unitCode,
      receiveRate: conversionRate,
      receiveQuantity: quantity * conversionRate,
      orderedQuantity: quantity * conversionRate,
      unitCost,
      totalCost: quantity * conversionRate * unitCost,
      priceChanged: false,
      isNew: true,
    }];
  });
  receiveLines.push(...extraLines);
  if (receiveLines.length === 0) businessError("Không có số lượng cần nhận");
  if (receiveLines.some((line) => ["TOOL", "ASSET"].includes(line.item.itemType)) && !order.departmentCode) {
    businessError("PO có Tài sản/CCDC phải chọn Phòng ban để hệ thống tự sinh mã");
  }

  // CCDC/Tài sản KHÔNG vào tồn kho — trước đây vừa cộng tồn vừa tạo hồ sơ tài sản, cùng một
  // cái máy nằm ở hai sổ và giá trị bị đếm đôi; kiểm kê kho lại từ chối loại này nên phần tồn
  // đó vĩnh viễn không điều chỉnh được. Sổ tài sản là sổ gốc duy nhất cho TOOL/ASSET.
  const stockLines = receiveLines.filter((line) => !["TOOL", "ASSET"].includes(line.item.itemType));
  const assetLines = receiveLines.filter((line) => ["TOOL", "ASSET"].includes(line.item.itemType));
  // Chốt Nhóm tài sản của từng dòng TRƯỚC khi vào transaction: thiếu thì dừng ngay với thông
  // báo chọn nhóm nào, chứ không cấp mã rồi mới phát hiện nhóm không có trong danh mục.
  const assetGroupCatalog = assetLines.length > 0
    ? await prisma.masterDataItem.findMany({
        where: { type: "ASSET_GROUP", status: "ACTIVE" },
        select: { code: true, name: true, group: true },
        orderBy: { code: "asc" },
      })
    : [];
  const assetGroupByLineId = new Map<string, string>();
  for (const line of assetLines) {
    const resolved = resolveAssetGroupForReceive({
      itemType: line.item.itemType,
      itemCode: line.item.code,
      requestedCode: requestedAssetGroupByLineId.get(line.id),
      catalog: assetGroupCatalog,
    });
    if (!resolved.ok) businessError(resolved.error);
    assetGroupByLineId.set(line.id, resolved.code);
  }

  // Dòng kho do engine kho kiểm chiết khấu; dòng Tài sản/CCDC không qua đó nên kiểm ở đây.
  for (const line of assetLines) {
    const terms = requestedTermsByLineId.get(line.id);
    const discount = resolveDiscount(Math.round(line.receiveQuantity * line.unitCost), terms?.discountRate, terms?.discountAmount);
    if (!discount.ok) businessError(`${line.item.name}: ${discount.reason}`);
  }

  const freeStockLine = stockLines.find((line) => line.unitCost <= 0);
  if (freeStockLine) {
    // Nhập mua giá 0 kéo giá vốn bình quân về sai — hàng tặng kèm thì sửa đơn giá PO
    // thành giá trị hợp lý hoặc nhận bằng phiếu "Nhập khác" có ghi chú.
    businessError(`Dòng ${freeStockLine.item.code} chưa có đơn giá — nhập đơn giá thực mua ở ô Đơn giá khi nhận hàng. Hàng tặng kèm hãy nhận bằng phiếu Nhập khác.`);
  }
  return { order, receiveLines, stockLines, assetLines, requestedTermsByLineId, assetGroupByLineId, purchaseCost: 0 };
}

export type ReceivePlan = Awaited<ReturnType<typeof prepareOrderReceive>>;

/** Ghi một lần nhận PO đã chuẩn bị: phiếu NM, dòng PO, tài sản/CCDC, công nợ NCC, bản ghi lần nhận. */
export async function postOrderReceive(tx: TxClient, session: DemoSession, plan: ReceivePlan, receivedDate: Date, note: string) {
  const { order, receiveLines, stockLines, assetLines, requestedTermsByLineId, assetGroupByLineId } = plan;
  // Đi qua đúng engine kho (postInventoryTransaction): mã loại chuẩn NHAP_MUA để lên báo cáo
  // thẻ kho (báo cáo lọc NHAP_*/XUAT_* — mã "RECEIPT" cũ làm phiếu nhận PO vô hình và tồn
  // đầu kỳ bị tính ngược sai), kèm khoá dòng tồn và kiểm tra mặt hàng ngưng hoạt động.
  const stockTransaction = stockLines.length > 0
    ? await postInventoryTransaction(tx, {
        code: await nextStockDocCode(tx, "NM", receivedDate),
        transactionType: "NHAP_MUA",
        transactionDate: receivedDate,
        branchCode: order.branchCode,
        warehouseCode: order.warehouseCode,
        referenceType: "PURCHASE_ORDER",
        referenceId: order.id,
        referenceCode: order.code,
        partnerCode: order.supplierCode || null,
        note: note || `Nhận hàng từ ${order.code}`,
        createdBy: session.name,
        purchaseCost: plan.purchaseCost,
        // Phiếu nhập ghi theo ĐVT nhận (mặc định ĐVT đặt của PO), engine kho quy đổi ra ĐVT tồn (cùng
        // luật hệ số an toàn). ĐVT đó đã bị gỡ / đổi hệ số khỏi danh mục sau lúc đặt thì nhập thẳng theo ĐVT tồn.
        lines: stockLines.map((line) => {
          const rate = line.receiveRate;
          const stillValid = rate !== 1 && conversionRateForUnit(line.item.unit, line.item.unitConversions, line.receiveUnitCode || "") === rate;
          const terms = requestedTermsByLineId.get(line.id);
          const extra = { vatRate: terms?.vatRate ?? null, discountRate: terms?.discountRate || "", discountAmount: terms?.discountAmount || "" };
          return stillValid
            ? { itemId: line.itemId, inputQuantity: line.receiveQuantity / rate, inputUnitCode: line.receiveUnitCode, inputUnitCost: line.unitCost * rate, ...extra }
            : { itemId: line.itemId, inputQuantity: line.receiveQuantity, inputUnitCost: line.unitCost, ...extra };
        }),
      })
    : null;

  // Công nợ NCC lần nhận này = tiền hàng sau chiết khấu + thuế GTGT của từng dòng + chi phí mua
  // hàng (khách 26/10/2026) — dòng kho lấy đúng số phiếu nhập vừa ghi, dòng tài sản tính cùng công thức.
  let receivedValue = (stockTransaction?.purchaseCost || 0)
    + (stockTransaction?.lines || []).reduce((sum, line) => sum + purchaseLineAmount(line) + (line.vatAmount || 0), 0);
  const assetFigures = purchaseLineFigures(assetLines.map((line) => {
    const terms = requestedTermsByLineId.get(line.id);
    return { quantity: line.receiveQuantity, unitPrice: line.unitCost, vatRate: terms?.vatRate ?? null, discountRate: terms?.discountRate, discountAmount: terms?.discountAmount };
  }), 0);
  const assetValueByLineId = new Map(assetLines.map((line, index) => [line.id, assetFigures[index].afterTax]));
  receivedValue += assetFigures.reduce((sum, row) => sum + row.afterTax, 0);
  // Ghi lại lần nhận này để "Huỷ lần nhận" đảo đúng phần đã làm (khách 26/10/2026).
  const receiptLines: Array<{ lineId: string; quantity: number; createdLine: boolean; previousUnitCost: number | null; previousTotalCost: number | null }> = [];
  const assetIds: string[] = [];
  for (const line of receiveLines) {
    if (line.isNew) {
      const created = await tx.purchaseOrderLine.create({
        data: {
          orderId: order.id, itemId: line.itemId, orderedQuantity: line.orderedQuantity, receivedQuantity: line.receiveQuantity,
          unitCost: line.unitCost, totalCost: line.totalCost, unitCode: line.unitCode, conversionRate: line.conversionRate,
        },
      });
      receiptLines.push({ lineId: created.id, quantity: line.receiveQuantity, createdLine: true, previousUnitCost: null, previousTotalCost: null });
      continue;
    }
    const before = order.lines.find((candidate) => candidate.id === line.id);
    receiptLines.push({
      lineId: line.id,
      quantity: line.receiveQuantity,
      createdLine: false,
      previousUnitCost: line.priceChanged && before ? before.unitCost : null,
      previousTotalCost: line.priceChanged && before ? before.totalCost : null,
    });
    await tx.purchaseOrderLine.update({
      where: { id: line.id },
      data: {
        receivedQuantity: { increment: line.receiveQuantity },
        // Giá thực lúc nhận thay giá tạm trên PO (lần nhận sau cùng quyết định giá dòng).
        ...(line.priceChanged ? { unitCost: line.unitCost, totalCost: line.orderedQuantity * line.unitCost } : {}),
      },
    });
  }
  for (const line of assetLines) {
    // Nguyên giá = tiền hàng sau chiết khấu + thuế (cùng luật giá vốn sau thuế của hàng nhập kho).
    const receivedLineValue = assetValueByLineId.get(line.id) || 0;
    const assetGroup = assetGroupByLineId.get(line.id) as string;
    const asset = await tx.assetRecord.create({
      data: {
        code: await nextAssetCode(tx, assetGroup, order.departmentCode || ""),
        name: line.item.name,
        branchCode: order.branchCode,
        departmentCode: order.departmentCode || null,
        assetGroup,
        imageUrl: line.imageUrl || null,
        location: order.warehouseCode,
        quantity: line.receiveQuantity,
        purchaseDate: receivedDate,
        originalCost: receivedLineValue,
        currentValue: receivedLineValue,
        supplierCode: order.supplierCode,
        supplierName: order.supplierName,
        sourcePurchaseOrderId: order.id,
        sourceReceiptId: stockTransaction?.id || null,
        status: "IN_USE",
        note: `Tự tạo từ nhận hàng ${order.code}`,
      },
    });
    assetIds.push(asset.id);
  }

  const remainingLines = await tx.purchaseOrderLine.findMany({ where: { orderId: order.id } });
  const completed = remainingLines.every((line) => line.receivedQuantity >= line.orderedQuantity - 1e-6);
  await tx.purchaseOrder.update({
    where: { id: order.id },
    data: {
      status: completed ? "COMPLETED" : "PARTIALLY_RECEIVED",
      ...(receiveLines.some((line) => line.priceChanged || line.isNew) ? { totalAmount: remainingLines.reduce((sum, line) => sum + line.totalCost, 0) } : {}),
    },
  });
  await syncRequestCompletion(tx, order.requestId);
  // Cộng dồn bằng `increment` chứ không đọc-rồi-ghi: hai lần nhận hàng chạy song song mà
  // đọc cùng số cũ thì một khoản công nợ bị nuốt mất (lost update).
  await tx.supplierPayable.upsert({
    where: { purchaseOrderId: order.id },
    create: { purchaseOrderId: order.id, supplierCode: order.supplierCode, supplierName: order.supplierName, recognizedDate: receivedDate, originalAmount: receivedValue, outstandingAmount: receivedValue },
    update: { originalAmount: { increment: receivedValue }, outstandingAmount: { increment: receivedValue } },
  });
  await tx.purchaseOrderReceipt.create({
    data: {
      orderId: order.id,
      stockTransactionId: stockTransaction?.id || null,
      receivedDate,
      payableAmount: receivedValue,
      lines: receiptLines,
      assetIds,
      createdBy: session.name,
    },
  });
  return { stockTransaction, assetsCreated: assetLines.length };
}
