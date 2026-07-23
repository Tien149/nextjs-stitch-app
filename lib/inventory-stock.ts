import { Prisma } from "@prisma/custom-client";

export const STOCK_TRANSACTION_TYPES = [
  "NHAP_MUA",
  "NHAP_KHAC",
  "NHAP_CHE_BIEN",
  "NHAP_KIEM_KE",
  "XUAT_BAN",
  "XUAT_HUY",
  "XUAT_KHAC",
  "XUAT_CHE_BIEN",
  "XUAT_KIEM_KE",
  "DIEU_CHUYEN",
] as const;

export type StockTransactionType = typeof STOCK_TRANSACTION_TYPES[number];

type Tx = Prisma.TransactionClient;

export type StockLineInput = {
  itemId?: string;
  itemCode?: string;
  quantity?: unknown;
  inputQuantity?: unknown;
  unitCode?: unknown;
  inputUnitCode?: unknown;
  unitCost?: unknown;
  inputUnitCost?: unknown;
};

export type PostInventoryTransactionInput = {
  importBatchId?: string | null;
  code: string;
  transactionType: string;
  transactionDate: Date;
  branchCode: string;
  warehouseCode: string;
  toWarehouseCode?: string | null;
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

function stockError(message: string): never {
  throw new Error(`BUSINESS:${message}`);
}

async function resolveStockLine(tx: Tx, line: StockLineInput, requireInputUnitCost: boolean) {
  const itemId = text(line.itemId);
  const itemCode = text(line.itemCode).toUpperCase();
  const item = itemId
    ? await tx.inventoryItem.findUnique({ where: { id: itemId }, include: { unitConversions: true } })
    : await tx.inventoryItem.findUnique({ where: { code: itemCode }, include: { unitConversions: true } });

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

  const conversionRate = conversion?.conversionRate || 1;
  if (!Number.isFinite(conversionRate) || conversionRate <= 0) {
    stockError(`Ty le quy doi cua ${item.code} khong hop le`);
  }

  const inputUnitCost = numberValue(line.inputUnitCost ?? line.unitCost);
  if (requireInputUnitCost && inputUnitCost <= 0) stockError(`Nhap mua ${item.code} bat buoc co don gia`);

  return {
    item,
    itemId: item.id,
    inputQuantity,
    inputUnitCode: conversion?.unitName || rawUnitCode,
    conversionRate,
    quantity: inputQuantity * conversionRate,
    inputUnitCost: inputUnitCost || null,
    unitCost: inputUnitCost > 0 ? inputUnitCost / conversionRate : 0,
  };
}

async function applyBalanceChange(
  tx: Tx,
  itemId: string,
  warehouseCode: string,
  quantity: number,
  unitCost: number,
  direction: "IN" | "OUT",
) {
  const balance = await tx.inventoryBalance.findUnique({
    where: { itemId_warehouseCode: { itemId, warehouseCode } },
  });
  const currentQuantity = balance?.quantity || 0;
  const currentAverage = balance?.averageCost || 0;
  const effectiveUnitCost = unitCost > 0 ? unitCost : currentAverage;
  const newQuantity = direction === "IN" ? currentQuantity + quantity : currentQuantity - quantity;
  if (newQuantity < -0.000001) stockError("Khong the xuat vuot ton kho");
  const averageCost = direction === "IN" && newQuantity > 0
    ? ((currentQuantity * currentAverage) + (quantity * effectiveUnitCost)) / newQuantity
    : currentAverage;

  await tx.inventoryBalance.upsert({
    where: { itemId_warehouseCode: { itemId, warehouseCode } },
    create: { itemId, warehouseCode, quantity: newQuantity, averageCost },
    update: { quantity: newQuantity, averageCost },
  });

  return { unitCost: effectiveUnitCost, totalCost: quantity * effectiveUnitCost };
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

  const requireInputUnitCost = transactionType === "NHAP_MUA";
  const resolvedLines = [];
  for (const line of input.lines) {
    resolvedLines.push(await resolveStockLine(tx, line, requireInputUnitCost));
  }

  const valuedLines = [];
  for (const line of resolvedLines) {
    if (isInboundStockType(transactionType)) {
      const valued = await applyBalanceChange(tx, line.itemId, input.warehouseCode, line.quantity, line.unitCost, "IN");
      valuedLines.push({ ...line, unitCost: valued.unitCost, totalCost: valued.totalCost });
    } else if (isOutboundStockType(transactionType)) {
      const valued = await applyBalanceChange(tx, line.itemId, input.warehouseCode, line.quantity, line.unitCost, "OUT");
      valuedLines.push({ ...line, unitCost: valued.unitCost, totalCost: valued.totalCost });
    } else {
      const outValue = await applyBalanceChange(tx, line.itemId, input.warehouseCode, line.quantity, line.unitCost, "OUT");
      await applyBalanceChange(tx, line.itemId, input.toWarehouseCode || "", line.quantity, outValue.unitCost, "IN");
      valuedLines.push({ ...line, unitCost: outValue.unitCost, totalCost: outValue.totalCost });
    }
  }

  return tx.inventoryTransaction.create({
    data: {
      importBatchId: input.importBatchId || null,
      code: input.code,
      transactionType,
      transactionDate: input.transactionDate,
      branchCode: input.branchCode,
      warehouseCode: input.warehouseCode,
      toWarehouseCode: transactionType === "DIEU_CHUYEN" ? input.toWarehouseCode : null,
      referenceType: input.referenceType || null,
      referenceId: input.referenceId || null,
      referenceCode: input.referenceCode || null,
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
        })),
      },
    },
    include: { lines: { include: { item: true } } },
  });
}
