import type { Prisma } from "@prisma/custom-client";

type BalanceClient = Pick<Prisma.TransactionClient, "inventoryBalance">;

export type OpeningInventoryAmount = { quantity: number; unitCost: number };

const quantityEpsilon = 0.000001;

/**
 * Đổi số dư ĐẦU KỲ tồn kho của một mã ở một kho: chỉ cộng / trừ phần CHÊNH so với đầu kỳ cũ,
 * giữ nguyên mọi phát sinh đã có (rã, nhập, xuất, điều chuyển).
 *
 * Trước đây lưu / import / hoàn tác đầu kỳ GHI ĐÈ tồn bằng đúng số đầu kỳ. Kho đã có phiếu thì
 * phát sinh của phiếu mất khỏi số dư, rồi lúc hoàn tác phiếu đó số dư bị cộng / trừ lần nữa —
 * VPS 26/09/2026 lưu đầu kỳ sau khi đã rã tháng 8, xoá lần rã cũ để rã lại thì đẻ ra tồn "ma"
 * ở ~800 mã × kho (NME_KBEP BNBELA00011: sổ 2.500, số dư 31.500).
 *
 * Giá trị kho cũng đi theo phần chênh: bỏ giá trị đầu kỳ cũ, cộng giá trị đầu kỳ mới.
 */
export async function applyOpeningInventoryChange(
  tx: BalanceClient,
  input: { itemId: string; warehouseCode: string; before: OpeningInventoryAmount; after: OpeningInventoryAmount },
) {
  const { itemId, warehouseCode, before, after } = input;
  const deltaQuantity = after.quantity - before.quantity;
  const deltaValue = after.quantity * after.unitCost - before.quantity * before.unitCost;
  if (Math.abs(deltaQuantity) <= quantityEpsilon && Math.abs(deltaValue) <= 0.5) return;
  const balance = await tx.inventoryBalance.findUnique({ where: { itemId_warehouseCode: { itemId, warehouseCode } } });
  const currentQuantity = balance?.quantity || 0;
  const currentAverage = balance?.averageCost || 0;
  const quantity = currentQuantity + deltaQuantity;
  const value = currentQuantity * currentAverage + deltaValue;
  const averageCost = quantity > quantityEpsilon
    ? Math.max(value / quantity, 0)
    : (after.quantity > quantityEpsilon ? after.unitCost : currentAverage);
  await tx.inventoryBalance.upsert({
    where: { itemId_warehouseCode: { itemId, warehouseCode } },
    create: { itemId, warehouseCode, quantity, averageCost },
    update: { quantity, averageCost },
  });
}
