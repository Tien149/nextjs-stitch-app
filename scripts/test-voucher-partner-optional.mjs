import assert from "node:assert/strict";
import test from "node:test";
import {
  ADVANCE_RECEIVABLE_ACTION,
  isUndeclaredPartnerName,
  PREPAID_ALLOCATION_ACTION,
  UNDECLARED_PARTNER_NAME,
  voucherPartnerRequirement,
} from "../lib/voucher-rules.ts";

/**
 * Import sao kê vốn cho phép dòng không có đối tác (phí ngân hàng, phí duy trì, lãi tiền gửi:
 * đưa thẳng vào P&L, không có ai để theo dõi công nợ). Lập phiếu lẻ phải mở đúng như vậy —
 * nhưng chỉ ở đúng những nghiệp vụ đó, không mở toang cho cả phiếu công nợ và tiền cọc.
 */
test("khoản chi thẳng vào P&L không bắt buộc đối tác", () => {
  assert.equal(voucherPartnerRequirement({ category: { code: "CHI_PHI_NGAN_HANG", name: "Chi phí ngân hàng" } }), null);
  assert.equal(voucherPartnerRequirement({ category: { code: "CHI_DIEN_NUOC", name: "Chi điện nước" } }), null);
  assert.equal(voucherPartnerRequirement({}), null);
  // Chi trả trước chỉ là chuyện phân bổ nhiều kỳ, không đụng sổ nợ của ai.
  assert.equal(voucherPartnerRequirement({ debtAction: PREPAID_ALLOCATION_ACTION }), null);
});

test("nghiệp vụ đụng sổ nợ hoặc sổ cọc vẫn bắt buộc đối tác", () => {
  assert.match(voucherPartnerRequirement({ category: { code: "THU_CONGNO_KHACH", name: "Thu công nợ khách hàng" } }), /công nợ/);
  assert.match(voucherPartnerRequirement({ category: { code: "CHI_HOAN_COC", name: "Hoàn cọc cho khách" } }), /tiền cọc/);
  assert.match(voucherPartnerRequirement({ depositAction: "COLLECT" }), /tiền cọc/);
  assert.match(voucherPartnerRequirement({ debtAction: "SETTLE" }), /gạch công nợ/);
  // Chi hộ dùng đối tác này làm vế Nợ 331 ở sổ nhà hàng được chi hộ.
  assert.match(voucherPartnerRequirement({ debtAction: ADVANCE_RECEIVABLE_ACTION }), /chi hộ/);
});

test("tên 'Chưa khai đối tác' là chỗ trống, không phải một đối tác thật", () => {
  assert.equal(isUndeclaredPartnerName(UNDECLARED_PARTNER_NAME), true);
  assert.equal(isUndeclaredPartnerName("  chưa khai đối tác  "), true);
  assert.equal(isUndeclaredPartnerName("Công ty TNHH Thực Phẩm"), false);
  assert.equal(isUndeclaredPartnerName(""), false);
  assert.equal(isUndeclaredPartnerName(null), false);
});
