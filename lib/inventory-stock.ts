import type { TxClient } from "@/lib/prisma";
import { nextSeqFromCodes } from "@/lib/voucher-code-generator";
import { safeConversionRate } from "@/lib/unit-conversion";
import { vatAmountOf } from "@/lib/inventory-vat";
import { roundVnd } from "@/lib/money-rounding";

export const STOCK_TRANSACTION_TYPES = [
  "NHAP_MUA",
  "NHAP_KHAC",
  "NHAP_CHE_BIEN",
  "NHAP_KIEM_KE",
  "XUAT_BAN",
  "XUAT_HUY",
  "XUAT_TEST_MON",
  "XUAT_KHAC",
  "XUAT_CHE_BIEN",
  "XUAT_KIEM_KE",
  "DIEU_CHUYEN",
] as const;

export type StockTransactionType = typeof STOCK_TRANSACTION_TYPES[number];

/**
 * Loại hủy hàng — lưu ở InventoryTransaction.subType của phiếu XUAT_HUY để báo cáo
 * "mã hàng nào hủy nhiều nhất" tách được nguyên nhân.
 */
export const WASTE_SUB_TYPES = [
  { code: "HET_HAN_SU_DUNG", label: "Xuất hủy do hết hạn sử dụng" },
  { code: "KHONG_DAM_BAO_CHAT_LUONG", label: "Xuất hủy do không đảm bảo chất lượng" },
] as const;

export function normalizeWasteSubType(value: unknown) {
  const raw = text(value).toUpperCase().replace(/\s+/g, "_");
  if (!raw) return null;
  if (["HET_HAN_SU_DUNG", "HET_HAN", "EXPIRED", "HUY_HET_HAN"].includes(raw)) return "HET_HAN_SU_DUNG";
  if (["KHONG_DAM_BAO_CHAT_LUONG", "CHAT_LUONG", "KEM_CHAT_LUONG", "QUALITY", "HUY_CHAT_LUONG"].includes(raw)) {
    return "KHONG_DAM_BAO_CHAT_LUONG";
  }
  return raw;
}

export function isWasteSubType(value: string) {
  return WASTE_SUB_TYPES.some((subType) => subType.code === value);
}

type Tx = TxClient;

export type StockLineInput = {
  itemId?: string;
  itemCode?: string;
  quantity?: unknown;
  inputQuantity?: unknown;
  unitCode?: unknown;
  inputUnitCode?: unknown;
  unitCost?: unknown;
  inputUnitCost?: unknown;
  /**
   * Thue suat GTGT dau vao cua dong: so thap phan (0.08), `null` = KKKNT, `undefined` = khong
   * khai. Chi co y nghia voi phieu NHAP; xem lib/inventory-vat.ts.
   */
  vatRate?: number | null;
};

export type PostInventoryTransactionInput = {
  importBatchId?: string | null;
  code: string;
  partnerCode?: string | null;
  transactionType: string;
  /** Phân loại chi tiết, hiện dùng cho loại hủy của phiếu XUAT_HUY. */
  subType?: string | null;
  transactionDate: Date;
  branchCode: string;
  warehouseCode: string;
  toWarehouseCode?: string | null;
  /** Cửa hàng của kho nhận khi điều chuyển liên nhà hàng. Trống = cùng branchCode. */
  toBranchCode?: string | null;
  internalReceivableDebtCode?: string | null;
  internalPayableDebtCode?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  referenceCode?: string | null;
  note?: string | null;
  createdBy?: string | null;
  lines: StockLineInput[];
};

