import { prisma, type TxClient } from "@/lib/prisma";
import { ensureInternalPartner } from "@/lib/internal-partner";
import { INTERNAL_PAYABLE_ACCOUNT, INTERNAL_RECEIVABLE_ACCOUNT, internalPartnerCode } from "@/lib/cost-reallocation";
import { addPeriod, businessError, findClosedPeriod, closedPeriodMessage, periodFromDate } from "@/lib/phase3";
import { nextSeqFromCodes } from "@/lib/voucher-code-generator";
import { roundVnd } from "@/lib/round-vnd";

/**
 * Điều chuyển tài sản / CCDC giữa hai nhà hàng (khách 27/11/2026: "nhà hàng điều chuyển ngưng, toàn
 * bộ chi phí còn lại chuyển qua nhà hàng nhận, có công nợ nội bộ"). Ví dụ CCDC 12 tháng, A đã phân
 * bổ 2 tháng thì chuyển: B nhận giá trị còn lại, phân bổ tiếp 10 tháng; A phải thu nội bộ B, B phải
 * trả nội bộ A đúng giá trị còn lại.
 *
 * - Kỳ chuyển (tháng của ngày chuyển) trở đi thuộc nhà hàng nhận; A chịu tới hết tháng trước.
 * - Đợt gốc giữ nguyên lịch sử khấu hao ở A (trạng thái TRANSFERRED, giá trị còn lại 0). Phần chuyển
 *   thành đợt mới ở B; chuyển MỘT PHẦN thì phần ở lại cũng thành đợt mới ở A — mỗi đợt mới mang lũy
 *   kế + số kỳ đã chạy làm "đầu kỳ" (accumulatedDepreciation / openingDepreciatedPeriods) nên chạy
 *   khấu hao tiếp đúng = còn lại ÷ kỳ còn lại, cùng công thức CCDC đầu kỳ đang phân bổ dở.
 * - Bút toán (sourceType ASSET_TRANSFER_OUT / _IN): CCDC Nợ 1368 / Có 242 ở A, Nợ 242 / Có 3368 ở B;
 *   TSCĐ Nợ 1368 + Nợ 214 / Có 211 ở A, Nợ 211 / Có 214 + Có 3368 ở B.
 */

export const ASSET_TRANSFERRED = "TRANSFERRED";
export const ASSET_TRANSFER_OUT_SOURCE = "ASSET_TRANSFER_OUT";
export const ASSET_TRANSFER_IN_SOURCE = "ASSET_TRANSFER_IN";

type SourceLot = {
  quantity: number;
  originalCost: number;
  currentValue: number;
  residualValue: number;
  usefulLifeMonths: number | null;
  openingDepreciatedPeriods: number;
};

export type TransferPlan = {
  share: number;
  depreciatedPeriods: number;
  remainingPeriods: number | null;
  moved: { quantity: number; originalCost: number; remainingValue: number; accumulated: number; residualValue: number };
  kept: { quantity: number; originalCost: number; remainingValue: number; accumulated: number; residualValue: number } | null;
};

/**
 * Chia đợt theo số lượng chuyển. Giá trị còn lại lấy theo `currentValue` (đã trừ mọi kỳ khấu hao
 * đã chạy); lũy kế = nguyên giá − còn lại để mỗi đợt mới luôn tự khớp. `runPeriods` = số kỳ đã
 * chạy trên hệ thống trước kỳ chuyển.
 */
