/**
 * Hệ số quy đổi mẻ định lượng về ĐVT tồn kho (Recipe.outputConversionRate).
 *
 * Định lượng khai nguyên liệu cho MỘT mẻ; cost/ĐVT tồn = cost mẻ ÷ hệ số. Mẻ khai "650GR" mà bỏ
 * trống hệ số thì hệ số rơi về 1: hệ thống hiểu 1 mẻ ra 1 GR, giá 1 GR Sốt Pesto thành giá cả
 * mẻ 368.037 đ, món dùng 50 GR đội lên 18,4 triệu (ASA 11/2026) — và Rã sẽ trừ nguyên liệu của
 * cả mẻ cho từng gram. Module này dùng chung cho form lưu, import và cảnh báo trên màn hình.
 */

function normalizeUnit(value: string | null | undefined) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .replace(/\s+/g, "")
    .toUpperCase();
}

/** Cùng nghĩa "một phần ăn": món Grab mẻ PHAN tồn MON (GR00046 ASA) hệ số 1 là đúng. */
const PORTION_UNITS = new Set(["PHAN", "MON", "SUAT"]);

function sameUnit(batch: string, stock: string) {
  return batch === stock || (PORTION_UNITS.has(batch) && PORTION_UNITS.has(stock));
}

/** ĐVT mẻ dạng "<số><ĐVT tồn>" (650GR, 10 PHAN, 1,5KG khi tồn là KG) → con số đó; khác thì null. */
export function inferOutputConversionRate(batchUnit: string | null | undefined, stockUnit: string | null | undefined) {
  const batch = normalizeUnit(batchUnit);
  const stock = normalizeUnit(stockUnit);
  if (!batch || !stock || !batch.endsWith(stock)) return null;
  const numberPart = batch.slice(0, batch.length - stock.length).replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(numberPart)) return null;
  const rate = Number(numberPart);
  return rate > 0 ? rate : null;
}

/**
 * Hệ số khai (trống / 0 = chưa khai) → hệ số dùng để lưu: khai thì giữ, chưa khai thì suy từ
 * ĐVT mẻ, không suy được thì 1.
 */
export function resolveOutputConversionRate(
  declared: number | null | undefined,
  batchUnit: string | null | undefined,
  stockUnit: string | null | undefined,
) {
  if (declared && declared > 0) return declared;
  return inferOutputConversionRate(batchUnit, stockUnit) ?? 1;
}

/**
 * Mẻ khác ĐVT tồn mà hệ số vẫn 1 thì gần như chắc chắn khai thiếu. Trả câu báo lỗi, ổn thì null.
 */
export function outputConversionRateProblem(
  batchUnit: string | null | undefined,
  stockUnit: string | null | undefined,
  rate: number | null | undefined,
) {
  const batch = normalizeUnit(batchUnit);
  const stock = normalizeUnit(stockUnit);
  if (!batch || !stock || sameUnit(batch, stock)) return null;
  if (rate && rate > 0 && rate !== 1) return null;
  const suggested = inferOutputConversionRate(batchUnit, stockUnit);
  return `Mẻ "${batchUnit}" khác ĐVT tồn "${stockUnit}" nhưng hệ số quy đổi đang là 1 (1 mẻ = 1 ${stockUnit}). `
    + (suggested ? `Khai hệ số ${suggested}` : `Khai 1 mẻ = bao nhiêu ${stockUnit}`)
    + ", hoặc đổi ĐVT mẻ về đúng ĐVT tồn.";
}
