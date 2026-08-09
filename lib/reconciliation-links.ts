import type { RawTxClient } from "@/lib/prisma";

export async function completePendingReconciliation(
  tx: RawTxClient,
  targetType: string,
  targetId: string,
) {
  const match = await tx.reconciliationMatch.findFirst({
    where: { targetType, targetId, status: "PENDING_REVIEW", deletedAt: null },
  });
  if (!match) return null;
  await tx.reconciliationMatch.update({ where: { id: match.id }, data: { status: "MATCHED" } });
  await tx.bankStatementTransaction.update({
    where: { id: match.bankTransactionId },
    data: { reconcileStatus: "MATCHED", autoProcessNote: `Đã duyệt và đối soát với ${match.targetCode}` },
  });
  return match;
}

export async function reopenReconciliationForReview(
  tx: RawTxClient,
  targetType: string,
  targetId: string,
) {
  const match = await tx.reconciliationMatch.findFirst({
    where: { targetType, targetId, status: "MATCHED", deletedAt: null },
  });
  if (!match) return null;
  await tx.reconciliationMatch.update({ where: { id: match.id }, data: { status: "PENDING_REVIEW" } });
  await tx.bankStatementTransaction.update({
    where: { id: match.bankTransactionId },
    data: { reconcileStatus: "PENDING_REVIEW", autoProcessNote: `Phiếu ${match.targetCode} đã bỏ duyệt` },
  });
  return match;
}

export async function releasePendingReconciliation(
  tx: RawTxClient,
  targetType: string,
  targetId: string,
  note: string,
) {
  const match = await tx.reconciliationMatch.findFirst({
    where: { targetType, targetId, status: { in: ["PENDING_REVIEW", "MATCHED"] }, deletedAt: null },
  });
  if (!match) return null;
  await tx.bankStatementTransaction.update({
    where: { id: match.bankTransactionId },
    data: { reconcileStatus: "UNMATCHED", autoProcessType: "MANUAL_REQUIRED", autoProcessNote: note },
  });
  // Liên kết máy sinh chưa còn hiệu lực phải được xóa cứng để rollback/import lại không bị khóa.
  await tx.reconciliationMatch.delete({ where: { id: match.id } });
  return match;
}