export function planAssetTransfer(lot: SourceLot, quantity: number, runPeriods: number): TransferPlan {
  if (!(quantity > 0)) businessError("Số lượng chuyển phải lớn hơn 0.");
  if (quantity > lot.quantity + 1e-9) businessError(`Số lượng chuyển (${quantity}) vượt số lượng của đợt (${lot.quantity}).`);
  const share = lot.quantity > 0 ? Math.min(quantity / lot.quantity, 1) : 1;
  const full = share >= 1 - 1e-9;
  const depreciatedPeriods = (lot.openingDepreciatedPeriods || 0) + runPeriods;
  const remainingPeriods = lot.usefulLifeMonths ? Math.max(lot.usefulLifeMonths - depreciatedPeriods, 0) : null;
  const part = (value: number) => (full ? roundVnd(value) : roundVnd(value * share));
  const movedCost = part(lot.originalCost);
  const movedRemaining = part(lot.currentValue);
  const movedResidual = full ? lot.residualValue : Math.round(lot.residualValue * share * 100) / 100;
  const moved = { quantity, originalCost: movedCost, remainingValue: movedRemaining, accumulated: roundVnd(movedCost - movedRemaining), residualValue: movedResidual };
  if (full) return { share: 1, depreciatedPeriods, remainingPeriods, moved: { ...moved, quantity: lot.quantity }, kept: null };
  const keptCost = roundVnd(lot.originalCost - movedCost);
  const keptRemaining = roundVnd(lot.currentValue - movedRemaining);
  return {
    share,
    depreciatedPeriods,
    remainingPeriods,
    moved,
    kept: {
      quantity: Math.round((lot.quantity - quantity) * 1e6) / 1e6,
      originalCost: keptCost,
      remainingValue: keptRemaining,
      accumulated: roundVnd(keptCost - keptRemaining),
      residualValue: Math.round((lot.residualValue - movedResidual) * 100) / 100,
    },
  };
}

type JournalLine = { accountCode: string; debit?: number; credit?: number; partnerCode?: string | null };

/** Hai bút toán của phiếu: bên chuyển và bên nhận. */
export function assetTransferJournalLines(transfer: {
  isTool: boolean;
  fromBranchCode: string;
  toBranchCode: string;
  originalCost: number;
  accumulatedDepreciation: number;
  remainingValue: number;
  assetCode: string;
}) {
  const fromPartner = internalPartnerCode(transfer.fromBranchCode);
  const toPartner = internalPartnerCode(transfer.toBranchCode);
  const remaining = roundVnd(transfer.remainingValue);
  if (transfer.isTool) {
    return {
      out: [
        { accountCode: INTERNAL_RECEIVABLE_ACCOUNT, debit: remaining, partnerCode: toPartner },
        { accountCode: "242", credit: remaining, partnerCode: transfer.assetCode },
      ] as JournalLine[],
      in: [
        { accountCode: "242", debit: remaining, partnerCode: transfer.assetCode },
        { accountCode: INTERNAL_PAYABLE_ACCOUNT, credit: remaining, partnerCode: fromPartner },
      ] as JournalLine[],
    };
  }
  const cost = roundVnd(transfer.originalCost);
  const accumulated = roundVnd(transfer.accumulatedDepreciation);
  return {
    out: [
      ...(remaining > 0 ? [{ accountCode: INTERNAL_RECEIVABLE_ACCOUNT, debit: remaining, partnerCode: toPartner }] : []),
      ...(accumulated > 0 ? [{ accountCode: "214", debit: accumulated }] : []),
      { accountCode: "211", credit: cost, partnerCode: transfer.assetCode },
    ] as JournalLine[],
    in: [
      { accountCode: "211", debit: cost, partnerCode: transfer.assetCode },
      ...(accumulated > 0 ? [{ accountCode: "214", credit: accumulated }] : []),
      ...(remaining > 0 ? [{ accountCode: INTERNAL_PAYABLE_ACCOUNT, credit: remaining, partnerCode: fromPartner }] : []),
    ] as JournalLine[],
  };
}

export async function isToolAssetGroup(client: Pick<TxClient, "masterDataItem">, assetGroup: string) {
  const group = await client.masterDataItem.findFirst({ where: { type: "ASSET_GROUP", code: assetGroup }, select: { group: true } });
  return ["CCDC", "TOOL"].includes((group?.group || "").toUpperCase());
}

/** Mã phiếu DCTS-YYYYMM-xxxx — max + 1, đọc thô để thấy cả mã đã huỷ. */
async function nextTransferCode(tx: TxClient, transferDate: Date) {
  const prefix = `DCTS-${periodFromDate(transferDate).replace("-", "")}-`;
  const rows = await tx.$queryRaw<Array<{ code: string }>>`SELECT "code" FROM "AssetTransfer" WHERE "code" LIKE ${prefix + "%"}`;
  return prefix + String(nextSeqFromCodes(rows.map((row) => row.code), prefix)).padStart(4, "0");
}

