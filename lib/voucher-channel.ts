import { normalizeMoneySourceGroup } from "@/lib/money-sources";

export type VoucherDocumentChannel = "CASH" | "BANK";
export type VoucherBusinessEffect = "RECOGNITION" | "SETTLEMENT";

export function normalizeVoucherDocumentChannel(value: unknown): VoucherDocumentChannel {
  return String(value || "").trim().toUpperCase() === "BANK" ? "BANK" : "CASH";
}

export function normalizeVoucherBusinessEffect(value: unknown): VoucherBusinessEffect {
  return String(value || "").trim().toUpperCase() === "SETTLEMENT" ? "SETTLEMENT" : "RECOGNITION";
}

export function moneySourceMatchesDocumentChannel(group: string | null | undefined, channel: VoucherDocumentChannel) {
  return normalizeMoneySourceGroup(group) === channel;
}

export function voucherChannelLabel(channel: VoucherDocumentChannel) {
  return channel === "BANK" ? "Chứng từ ngân hàng" : "Phiếu thu/chi tiền mặt";
}

export function voucherTypeLabel(voucherType: string, channel: VoucherDocumentChannel) {
  if (channel === "BANK") return voucherType === "PAYMENT" ? "Ủy nhiệm chi" : "Ủy nhiệm thu";
  return voucherType === "PAYMENT" ? "Phiếu chi" : "Phiếu thu";
}
