/**
 * CCDC và tài sản được kiểm kê tại phân hệ Tài sản & khấu hao, không thuộc
 * phạm vi kiểm kê hàng tồn kho.
 */
export const ASSET_MANAGEMENT_ITEM_TYPES = ["TOOL", "ASSET"] as const;

export function isWarehouseStocktakeItemType(itemType: unknown) {
  const normalized = String(itemType || "").trim().toUpperCase();
  return !ASSET_MANAGEMENT_ITEM_TYPES.includes(normalized as (typeof ASSET_MANAGEMENT_ITEM_TYPES)[number]);
}

/**
 * KHÔNG ép tiền tố mã theo loại mặt hàng (NVL_/BTP_/SP_...). Mã mặt hàng phải giữ ĐÚNG mã của
 * POS thì import doanh thu và rã nguyên liệu mới khớp được món (RevenueImportRow.productCode
 * tra thẳng InventoryItem.code); mã POS do máy bán hàng sinh ra (ABG00056, ACF0001...) nên
 * không đặt lại theo quy ước của mình được. Loại mặt hàng đã có cột itemType lo, không suy từ
 * mã, nên tiền tố chỉ còn là gợi ý đặt tên chứ không phải luật chặn.
 */
