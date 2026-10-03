/**
 * Nhóm hàng hóa của mặt hàng (InventoryItem.goodsGroup) — ghi tự do (khách chốt 03/10/2026), nên
 * chuẩn hoá khoảng trắng để "Hải  sản " và "Hải sản" về một nhóm trên ô lọc.
 */
export function normalizeGoodsGroup(value: unknown): string | null {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || null;
}

/** Khoá so khớp không phân biệt hoa thường / dấu cách thừa — gom nhóm trên ô lọc. */
export function goodsGroupKey(value: unknown) {
  return (normalizeGoodsGroup(value) || "").toLocaleLowerCase("vi");
}
