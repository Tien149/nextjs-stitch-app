export type WalletRevenueBucket = "CARD_WALLET" | "GRAB";
export type WalletRevenueSource = "POS" | "MANUAL" | "NONE";

export type WalletMoneySource = { code: string; name: string };
export type WalletPosRevenue = {
  paymentMethod: string;
  revenueSource: string;
  channel: string | null;
  netAmount: number;
};
export type WalletManualRevenue = { cardAmount: number; grabAmount: number };

/**
 * Nhóm từ đồng nghĩa để dò ví: dòng doanh thu và nguồn tiền chỉ cần chạm CÙNG MỘT NHÓM là
 * khớp, không bắt buộc trùng đúng chữ.
 *
 * Nhóm thẻ phải có cả "pos" lẫn "quet the": doanh thu POS ghi hình thức "Quẹt thẻ", còn tên
 * nguồn tiền nay đã bỏ cụm "quẹt thẻ" (xem stripMoneySourceLabel trong lib/money-sources.ts)
 * nên chỉ còn chữ "POS" để bám. Trước đây danh sách phẳng đòi hai bên cùng chứa một chuỗi,
 * đổi tên nguồn tiền là mất khớp âm thầm.
 */
const walletKeywordGroups = [["momo"], ["grab"], ["vnpay"], ["shopee"], ["quet the", "pos", "card"]];

function normalizeWalletText(value: string) {
  return value.trim().toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function walletRevenueBucket(source: WalletMoneySource): WalletRevenueBucket {
  const value = normalizeWalletText(`${source.code} ${source.name}`);
  return value.includes("grab") ? "GRAB" : "CARD_WALLET";
}

/**
 * Dòng doanh thu chỉ đích danh một nguồn tiền: ghi đúng tên, đúng mã, hoặc ghi mã rút gọn mà
 * mã nguồn tiền nối dài thêm ("MOMO_EDC" so với "MOMO_EDC_FDS"). Đây là mức nhận diện chắc
 * chắn, khác hẳn kiểu đoán theo từ khoá bên dưới.
 */
export function revenueMatchesWalletSourceDefinitely(row: WalletPosRevenue, source: WalletMoneySource) {
  const sourceValues = [normalizeWalletText(source.code), normalizeWalletText(source.name)];
  const rowValues = [normalizeWalletText(row.paymentMethod), normalizeWalletText(row.revenueSource), normalizeWalletText(row.channel || "")];
  return rowValues.some((value) => value
    && (sourceValues.includes(value) || sourceValues.some((candidate) => candidate.startsWith(`${value} `))));
}

export function revenueMatchesWalletSource(row: WalletPosRevenue, source: WalletMoneySource) {
  if (revenueMatchesWalletSourceDefinitely(row, source)) return true;
  const sourceValues = [normalizeWalletText(source.code), normalizeWalletText(source.name)];
  const rowValues = [normalizeWalletText(row.paymentMethod), normalizeWalletText(row.revenueSource), normalizeWalletText(row.channel || "")];
  return walletKeywordGroups.some((group) => group.some((keyword) => sourceValues.some((value) => value.includes(keyword)))
    && group.some((keyword) => rowValues.some((value) => value.includes(keyword))));
}

/**
 * Xác định một dòng doanh thu thuộc về ví nào, khi trong cùng ngày còn có ví khác cùng nhóm.
 *
 * Dòng nào chỉ đích danh một ví thì chỉ thuộc về ví đó — nhờ vậy "ASA - Quẹt Thẻ Momo" và
 * "KCF - Quẹt Thẻ Momo" tách được cho hai cửa hàng. Chỉ khi không ví nào được chỉ đích danh mới
 * dùng tới từ khoá ("momo", "grab"...), và lúc đó nếu nhiều ví cùng khớp thì coi là không
 * phân định được.
 */
export function walletOwnsRevenueRow(
  row: WalletPosRevenue,
  mineSources: WalletMoneySource[],
  rivalSources: WalletMoneySource[],
) {
  const exactMine = mineSources.some((source) => revenueMatchesWalletSourceDefinitely(row, source));
  const exactRival = rivalSources.some((source) => revenueMatchesWalletSourceDefinitely(row, source));
  if (exactMine || exactRival) return { mine: exactMine, contested: exactMine && exactRival };
  const looseMine = mineSources.some((source) => revenueMatchesWalletSource(row, source));
  const looseRival = rivalSources.some((source) => revenueMatchesWalletSource(row, source));
  return { mine: looseMine, contested: looseMine && looseRival };
}

export function selectWalletDeclaredRevenue(input: {
  posRows: WalletPosRevenue[];
  manualRows: WalletManualRevenue[];
  bucketSources: WalletMoneySource[];
  bucket: WalletRevenueBucket;
  /** Các ví khác cùng cửa hàng, cùng ngày, cùng nhóm — để biết doanh thu có bị tranh không. */
  rivalSources?: WalletMoneySource[];
}) {
  const rivalSources = input.rivalSources || [];

  // POS is authoritative for the whole branch/day. Manual revenue is only a fallback
  // when the day has no POS rows at all, never a supplement to partial POS data.
  if (input.posRows.length > 0) {
    let amount = 0;
    let contested = false;
    for (const row of input.posRows) {
      const owns = walletOwnsRevenueRow(row, input.bucketSources, rivalSources);
      if (!owns.mine) continue;
      if (owns.contested) contested = true;
      amount += row.netAmount;
    }
    return { source: "POS" as WalletRevenueSource, amount: Math.round(amount), contested };
  }

  if (input.manualRows.length > 0) {
    const field = input.bucket === "GRAB" ? "grabAmount" : "cardAmount";
    return {
      source: "MANUAL" as WalletRevenueSource,
      amount: Math.round(input.manualRows.reduce((sum, row) => sum + row[field], 0)),
      // Số thu ngân khai chỉ có tổng theo nhóm, không tách được cho từng ví.
      contested: rivalSources.length > 0,
    };
  }

  return { source: "NONE" as WalletRevenueSource, amount: 0, contested: false };
}

export function remainingWalletGross(declared: number, allocated: number) {
  return Math.max(0, Math.round(declared - allocated));
}