/** Đợt kế tiếp của mã — tính cả đợt đã xoá mềm vì (code, lotNo) là duy nhất cả với bản đã xoá. */
async function nextLotNo(tx: TxClient, code: string) {
  const rows = await tx.$queryRaw<Array<{ max: number | null }>>`SELECT MAX("lotNo") AS "max" FROM "AssetRecord" WHERE "code" = ${code}`;
  return Number(rows[0]?.max || 0) + 1;
}

/** Kỳ đã phải chạy khấu hao ở nhà hàng chuyển mà chưa chạy (trước kỳ chuyển). */
function missingRunPeriods(input: { firstPeriod: string; lastRunPeriod: string | null; transferPeriod: string; slotsLeft: number }) {
  const missing: string[] = [];
  let cursor = input.lastRunPeriod ? addPeriod(input.lastRunPeriod, 1) : input.firstPeriod;
  while (cursor < input.transferPeriod && missing.length < input.slotsLeft) {
    missing.push(cursor);
    cursor = addPeriod(cursor, 1);
  }
  return missing;
}

export type AssetTransferInput = {
  assetId: string;
  toBranchCode: string;
  toWarehouseCode?: string | null;
  toDepartmentCode?: string | null;
  transferDate: Date;
  quantity: number;
  note?: string | null;
  actor: string;
};

