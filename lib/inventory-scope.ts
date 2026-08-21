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
 * Quy ước tiền tố mã theo loại mặt hàng — dùng chung cho API nhập tay và import,
 * để hai luồng không lệch chuẩn nhau. Trả về thông báo lỗi hoặc null nếu hợp lệ.
 */
export function itemCodePrefixError(itemType: string, uppercaseCode: string): string | null {
  const rules: Record<string, [string, string]> = {
    RAW_MATERIAL: ["NVL_", "NVL_SUADAC"],
    SEMI_FINISHED: ["BTP_", "BTP_SOTCACHUA"],
    FINISHED: ["SP_", "SP_COMBO01"],
    PACKAGING: ["BB_", "BB_LYGIAY"],
    TOOL: ["CCDC_", "CCDC_MAYPHA"],
    ASSET: ["TS_", "TS_MAYPHA"],
  };
  const rule = rules[itemType];
  if (!rule) return null;
  if (uppercaseCode.startsWith(rule[0])) return null;
  return `Mã mặt hàng loại này bắt buộc bắt đầu bằng '${rule[0]}' (ví dụ: ${rule[1]})`;
}
