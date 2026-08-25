/**
 * Quy đổi ĐVT mua về ĐVT tồn kho.
 *
 * LUẬT BẤT BIẾN: một đơn vị không thể quy đổi ra CHÍNH NÓ với tỷ lệ khác 1.
 * Danh mục hiện có ~1.277 mặt hàng khai sai kiểu "1 KG = 1000 KG" / "1 LIT = 1000 LIT"
 * (đúng ra là 1 KG = 1000 G, người khai điền nhầm cột ĐVT mua bằng ĐVT tồn). Nếu tin
 * thẳng tỷ lệ đó thì mọi phép nhân đều sai 1000 lần: nhận 1.000 lít thành 1.000.000 lít
 * tồn kho, yêu cầu mua 1 lít thành 1.000 lít, giá dự kiến phồng lên 1000 lần.
 *
 * Vì vậy MỌI nơi đọc tỷ lệ quy đổi phải đi qua đây, đừng đọc thẳng `conversionRate`.
 */

export type UnitConversionLike = {
  unitCode: string;
  unitName?: string | null;
  conversionRate: number;
  isDefaultPurchase?: boolean;
};

function sameUnit(left: string, right: string) {
  return left.trim().toUpperCase() === right.trim().toUpperCase();
}

/**
 * Tỷ lệ quy đổi đáng tin của một dòng quy đổi: trùng ĐVT tồn kho -> 1, còn lại giữ nguyên.
 * Tỷ lệ không hợp lệ (0, âm, NaN) cũng quy về 1 để không nhân hỏng số liệu.
 */
export function safeConversionRate(baseUnit: string, conversion?: UnitConversionLike | null) {
  if (!conversion) return 1;
  if (sameUnit(conversion.unitCode, baseUnit)) return 1;
  const rate = Number(conversion.conversionRate);
  return Number.isFinite(rate) && rate > 0 ? rate : 1;
}

/** Dòng quy đổi khai sai kiểu "1 X = n X" (n ≠ 1) — dùng để cảnh báo trên màn danh mục. */
export function isSelfReferencingConversion(baseUnit: string, conversion: UnitConversionLike) {
  return sameUnit(conversion.unitCode, baseUnit) && Number(conversion.conversionRate) !== 1;
}

/**
 * ĐVT mua mặc định của mặt hàng, kèm tỷ lệ đã làm sạch.
 * Không có quy đổi nào thì trả về chính ĐVT tồn kho với tỷ lệ 1.
 */
export function defaultPurchaseUnit(
  baseUnit: string,
  conversions: UnitConversionLike[] | null | undefined,
  preferredUnitCode?: string | null,
) {
  const list = conversions || [];
  // Danh mục có mặt hàng gắn cờ "ĐVT mua mặc định" cho NHIỀU dòng (thùng và lốc cùng true).
  // Không chọn theo thứ tự mảng — thứ tự do database trả về và đổi sau mỗi lần sửa, khiến cùng
  // một mẫu hôm nay quy đổi ×24 mai ×6. Chốt luật: lấy ĐVT lớn nhất trong các dòng mặc định.
  const defaults = list
    .filter((unit) => unit.isDefaultPurchase && !sameUnit(unit.unitCode, baseUnit))
    .sort((a, b) => (Number(b.conversionRate) || 0) - (Number(a.conversionRate) || 0));
  const conversion = preferredUnitCode
    ? list.find((unit) => sameUnit(unit.unitCode, preferredUnitCode))
    : defaults[0];
  const rate = safeConversionRate(baseUnit, conversion);
  return {
    unitCode: conversion?.unitCode || baseUnit,
    unitLabel: conversion?.unitName || conversion?.unitCode || baseUnit,
    conversionRate: rate,
  };
}