/** Lập phiếu điều chuyển trong một transaction. Bút toán ghi sau khi commit (postAssetTransferJournals). */
export async function createAssetTransfer(tx: TxClient, input: AssetTransferInput) {
  const asset = await tx.assetRecord.findUnique({ where: { id: input.assetId } });
  if (!asset) businessError("Không tìm thấy tài sản / CCDC.");
  if (asset.status !== "IN_USE" || asset.disposalStatus) businessError(`${asset.code} không còn ở trạng thái đang dùng (đã thanh lý hoặc đã điều chuyển) nên không chuyển được.`);
  const fromBranchCode = asset.branchCode.toUpperCase();
  const toBranchCode = input.toBranchCode.trim().toUpperCase();
  if (!toBranchCode) businessError("Chọn nhà hàng nhận.");
  if (toBranchCode === fromBranchCode) businessError("Nhà hàng nhận phải khác nhà hàng đang giữ tài sản. Đổi kho / phòng ban trong cùng nhà hàng thì sửa ở hồ sơ tài sản.");
  const branch = await tx.masterDataItem.findFirst({ where: { type: "BRANCH", code: toBranchCode } });
  if (!branch) businessError(`Không có nhà hàng ${toBranchCode} trong danh mục.`);
  if (input.toWarehouseCode) {
    const warehouse = await tx.masterDataItem.findFirst({ where: { type: "WAREHOUSE", code: input.toWarehouseCode, OR: [{ branch: toBranchCode }, { branch: "ALL" }, { branch: null }] } });
    if (!warehouse) businessError(`Kho ${input.toWarehouseCode} không thuộc nhà hàng ${toBranchCode}.`);
  }
  if (input.transferDate < asset.purchaseDate) businessError("Ngày chuyển không được trước ngày mua tài sản.");

  const period = periodFromDate(input.transferDate);
  const closed = await findClosedPeriod([{ period, branchCode: fromBranchCode }, { period, branchCode: toBranchCode }], tx);
  if (closed) businessError(closedPeriodMessage(closed, "điều chuyển tài sản"));

  const runs = await tx.assetDepreciation.findMany({ where: { assetId: asset.id }, select: { period: true }, orderBy: { period: "asc" } });
  const runAfter = runs.filter((row) => row.period >= period).map((row) => row.period);
  if (runAfter.length > 0) {
    businessError(`${asset.code} đã chạy khấu hao kỳ ${runAfter.join(", ")} ở ${fromBranchCode}. Từ kỳ chuyển (${period}) chi phí thuộc nhà hàng nhận — mở lại khấu hao các kỳ đó cho tài sản này trước rồi điều chuyển.`);
  }
  // Nhà hàng chuyển phải chạy đủ các kỳ trước kỳ chuyển, nếu không phần chi phí đó rơi sang nhà hàng nhận.
  if (asset.usefulLifeMonths && asset.currentValue > asset.residualValue + 0.5) {
    const opening = asset.openingBalanceId
      ? await tx.openingBalance.findUnique({ where: { id: asset.openingBalanceId }, select: { period: true } })
      : null;
    const startDate = asset.depreciationStartDate || asset.purchaseDate;
    const firstPeriod = opening?.period && opening.period > periodFromDate(startDate) ? opening.period : periodFromDate(startDate);
    const slotsLeft = Math.max(Math.ceil(asset.usefulLifeMonths - (asset.openingDepreciatedPeriods || 0) - runs.length), 0);
    const missing = missingRunPeriods({ firstPeriod, lastRunPeriod: runs.at(-1)?.period || null, transferPeriod: period, slotsLeft });
    if (missing.length > 0) {
      businessError(`${asset.code} chưa chạy khấu hao/phân bổ kỳ ${missing.join(", ")} ở ${fromBranchCode}. Chạy các kỳ đó trước (tab Khấu hao) để nhà hàng chuyển chịu đúng phần của mình, rồi mới điều chuyển.`);
    }
  }

  const plan = planAssetTransfer(asset, input.quantity, runs.length);
  const isTool = await isToolAssetGroup(tx, asset.assetGroup);
  const code = await nextTransferCode(tx, input.transferDate);
  const transfer = await tx.assetTransfer.create({
    data: {
      code,
      transferDate: input.transferDate,
      period,
      fromBranchCode,
      toBranchCode,
      toWarehouseCode: input.toWarehouseCode || null,
      toDepartmentCode: input.toDepartmentCode || asset.departmentCode || null,
      sourceAssetId: asset.id,
      assetCode: asset.code,
      assetName: asset.name,
      isTool,
      quantity: plan.moved.quantity,
      sourceQuantity: asset.quantity,
      originalCost: plan.moved.originalCost,
      accumulatedDepreciation: plan.moved.accumulated,
      remainingValue: plan.moved.remainingValue,
      depreciatedPeriods: plan.depreciatedPeriods,
      remainingPeriods: plan.remainingPeriods,
      sourceSnapshotJson: JSON.stringify({ status: asset.status, currentValue: asset.currentValue }),
      note: input.note || null,
      createdBy: input.actor,
    },
  });

  const lotBase = {
    code: asset.code,
    name: asset.name,
    assetGroup: asset.assetGroup,
    imageUrl: asset.imageUrl,
    purchaseDate: asset.purchaseDate,
    usefulLifeMonths: asset.usefulLifeMonths,
    depreciationStartDate: asset.depreciationStartDate,
    openingDepreciatedPeriods: plan.depreciatedPeriods,
    supplierName: asset.supplierName,
    // Không mang mã NCC / công nợ: đợt mới không phải lần mua mới (công nợ mua vẫn ở đợt gốc).
    paymentStatus: "PAID",
    transferredFromId: asset.id,
    transferId: transfer.id,
    status: "IN_USE",
  };
  let lotNo = await nextLotNo(tx, asset.code);
  const target = await tx.assetRecord.create({
    data: {
      ...lotBase,
      lotNo: lotNo++,
      branchCode: toBranchCode,
      departmentCode: input.toDepartmentCode || asset.departmentCode,
      warehouseCode: input.toWarehouseCode || null,
      location: input.toWarehouseCode || null,
      quantity: plan.moved.quantity,
      originalCost: plan.moved.originalCost,
      currentValue: plan.moved.remainingValue,
      accumulatedDepreciation: plan.moved.accumulated,
      residualValue: plan.moved.residualValue,
      note: `Nhận điều chuyển từ ${fromBranchCode} theo phiếu ${code}`,
    },
  });
  const kept = plan.kept
    ? await tx.assetRecord.create({
      data: {
        ...lotBase,
        lotNo: lotNo++,
        branchCode: fromBranchCode,
        departmentCode: asset.departmentCode,
        warehouseCode: asset.warehouseCode,
        location: asset.location,
        quantity: plan.kept.quantity,
        originalCost: plan.kept.originalCost,
        currentValue: plan.kept.remainingValue,
        accumulatedDepreciation: plan.kept.accumulated,
        residualValue: plan.kept.residualValue,
        note: `Phần ở lại sau phiếu điều chuyển ${code}`,
      },
    })
    : null;
  await tx.assetRecord.update({ where: { id: asset.id }, data: { status: ASSET_TRANSFERRED, currentValue: 0 } });

  const debts = plan.moved.remainingValue > 0 ? await upsertTransferDebts(tx, { ...transfer, remainingValue: plan.moved.remainingValue }) : null;
  return tx.assetTransfer.update({
    where: { id: transfer.id },
    data: { targetAssetId: target.id, keptAssetId: kept?.id || null, receivableDebtCode: debts?.receivableCode || null, payableDebtCode: debts?.payableCode || null },
  });
}

