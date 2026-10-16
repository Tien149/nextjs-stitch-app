/**
 * Bộ lọc nhà hàng / kho / khoảng ngày dùng chung cho các tab Kiểm kê, Giải trình, Kết quả và các
 * khung bên dưới (khách yêu cầu 16/10/2026: "lọc ở trên thì ở dưới update theo").
 */
export type StocktakeFilter = { branchCode: string; warehouseCode: string; from: string; to: string };

export const EMPTY_STOCKTAKE_FILTER: StocktakeFilter = { branchCode: "ALL", warehouseCode: "", from: "", to: "" };

/** Ngày (ISO) có nằm trong khoảng lọc không — so theo ngày Việt Nam như lib/date-range. */
export function inStocktakeRange(value: string | null | undefined, filter: Pick<StocktakeFilter, "from" | "to">) {
  if (!filter.from && !filter.to) return true;
  if (!value) return false;
  const day = new Date(new Date(value).getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
  return (!filter.from || day >= filter.from) && (!filter.to || day <= filter.to);
}
