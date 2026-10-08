/**
 * Loại mặt hàng (cột InventoryItem.itemType). Loại quyết định cách ghi sổ nên là danh sách cố
 * định, không cho tạo trên màn hình — Phân nhóm mới là nhãn người dùng tự tạo:
 * - Nguyên liệu / Hàng hóa: xuất bán, hủy, chênh kiểm kê -> giá vốn 632 theo bếp/bar của kho.
 *   Hàng hóa (bia lon, nước đóng chai...) bán nguyên đơn vị nên không cần định lượng: rã doanh
 *   thu xuất bán thẳng theo mã món POS.
 * - Bao bì -> chi phí vật tư tiêu hao (6428); Đồng phục -> chi phí đồng phục nhóm Chi phí cố
 *   định (khách chốt 08/10/2026) — xem lib/inventory-cogs.
 * - CCDC / tài sản: quản lý ở phân hệ Tài sản & khấu hao, ẩn khỏi Kho & định lượng (08/10/2026).
 */
export const INVENTORY_ITEM_TYPES = ["RAW_MATERIAL", "SEMI_FINISHED", "FINISHED", "GOODS", "PACKAGING", "UNIFORM", "TOOL", "ASSET"] as const;

export const INVENTORY_ITEM_TYPE_LABELS: Record<string, string> = {
  RAW_MATERIAL: "Nguyên liệu thô",
  SEMI_FINISHED: "Bán thành phẩm",
  FINISHED: "Thành phẩm",
  GOODS: "Hàng hóa",
  PACKAGING: "Bao bì",
  UNIFORM: "Đồng phục",
  TOOL: "CCDC",
  ASSET: "Tài sản",
};

export function inventoryItemTypeLabel(itemType: string | null | undefined) {
  const code = String(itemType || "").toUpperCase();
  return INVENTORY_ITEM_TYPE_LABELS[code] || code;
}

/**
 * CCDC và tài sản được kiểm kê tại phân hệ Tài sản & khấu hao, không thuộc
 * phạm vi kiểm kê hàng tồn kho.
 */
export const ASSET_MANAGEMENT_ITEM_TYPES = ["TOOL", "ASSET"] as const;

export function isWarehouseStocktakeItemType(itemType: unknown) {
  const normalized = String(itemType || "").trim().toUpperCase();
  return !ASSET_MANAGEMENT_ITEM_TYPES.includes(normalized as (typeof ASSET_MANAGEMENT_ITEM_TYPES)[number]);
}

/** Loại chọn được trên màn Kho & định lượng: mọi loại trừ CCDC / tài sản. */
export const WAREHOUSE_ITEM_TYPES = INVENTORY_ITEM_TYPES.filter(isWarehouseStocktakeItemType);

/**
 * KHÔNG ép tiền tố mã theo loại mặt hàng (NVL_/BTP_/SP_...). Mã mặt hàng phải giữ ĐÚNG mã của
 * POS thì import doanh thu và rã nguyên liệu mới khớp được món (RevenueImportRow.productCode
 * tra thẳng InventoryItem.code); mã POS do máy bán hàng sinh ra (ABG00056, ACF0001...) nên
 * không đặt lại theo quy ước của mình được. Loại mặt hàng đã có cột itemType lo, không suy từ
 * mã, nên tiền tố chỉ còn là gợi ý đặt tên chứ không phải luật chặn.
 */