async function upsertTransferDebts(tx: TxClient, transfer: { id: string; code: string; transferDate: Date; fromBranchCode: string; toBranchCode: string; remainingValue: number; assetCode: string; assetName: string }) {
  const receivableCode = `${transfer.code}-PT`;
  const payableCode = `${transfer.code}-PTR`;
  const fromPartner = await ensureInternalPartner(tx as unknown as typeof prisma, transfer.fromBranchCode);
  const toPartner = await ensureInternalPartner(tx as unknown as typeof prisma, transfer.toBranchCode);
  const common = {
    partnerGroup: "INTERNAL",
    documentDate: transfer.transferDate,
    originalAmount: transfer.remainingValue,
    outstandingAmount: transfer.remainingValue,
    status: "OPEN",
    sourceType: "ASSET_TRANSFER",
    sourceId: transfer.id,
    deletedAt: null,
  };
  const receivable = {
    ...common,
    debtType: "RECEIVABLE",
    partnerCode: toPartner.code,
    partnerName: toPartner.name,
    branchCode: transfer.fromBranchCode,
    description: `${transfer.toBranchCode} nhận tài sản ${transfer.assetCode} - ${transfer.assetName} theo phiếu điều chuyển ${transfer.code} (giá trị còn lại)`,
  };
  const payable = {
    ...common,
    debtType: "PAYABLE",
    partnerCode: fromPartner.code,
    partnerName: fromPartner.name,
    branchCode: transfer.toBranchCode,
    description: `Nhận tài sản ${transfer.assetCode} - ${transfer.assetName} từ ${transfer.fromBranchCode} theo phiếu điều chuyển ${transfer.code} (giá trị còn lại)`,
  };
  await tx.debtRecord.upsert({ where: { code: receivableCode }, create: { code: receivableCode, ...receivable }, update: receivable });
  await tx.debtRecord.upsert({ where: { code: payableCode }, create: { code: payableCode, ...payable }, update: payable });
  return { receivableCode, payableCode };
}

type PostJournal = (input: {
  entryDate: Date;
  branchCode: string;
  sourceType: string;
  sourceId: string;
  sourceCode: string;
  description: string;
  createdBy: string;
  lines: JournalLine[];
}) => Promise<string>;

/** Ghi (hoặc ghi lại) hai bút toán của phiếu. `post` = postJournalEntry (truyền vào để tránh vòng import). */
export async function postAssetTransferJournals(transfer: {
  id: string; code: string; transferDate: Date; fromBranchCode: string; toBranchCode: string; isTool: boolean;
  originalCost: number; accumulatedDepreciation: number; remainingValue: number; assetCode: string; assetName: string; status: string;
}, post: PostJournal, actor: string) {
  if (transfer.status !== "ACTIVE") return [];
  const lines = assetTransferJournalLines(transfer);
  return [
    await post({ entryDate: transfer.transferDate, branchCode: transfer.fromBranchCode, sourceType: ASSET_TRANSFER_OUT_SOURCE, sourceId: transfer.id, sourceCode: transfer.code, description: `Điều chuyển ${transfer.assetCode} - ${transfer.assetName} sang ${transfer.toBranchCode}`, createdBy: actor, lines: lines.out }),
    await post({ entryDate: transfer.transferDate, branchCode: transfer.toBranchCode, sourceType: ASSET_TRANSFER_IN_SOURCE, sourceId: transfer.id, sourceCode: transfer.code, description: `Nhận ${transfer.assetCode} - ${transfer.assetName} từ ${transfer.fromBranchCode}`, createdBy: actor, lines: lines.in }),
  ];
}

