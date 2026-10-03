/**
 * Khoảng hiệu lực của từng phiên bản định lượng — cùng luật với pickRecipeForDate
 * (lib/production-explosion.ts): trong một PHẠM VI (mã món + cửa hàng, rỗng = dùng chung), phiên
 * bản áp dụng từ ngày effectiveFrom của nó tới hết ngày trước phiên bản kế tiếp; trùng ngày thì
 * version lớn hơn thắng, bản nhỏ coi như không áp dụng ngày nào.
 *
 * Khách hỏi 03/10/2026: định lượng món A áp dụng từ 01/08 mà tháng 9 không sửa thì vẫn là định
 * lượng của tháng 9 — lọc theo tháng phải ra nó. Đổi giá bán / định lượng giữa tháng = sao chép
 * thành phiên bản mới có ngày áp dụng mới, nên một tháng có thể có nhiều phiên bản nối tiếp nhau.
 *
 * Ngày so theo NGÀY VIỆT NAM (YYYY-MM-DD) để effectiveFrom lưu 00:00 UTC hay 17:00 UTC hôm trước
 * đều ra đúng một ngày.
 */
export type RecipeValidityInput = {
  id: string;
  productCode: string;
  branchCode?: string | null;
  version: number;
  effectiveFrom: Date | string;
};

/** from: ngày bắt đầu áp dụng; to: ngày cuối còn áp dụng (null = tới nay). Ngày dạng YYYY-MM-DD. */
export type RecipeValidity = { from: string; to: string | null };

const DAY_MS = 24 * 60 * 60 * 1000;

/** Ngày Việt Nam (UTC+7) của một mốc thời gian, dạng YYYY-MM-DD. */
export function vnDay(value: Date | string): string {
  return new Date(new Date(value).getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function previousDay(day: string) {
  return new Date(Date.parse(`${day}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
}

/** Tháng YYYY-MM → ngày đầu / ngày cuối tháng (YYYY-MM-DD). */
export function monthDays(month: string) {
  const [year, monthNo] = month.split("-").map(Number);
  const first = `${month}-01`;
  const last = new Date(Date.UTC(year, monthNo, 0)).toISOString().slice(0, 10);
  return { first, last };
}

const scopeKey = (recipe: RecipeValidityInput) => `${recipe.productCode.trim().toUpperCase()}|${(recipe.branchCode || "").trim().toUpperCase()}`;

export function recipeValidity(recipes: RecipeValidityInput[]): Map<string, RecipeValidity | null> {
  const byScope = new Map<string, RecipeValidityInput[]>();
  for (const recipe of recipes) {
    const key = scopeKey(recipe);
    byScope.set(key, [...(byScope.get(key) || []), recipe]);
  }
  const result = new Map<string, RecipeValidity | null>();
  for (const versions of byScope.values()) {
    const sorted = [...versions].sort((a, b) => vnDay(a.effectiveFrom).localeCompare(vnDay(b.effectiveFrom)) || a.version - b.version);
    sorted.forEach((recipe, index) => {
      const from = vnDay(recipe.effectiveFrom);
      const next = sorted.slice(index + 1).find((candidate) => vnDay(candidate.effectiveFrom) >= from);
      if (next && vnDay(next.effectiveFrom) === from) {
        result.set(recipe.id, null);
        return;
      }
      result.set(recipe.id, { from, to: next ? previousDay(vnDay(next.effectiveFrom)) : null });
    });
  }
  return result;
}

/** Phần giao giữa khoảng hiệu lực và tháng; null = phiên bản không áp dụng ngày nào trong tháng. */
export function validityInMonth(validity: RecipeValidity | null | undefined, month: string): RecipeValidity | null {
  if (!validity) return null;
  const { first, last } = monthDays(month);
  if (validity.from > last) return null;
  if (validity.to && validity.to < first) return null;
  return { from: validity.from > first ? validity.from : first, to: !validity.to || validity.to > last ? last : validity.to };
}
