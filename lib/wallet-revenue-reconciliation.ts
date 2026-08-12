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

const walletKeywords = ["momo", "grab", "vnpay", "shopee", "quet the"];

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

export function revenueMatchesWalletSource(row: WalletPosRevenue, source: WalletMoneySource) {
  const sourceValues = [normalizeWalletText(source.code), normalizeWalletText(source.name)];
  const rowValues = [normalizeWalletText(row.paymentMethod), normalizeWalletText(row.revenueSource), normalizeWalletText(row.channel || "")];
  if (rowValues.some((value) => value && sourceValues.includes(value))) return true;
  return walletKeywords.some((keyword) => sourceValues.some((value) => value.includes(keyword))
    && rowValues.some((value) => value.includes(keyword)));
}

export function selectWalletDeclaredRevenue(input: {
  posRows: WalletPosRevenue[];
  manualRows: WalletManualRevenue[];
  bucketSources: WalletMoneySource[];
  bucket: WalletRevenueBucket;
}) {
  // POS is authoritative for the whole branch/day. Manual revenue is only a fallback
  // when the day has no POS rows at all, never a supplement to partial POS data.
  if (input.posRows.length > 0) {
    return {
      source: "POS" as WalletRevenueSource,
      amount: Math.round(input.posRows
        .filter((row) => input.bucketSources.some((source) => revenueMatchesWalletSource(row, source)))
        .reduce((sum, row) => sum + row.netAmount, 0)),
    };
  }

  if (input.manualRows.length > 0) {
    const field = input.bucket === "GRAB" ? "grabAmount" : "cardAmount";
    return {
      source: "MANUAL" as WalletRevenueSource,
      amount: Math.round(input.manualRows.reduce((sum, row) => sum + row[field], 0)),
    };
  }

  return { source: "NONE" as WalletRevenueSource, amount: 0 };
}

export function remainingWalletGross(declared: number, allocated: number) {
  return Math.max(0, Math.round(declared - allocated));
}