/**
 * Huỷ phiếu: chỉ khi các đợt sinh ra chưa phát sinh gì (khấu hao, kiểm kê, bảo trì, báo hỏng,
 * thanh lý, điều chuyển tiếp) và công nợ nội bộ chưa gạch. Xoá hẳn đợt mới (không vào thùng rác —
 * khôi phục một nửa phiếu là lệch sổ), trả đợt gốc về như trước, gỡ công nợ + bút toán.
 */
export async function cancelAssetTransfer(tx: TxClient, transferId: string, actor: string) {
  const transfer = await tx.assetTransfer.findUnique({ where: { id: transferId } });
  if (!transfer) businessError("Không tìm thấy phiếu điều chuyển.");
  if (transfer.status !== "ACTIVE") businessError(`Phiếu ${transfer.code} đã huỷ.`);
  const closed = await findClosedPeriod([{ period: transfer.period, branchCode: transfer.fromBranchCode }, { period: transfer.period, branchCode: transfer.toBranchCode }], tx);
  if (closed) businessError(closedPeriodMessage(closed, "huỷ phiếu điều chuyển tài sản"));

  const lotIds = [transfer.targetAssetId, transfer.keptAssetId].filter((id): id is string => Boolean(id));
  const lots = await tx.assetRecord.findMany({
    where: { id: { in: lotIds }, deletedAt: undefined },
    include: { _count: { select: { depreciations: true, stocktakeLines: true, maintenances: true, damageReports: true } } },
  });
  for (const lot of lots) {
    const where = lot.branchCode === transfer.toBranchCode ? `ở ${transfer.toBranchCode}` : `phần ở lại ${transfer.fromBranchCode}`;
    if (lot._count.depreciations > 0) businessError(`Đợt ${lot.lotNo} của ${lot.code} (${where}) đã chạy khấu hao — mở lại các kỳ đó trước rồi huỷ phiếu.`);
    if (lot._count.stocktakeLines > 0 || lot._count.maintenances > 0 || lot._count.damageReports > 0) businessError(`Đợt ${lot.lotNo} của ${lot.code} (${where}) đã có kiểm kê / bảo trì / báo hỏng nên không huỷ phiếu được.`);
    if (lot.status !== "IN_USE") businessError(`Đợt ${lot.lotNo} của ${lot.code} (${where}) đã thanh lý hoặc điều chuyển tiếp — huỷ thao tác đó trước.`);
  }
  const debtCodes = [transfer.receivableDebtCode, transfer.payableDebtCode].filter((code): code is string => Boolean(code));
  const debts = debtCodes.length > 0 ? await tx.debtRecord.findMany({ where: { code: { in: debtCodes } }, include: { settlements: true } }) : [];
  const settled = debts.find((debt) => debt.settlements.length > 0);
  if (settled) businessError(`Công nợ nội bộ ${settled.code} đã được gạch nợ — hoàn tác phiếu thu/chi gạch nợ trước rồi huỷ phiếu.`);

  const snapshot = JSON.parse(transfer.sourceSnapshotJson || "{}") as { status?: string; currentValue?: number };
  await tx.assetRecord.update({ where: { id: transfer.sourceAssetId }, data: { status: snapshot.status || "IN_USE", currentValue: snapshot.currentValue ?? 0 } });
  if (lotIds.length > 0) await tx.$executeRaw`DELETE FROM "AssetRecord" WHERE "id" = ANY(${lotIds}::text[])`;
  if (debts.length > 0) await tx.debtRecord.updateMany({ where: { id: { in: debts.map((debt) => debt.id) } }, data: { deletedAt: new Date(), deletedBy: actor } });
  await tx.journalEntry.deleteMany({ where: { sourceType: { in: [ASSET_TRANSFER_OUT_SOURCE, ASSET_TRANSFER_IN_SOURCE] }, sourceId: transfer.id } });
  return tx.assetTransfer.update({ where: { id: transfer.id }, data: { status: "CANCELLED", cancelledBy: actor, cancelledAt: new Date() } });
}