function text(value: unknown) {
  return String(value || "").trim();
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeStockTransactionType(value: unknown) {
  const raw = text(value).toUpperCase();
  if (raw === "RECEIPT" || raw === "NHAP" || raw === "NHAP_KHO" || raw === "PURCHASE_RECEIPT") return "NHAP_MUA";
  if (raw === "ISSUE" || raw === "XUAT" || raw === "XUAT_KHO") return "XUAT_KHAC";
  if (raw === "WASTE" || raw === "HUY" || raw === "HANG_HUY" || raw === "XUAT_HAO_HUT") return "XUAT_HUY";
  if (raw === "TRANSFER" || raw === "CHUYEN_KHO" || raw === "DIEU_CHUYEN_KHO") return "DIEU_CHUYEN";
  // File import hay khai theo hai chiều "nhập/xuất điều chuyển" — đều là một phiếu điều chuyển.
  if (raw === "NHAP_DIEU_CHUYEN" || raw === "XUAT_DIEU_CHUYEN") return "DIEU_CHUYEN";
  if (raw === "TEST_MON" || raw === "XUAT_TEST" || raw === "MON_TEST" || raw === "XUAT_TEST_MON") return "XUAT_TEST_MON";
  if (raw === "POS_SALE" || raw === "BAN_HANG") return "XUAT_BAN";
  if (raw === "PRODUCTION_IN" || raw === "CHE_BIEN_NHAP") return "NHAP_CHE_BIEN";
  if (raw === "PRODUCTION_OUT" || raw === "CHE_BIEN_XUAT") return "XUAT_CHE_BIEN";
  if (raw === "STOCKTAKE_IN" || raw === "KIEM_KE_NHAP") return "NHAP_KIEM_KE";
  if (raw === "STOCKTAKE_OUT" || raw === "KIEM_KE_XUAT") return "XUAT_KIEM_KE";
  if (raw === "ADJUSTMENT") return "NHAP_KHAC";
  return raw;
}

export function isStockTransactionType(value: string): value is StockTransactionType {
  return STOCK_TRANSACTION_TYPES.includes(value as StockTransactionType);
}

export function isInboundStockType(value: string) {
  return value.startsWith("NHAP_");
}

export function isOutboundStockType(value: string) {
  return value.startsWith("XUAT_");
}

/**
 * Mã chứng từ kho kế tiếp: max + 1 trong đúng chuỗi `PREFIX-YYYY-`.
 * Không dùng COUNT + 1: xoá/rollback làm COUNT tụt xuống và mã cấp lại đâm trúng
 * phiếu đang sống (đúng lớp lỗi "Dữ liệu bị trùng" của phiếu tiền, đã sửa 19/08).
 * Tra bằng SQL thô để thấy cả phiếu đã xoá mềm — ràng buộc unique tính cả chúng.
 */
export async function nextStockDocCode(tx: Tx, prefix: string, docDate: Date) {
  const head = `${prefix}-${docDate.getUTCFullYear()}-`;
  const rows = await tx.$queryRaw<Array<{ code: string }>>`SELECT "code" FROM "InventoryTransaction" WHERE "code" LIKE ${head + "%"}`;
  // Mã lần rã nguyên liệu đẻ phiếu con mang hậu tố (RA-2026-0001-1X, -1N, -2XB...): phần sau
  // head không còn là số thuần, Number() trả NaN nên max kẹt ở 0 và lần rã thứ hai trong năm
  // lại được cấp -0001 -> đâm unique. Chỉ lấy cụm số đứng đầu để đếm đúng cả mã có hậu tố.
  const normalizedCodes = rows
    .map((row) => /^(\d+)/.exec(row.code.slice(head.length))?.[1])
    .filter((seq): seq is string => Boolean(seq))
    .map((seq) => head + seq);
  return head + String(nextSeqFromCodes(normalizedCodes, head)).padStart(4, "0");
}

/** Cùng luật max + 1 cho số phiếu kiểm kê kho (KK-YYYY-####). */
export async function nextStocktakeCode(tx: Tx, docDate: Date) {
  const head = `KK-${docDate.getUTCFullYear()}-`;
  const rows = await tx.$queryRaw<Array<{ code: string }>>`SELECT "code" FROM "StocktakeSession" WHERE "code" LIKE ${head + "%"}`;
  return head + String(nextSeqFromCodes(rows.map((row) => row.code), head)).padStart(4, "0");
}

function stockError(message: string): never {
  throw new Error(`BUSINESS:${message}`);
}

/**
 * Đơn giá của phiếu NHẬP MUA gần nhất cho một mặt hàng (quy về ĐVT tồn kho).
 * Dùng làm giá ưu tiên khi điều chuyển mà kho nguồn chưa có giá vốn bình quân.
 */
export async function latestPurchaseUnitCost(tx: Tx, itemId: string) {
  const line = await tx.inventoryTransactionLine.findFirst({
    where: { itemId, unitCost: { gt: 0 }, transaction: { transactionType: "NHAP_MUA", deletedAt: null } },
    orderBy: { transaction: { transactionDate: "desc" } },
    select: { unitCost: true },
  });
  return line?.unitCost || 0;
}

async function resolveStockLine(tx: Tx, line: StockLineInput) {
  const itemId = text(line.itemId);
  const itemCode = text(line.itemCode).toUpperCase();
  // Lọc quy đổi đã xoá mềm: quan hệ lồng không được lớp xoá mềm lọc tự động, không lọc tay thì
  // ĐVT người dùng đã xoá vẫn được chấp nhận và vẫn nhân tỷ lệ vào phiếu kho.
  const conversionFilter = { unitConversions: { where: { deletedAt: null } } } as const;
  const item = itemId
    ? await tx.inventoryItem.findUnique({ where: { id: itemId }, include: conversionFilter })
    : await tx.inventoryItem.findUnique({ where: { code: itemCode }, include: conversionFilter });

  if (!item) stockError(`Khong tim thay mat hang ${itemCode || itemId}`);
  if (item.status !== "ACTIVE") stockError(`Mat hang ${item.code} dang ngung hoat dong`);

  const inputQuantity = numberValue(line.inputQuantity ?? line.quantity);
  if (inputQuantity <= 0) stockError(`So luong cua ${item.code} phai lon hon 0`);

  const rawUnitCode = text(line.inputUnitCode ?? line.unitCode) || item.unit;
  const normalizedUnitCode = rawUnitCode.toUpperCase();
  const conversion = item.unitConversions.find((unit) => unit.unitCode.toUpperCase() === normalizedUnitCode);
  const isBaseUnit = normalizedUnitCode === item.unit.toUpperCase();
  if (!conversion && !isBaseUnit) {
    stockError(`DVT ${rawUnitCode} khong ton tai trong quy doi cua mat hang ${item.code}`);
  }

  // Ghi số theo ĐÚNG ĐVT tồn kho thì tỷ lệ luôn là 1, kể cả khi danh mục có dòng quy đổi
  // khai sai "1 LIT = 1000 LIT" (xem lib/unit-conversion.ts) — nếu không, nhận 1.000 lít
  // sẽ cộng 1.000.000 lít vào tồn kho.
  const conversionRate = isBaseUnit ? 1 : safeConversionRate(item.unit, conversion);

  const inputUnitCost = numberValue(line.inputUnitCost ?? line.unitCost);

  return {
    item,
    itemId: item.id,
    inputQuantity,
    inputUnitCode: conversion?.unitName || rawUnitCode,
    conversionRate,
    quantity: inputQuantity * conversionRate,
    inputUnitCost: inputUnitCost || null,
    unitCost: inputUnitCost > 0 ? inputUnitCost / conversionRate : 0,
    vatRate: line.vatRate ?? null,
    /**
     * Thue tinh tren SO LUONG x DON GIA KHAI TREN PHIEU, dung cong thuc khach chot
     * ("Thanh tien sau thue = Thanh tien truoc thue x (1 + thue suat)").
     *
     * KHONG tinh tren `totalCost` sau dinh gia: dong don gia 0 (hang khuyen mai, tang kem)
     * duoc dinh gia lai theo binh quan cua kho de gia von khong tut, nhung NCC khong xuat hoa
     * don cho hang tang nen khong co dong thue nao phai tra.
     */
    vatAmount: vatAmountOf(roundVnd(inputQuantity * inputUnitCost), line.vatRate ?? null),
  };
}

/**
 * Phần tính thuần của một lần cộng/trừ tồn — tách ra khỏi DB để test được bằng node --test.
 *
 * `allowNegative` là luật XUẤT ÂM (khách chốt 22/09/2026): phiếu XUAT_* vẫn ghi được khi kho
 * chưa có tồn, vì nghiệp vụ "rã bom" phải chạy cho cả những mã chưa kịp khai tồn đầu kỳ.
 * Tồn xuống âm chính là số nợ kho đang thiếu, để kế toán nhìn thấy mà đi khai bù — chứ không
 * phải cái cớ để chặn cả lần rã. Điều chuyển kho vẫn KHÔNG được âm: chuyển hàng không có
 * sang kho khác là bịa ra giá trị cho kho nhận.
 */
export function computeBalanceChange(input: {
  currentQuantity: number;
  currentAverage: number;
  quantity: number;
  unitCost: number;
  direction: "IN" | "OUT";
}) {
  const { currentQuantity, currentAverage, quantity, direction } = input;
  const effectiveUnitCost = input.unitCost > 0 ? input.unitCost : currentAverage;
  const newQuantity = direction === "IN" ? currentQuantity + quantity : currentQuantity - quantity;
  /**
   * Nhập vào lúc tồn đang ÂM (hoặc bằng 0) thì lấy thẳng giá lô nhập, không bình quân với
   * phần âm: phần âm là hàng đã xuất mà chưa có giá, giá trị của nó bằng 0 chứ không âm tiền.
   * Bình quân kiểu cũ ((-50 x 0) + 100 x 30.000) / 50 sẽ thổi giá vốn lên gấp đôi giá mua.
   */
  const averageCost = direction !== "IN"
    ? currentAverage
    : currentQuantity > 0.000001
      ? (newQuantity > 0.000001 ? ((currentQuantity * currentAverage) + (quantity * effectiveUnitCost)) / newQuantity : currentAverage)
      : (effectiveUnitCost > 0 ? effectiveUnitCost : currentAverage);

  return {
    newQuantity,
    averageCost,
    unitCost: effectiveUnitCost,
    totalCost: quantity * effectiveUnitCost,
    /** Phần tồn bị âm sau bút toán này (0 nếu vẫn dương) — để báo lại cho người dùng. */
    negativeQuantity: newQuantity < -0.000001 ? -newQuantity : 0,
  };
}

async function applyBalanceChange(
  tx: Tx,
  itemId: string,
  warehouseCode: string,
  quantity: number,
  unitCost: number,
  direction: "IN" | "OUT",
  allowNegative = false,
) {
  // Khoá dòng tồn trước khi đọc: hai phiếu chạy song song sẽ xếp hàng thay vì cùng đọc
  // một số tồn rồi cùng ghi đè (lost update — xuất 16.000 khỏi kho 10.000 mà không ai báo lỗi).
  // Dòng chưa tồn tại thì không khoá được, nhưng nhánh tạo mới đã có unique (itemId, warehouseCode) chặn.
  await tx.$queryRaw`SELECT "id" FROM "InventoryBalance" WHERE "itemId" = ${itemId} AND "warehouseCode" = ${warehouseCode} FOR UPDATE`;
  const balance = await tx.inventoryBalance.findUnique({
    where: { itemId_warehouseCode: { itemId, warehouseCode } },
  });
  const change = computeBalanceChange({
    currentQuantity: balance?.quantity || 0,
    currentAverage: balance?.averageCost || 0,
    quantity,
    unitCost,
    direction,
  });
  if (change.negativeQuantity > 0 && !allowNegative) {
    const item = await tx.inventoryItem.findUnique({ where: { id: itemId }, select: { code: true } });
    stockError(`Ton kho cua ${item?.code || itemId} o kho ${warehouseCode} khong du de xuat (thieu ${change.negativeQuantity})`);
  }

  await tx.inventoryBalance.upsert({
    where: { itemId_warehouseCode: { itemId, warehouseCode } },
    create: { itemId, warehouseCode, quantity: change.newQuantity, averageCost: change.averageCost },
    update: { quantity: change.newQuantity, averageCost: change.averageCost },
  });

  return { unitCost: change.unitCost, totalCost: change.totalCost, negativeQuantity: change.negativeQuantity };
}

/**
 * Trả lại tồn kho phần mà một phiếu đã cộng/trừ — dùng khi xoá phiếu hoặc sửa phiếu.
 *
 * Trừ ngược đúng số lượng và đúng GIÁ TRỊ đã ghi trên dòng, nên số tồn và tổng giá trị kho
 * luôn khớp tuyệt đối dù phiếu nằm ở giữa kỳ. Giá vốn của những phiếu xuất phát sinh SAU vẫn
 * giữ số lịch sử của chúng — đúng tinh thần bình quân gia quyền, sửa quá khứ không đi định giá
 * lại các lần xuất đã chốt. Nhờ vậy không cần luật "chỉ xoá được phiếu cuối cùng" như trước.
 */
export async function reverseStockEffect(
  tx: Tx,
  transaction: {
    code: string;
    transactionType: string;
    warehouseCode: string;
    toWarehouseCode: string | null;
    lines: Array<{ itemId: string; quantity: number; totalCost: number }>;
  },
) {
  type Reversal = { itemId: string; warehouseCode: string; direction: "IN" | "OUT"; quantity: number; totalCost: number };
  const reversals = new Map<string, Reversal>();
  const add = (itemId: string, warehouseCode: string, direction: "IN" | "OUT", quantity: number, totalCost: number) => {
    const key = `${itemId}|${warehouseCode}|${direction}`;
    const current = reversals.get(key) || { itemId, warehouseCode, direction, quantity: 0, totalCost: 0 };
    current.quantity += quantity;
    current.totalCost += totalCost;
    reversals.set(key, current);
  };
  for (const line of transaction.lines) {
    if (transaction.transactionType === "DIEU_CHUYEN") {
      add(line.itemId, transaction.warehouseCode, "OUT", line.quantity, line.totalCost);
      if (transaction.toWarehouseCode) add(line.itemId, transaction.toWarehouseCode, "IN", line.quantity, line.totalCost);
    } else if (isInboundStockType(transaction.transactionType)) {
      add(line.itemId, transaction.warehouseCode, "IN", line.quantity, line.totalCost);
    } else {
      add(line.itemId, transaction.warehouseCode, "OUT", line.quantity, line.totalCost);
    }
  }

  for (const reversal of reversals.values()) {
    await tx.$queryRaw`SELECT "id" FROM "InventoryBalance" WHERE "itemId" = ${reversal.itemId} AND "warehouseCode" = ${reversal.warehouseCode} FOR UPDATE`;
    const balance = await tx.inventoryBalance.findUnique({
      where: { itemId_warehouseCode: { itemId: reversal.itemId, warehouseCode: reversal.warehouseCode } },
    });
    const currentQuantity = balance?.quantity || 0;
    const currentAverage = balance?.averageCost || 0;
    const currentValue = currentQuantity * currentAverage;
    // Phiếu đã làm tồn TĂNG -> hoàn kho là GIẢM lại, và ngược lại.
    const newQuantity = reversal.direction === "IN" ? currentQuantity - reversal.quantity : currentQuantity + reversal.quantity;
    /**
     * Hoàn kho KHÔNG chặn ở mức 0 nữa (luật xuất âm, khách chốt 22/09/2026): bỏ một phiếu nhập
     * mà hàng của nó đã xuất ra rồi thì tồn xuống âm đúng bằng phần đang thiếu — chấp nhận
     * được, và là cách duy nhất để hoàn tác được một lần rã chạy trên kho đang âm. Cắt về 0
     * như trước còn tệ hơn: số lượng mất im lặng, tồn với giá trị kho lệch nhau vĩnh viễn.
     */
    const newValue = reversal.direction === "IN" ? currentValue - reversal.totalCost : currentValue + reversal.totalCost;
    const averageCost = newQuantity > 0.000001 ? Math.max(newValue / newQuantity, 0) : currentAverage;
    await tx.inventoryBalance.upsert({
      where: { itemId_warehouseCode: { itemId: reversal.itemId, warehouseCode: reversal.warehouseCode } },
      create: { itemId: reversal.itemId, warehouseCode: reversal.warehouseCode, quantity: newQuantity, averageCost },
      update: { quantity: newQuantity, averageCost },
    });
  }
  return [...reversals.values()];
}

export async function postInventoryTransaction(tx: Tx, input: PostInventoryTransactionInput) {
  const transactionType = normalizeStockTransactionType(input.transactionType);
  if (!isStockTransactionType(transactionType)) stockError("Loai giao dich kho khong hop le");
  if (!input.branchCode || !input.warehouseCode) stockError("Cua hang va kho la bat buoc");
  if (transactionType === "DIEU_CHUYEN" && !input.toWarehouseCode) stockError("Dieu chuyen kho bat buoc co kho nhan");
  if (transactionType === "DIEU_CHUYEN" && input.toWarehouseCode === input.warehouseCode) {
    stockError("Kho xuat va kho nhan khong duoc giong nhau");
  }
  if (!input.lines.length) stockError("Can it nhat mot dong mat hang");

  // Nhập mua đơn giá 0 là hợp lệ: hàng khuyến mãi / tặng kèm nhận về đúng 0 đ (khách chốt
  // 20/09/2026). Dòng 0 đ được tính theo giá bình quân đang có của kho như mọi phiếu nhập khác,
  // nên giá vốn tồn kho không bị kéo xuống bởi hàng tặng.
  const resolvedLines = [];
  for (const line of input.lines) {
    resolvedLines.push(await resolveStockLine(tx, line));
  }

  const valuedLines = [];
  for (const line of resolvedLines) {
    if (isInboundStockType(transactionType)) {
      const valued = await applyBalanceChange(tx, line.itemId, input.warehouseCode, line.quantity, line.unitCost, "IN");
      valuedLines.push({ ...line, unitCost: valued.unitCost, totalCost: valued.totalCost });
    } else if (isOutboundStockType(transactionType)) {
      // Phiếu xuất được phép đẩy tồn xuống âm (xem computeBalanceChange).
      const valued = await applyBalanceChange(tx, line.itemId, input.warehouseCode, line.quantity, line.unitCost, "OUT", true);
      valuedLines.push({ ...line, unitCost: valued.unitCost, totalCost: valued.totalCost });
    } else {
      const outValue = await applyBalanceChange(tx, line.itemId, input.warehouseCode, line.quantity, line.unitCost, "OUT");
      // Kho nguồn chưa có giá vốn (mới lập, nhận hàng bằng phiếu không đơn giá) thì lấy
      // GIÁ NHẬP MUA GẦN NHẤT của mặt hàng làm giá điều chuyển, thay vì chặn cứng người
      // dùng hay để kho nhận tự thay 0 bằng bình quân của chính nó (tổng giá trị kho tự tăng).
      let transferUnitCost = outValue.unitCost;
      if (transferUnitCost <= 0) {
        transferUnitCost = await latestPurchaseUnitCost(tx, line.itemId);
      }
      if (transferUnitCost <= 0) {
        stockError(`Mat hang ${line.item.code} o kho ${input.warehouseCode} chua co gia von (binh quan = 0) va cung chua co phieu nhap mua nao de lay gia. Nhap gia von (phieu nhap co don gia hoac so du dau ky) truoc khi dieu chuyen`);
      }
      await applyBalanceChange(tx, line.itemId, input.toWarehouseCode || "", line.quantity, transferUnitCost, "IN");
      valuedLines.push({ ...line, unitCost: transferUnitCost, totalCost: transferUnitCost * line.quantity });
    }
  }

  return tx.inventoryTransaction.create({
    data: {
      importBatchId: input.importBatchId || null,
      code: input.code,
      transactionType,
      subType: input.subType || null,
      transactionDate: input.transactionDate,
      branchCode: input.branchCode,
      warehouseCode: input.warehouseCode,
      toWarehouseCode: transactionType === "DIEU_CHUYEN" ? input.toWarehouseCode : null,
      toBranchCode: transactionType === "DIEU_CHUYEN" ? input.toBranchCode || null : null,
      internalReceivableDebtCode: input.internalReceivableDebtCode || null,
      internalPayableDebtCode: input.internalPayableDebtCode || null,
      referenceType: input.referenceType || null,
      referenceId: input.referenceId || null,
      referenceCode: input.referenceCode || null,
      partnerCode: input.partnerCode || null,
      note: input.note || null,
      createdBy: input.createdBy || null,
      lines: {
        create: valuedLines.map((line) => ({
          itemId: line.itemId,
          inputQuantity: line.inputQuantity,
          inputUnitCode: line.inputUnitCode,
          conversionRate: line.conversionRate,
          quantity: line.quantity,
          inputUnitCost: line.inputUnitCost,
          unitCost: line.unitCost,
          totalCost: line.totalCost,
          vatRate: line.vatRate,
          vatAmount: line.vatAmount,
        })),
      },
    },
    include: { lines: { include: { item: true } } },
  });
}

/**
 * Ghi đè nội dung một phiếu kho đã lưu (sửa phiếu).
 *
 * Hoàn tác tác động tồn kho của bản CŨ rồi ghi bản MỚI y như lúc lập phiếu, nên sửa được phiếu
 * nằm giữa kỳ mà tồn kho và tổng giá trị kho vẫn khớp. Dòng xuất được định giá lại theo bình
 * quân hiện hành sau khi đã hoàn tác — tức là đúng mặt bằng giá của kho tại thời điểm sửa.
 */
export type RepostStockInput = {
  transactionDate: Date;
  branchCode: string;
  warehouseCode: string;
  toWarehouseCode?: string | null;
  toBranchCode?: string | null;
  partnerCode?: string | null;
  subType?: string | null;
  referenceCode?: string | null;
  note?: string | null;
  lines: StockLineInput[];
};

export async function repostInventoryTransaction(
  tx: Tx,
  current: {
    id: string;
    code: string;
    transactionType: string;
    warehouseCode: string;
    toWarehouseCode: string | null;
    lines: Array<{ itemId: string; quantity: number; totalCost: number }>;
  },
  input: RepostStockInput,
) {
  const transactionType = current.transactionType;
  if (!input.lines.length) stockError("Can it nhat mot dong mat hang");
  if (transactionType === "DIEU_CHUYEN" && !input.toWarehouseCode) stockError("Dieu chuyen kho bat buoc co kho nhan");
  if (transactionType === "DIEU_CHUYEN" && input.toWarehouseCode === input.warehouseCode) {
    stockError("Kho xuat va kho nhan khong duoc giong nhau");
  }

  await reverseStockEffect(tx, current);

  const resolvedLines = [];
  for (const line of input.lines) resolvedLines.push(await resolveStockLine(tx, line));

  const valuedLines = [];
  for (const line of resolvedLines) {
    if (isInboundStockType(transactionType)) {
      const valued = await applyBalanceChange(tx, line.itemId, input.warehouseCode, line.quantity, line.unitCost, "IN");
      valuedLines.push({ ...line, unitCost: valued.unitCost, totalCost: valued.totalCost });
    } else if (isOutboundStockType(transactionType)) {
      // Phiếu xuất được phép đẩy tồn xuống âm (xem computeBalanceChange).
      const valued = await applyBalanceChange(tx, line.itemId, input.warehouseCode, line.quantity, line.unitCost, "OUT", true);
      valuedLines.push({ ...line, unitCost: valued.unitCost, totalCost: valued.totalCost });
    } else {
      const outValue = await applyBalanceChange(tx, line.itemId, input.warehouseCode, line.quantity, line.unitCost, "OUT");
      let transferUnitCost = outValue.unitCost;
      if (transferUnitCost <= 0) transferUnitCost = await latestPurchaseUnitCost(tx, line.itemId);
      if (transferUnitCost <= 0) {
        stockError(`Mat hang ${line.item.code} o kho ${input.warehouseCode} chua co gia von (binh quan = 0) nen khong dieu chuyen duoc`);
      }
      await applyBalanceChange(tx, line.itemId, input.toWarehouseCode || "", line.quantity, transferUnitCost, "IN");
      valuedLines.push({ ...line, unitCost: transferUnitCost, totalCost: transferUnitCost * line.quantity });
    }
  }

  await tx.inventoryTransactionLine.deleteMany({ where: { transactionId: current.id } });
  return tx.inventoryTransaction.update({
    where: { id: current.id },
    data: {
      transactionDate: input.transactionDate,
      branchCode: input.branchCode,
      warehouseCode: input.warehouseCode,
      toWarehouseCode: transactionType === "DIEU_CHUYEN" ? input.toWarehouseCode || null : null,
      toBranchCode: transactionType === "DIEU_CHUYEN" ? input.toBranchCode || null : null,
      subType: input.subType ?? null,
      partnerCode: input.partnerCode || null,
      referenceCode: input.referenceCode || null,
      note: input.note || null,
      lines: {
        create: valuedLines.map((line) => ({
          itemId: line.itemId,
          inputQuantity: line.inputQuantity,
          inputUnitCode: line.inputUnitCode,
          conversionRate: line.conversionRate,
          quantity: line.quantity,
          inputUnitCost: line.inputUnitCost,
          unitCost: line.unitCost,
          totalCost: line.totalCost,
          vatRate: line.vatRate,
          vatAmount: line.vatAmount,
        })),
      },
    },
    include: { lines: { include: { item: true } } },
  });
}
