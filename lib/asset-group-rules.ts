/**
 * Luật chọn NHÓM TÀI SẢN cho hồ sơ tài sản/CCDC sinh từ PO khi nhận hàng.
 *
 * Hồ sơ tài sản phải mang MÃ nhóm có thật trong danh mục Nhóm tài sản: nhóm quyết định tiền tố
 * mã (lib/asset-code-generator.ts) mà mã đã cấp là không sửa được khi đã phát sinh chứng từ.
 * Bản cũ gán cứng "CCDC"/"ASSET" — hai mã không tồn tại trong danh mục của khách (CCDC_BAR,
 * CCDC_FOH, MACHINENRY_BEP...) — nên tài sản nhận từ PO mang nhóm rác, mở form sửa ra ô Nhóm
 * tài sản trống.
 *
 * File thuần, không chạm DB, để màn hình nhận hàng và API dùng CHUNG một luật.
 */

export type AssetGroupOption = { code: string; name: string; group: string | null };

/** Phân loại Nhóm tài sản chấp nhận được cho từng loại mặt hàng của PO. */
const GROUP_TYPES_BY_ITEM_TYPE: Record<string, string[]> = {
  TOOL: ["CCDC", "TOOL"],
  ASSET: ["FIXED_ASSET"],
};

export function assetGroupTypeLabel(itemType: string) {
  return itemType === "TOOL" ? "Công cụ dụng cụ" : "Tài sản cố định";
}

/** Các nhóm trong danh mục dùng được cho loại mặt hàng này. */
export function assetGroupCandidates(itemType: string, catalog: AssetGroupOption[]) {
  const allowed = GROUP_TYPES_BY_ITEM_TYPE[itemType] || [];
  return catalog.filter((group) => allowed.includes((group.group || "").trim().toUpperCase()));
}

/**
 * Chốt nhóm cho một dòng PO: người nhận hàng chọn gì thì theo đó (phải đúng phân loại), không
 * chọn mà danh mục chỉ có đúng một nhóm hợp lệ thì tự lấy, còn lại trả lỗi nói rõ chọn nhóm nào
 * — thà dừng còn hơn gán bừa một nhóm rồi khoá luôn tiền tố mã sai.
 */
export type AssetGroupResolution = { ok: true; code: string } | { ok: false; error: string };

export function resolveAssetGroupForReceive(input: {
  itemType: string;
  itemCode: string;
  requestedCode?: string | null;
  catalog: AssetGroupOption[];
}): AssetGroupResolution {
  const candidates = assetGroupCandidates(input.itemType, input.catalog);
  const requested = (input.requestedCode || "").trim().toUpperCase();
  if (requested) {
    const matched = candidates.find((group) => group.code.trim().toUpperCase() === requested);
    return matched
      ? { ok: true, code: matched.code }
      : { ok: false, error: `Nhóm tài sản ${requested} không thuộc phân loại ${assetGroupTypeLabel(input.itemType)} nên không nhận được ${input.itemCode}.` };
  }
  if (candidates.length === 0) {
    return { ok: false, error: `Chưa khai Nhóm tài sản nào thuộc phân loại ${assetGroupTypeLabel(input.itemType)} để nhận ${input.itemCode}. Thêm ở Cài đặt > Danh mục > Nhóm tài sản.` };
  }
  if (candidates.length > 1) {
    return { ok: false, error: `Dòng ${input.itemCode} phải chọn Nhóm tài sản (${candidates.map((group) => group.code).join(", ")}).` };
  }
  return { ok: true, code: candidates[0].code };
}
