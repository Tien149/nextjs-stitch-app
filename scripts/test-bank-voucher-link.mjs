/**
 * Nối tay dòng sao kê với chứng từ ngân hàng đã có.
 *
 * Khách báo 21/09/2026: dòng chi lương / chi bảo hiểm mang nhãn "CHƯA VÀO SỔ" kèm lời nhắn
 * "Phiếu UNC-... đã bị xóa; chờ đối soát thủ công" nhưng KHÔNG có nút nào để xử — nút "Vào sổ"
 * cũ chỉ hiện cho dòng tiền VÀO của nghiệp vụ Quyết toán ví.
 *
 * Bốn cửa chặn dưới đây phải đứng vững: mở sai cửa nào cũng là tiền vào sổ sai chỗ hoặc sai
 * chiều, mà dòng sao kê thì trông vẫn "đã vào sổ" nên không ai soát lại.
 *
 * Chạy: npm run test:bank-voucher-link
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  bankRowAmount,
  bankRowDirection,
  bankVoucherLinkError,
  pickVoucherCandidates,
} from "../lib/bank-voucher-link.ts";

const dongChi = { branchCode: "HCM", debitAmount: 28000000, creditAmount: 0 };
const dongThu = { branchCode: "HCM", debitAmount: 0, creditAmount: 28000000 };

const phieuChi = {
  id: "v1", code: "UNC-2608-HCM-00001", voucherType: "PAYMENT", status: "APPROVED",
  branchCode: "HCM", amount: 28000000, documentChannel: "BANK",
};

test("chiều tiền đọc theo cột: Ghi Nợ = tiền ra, Ghi Có = tiền vào", () => {
  assert.equal(bankRowDirection(dongChi), "PAYMENT");
  assert.equal(bankRowDirection(dongThu), "RECEIPT");
  assert.equal(bankRowAmount(dongChi), 28000000);
  assert.equal(bankRowAmount(dongThu), 28000000);
});

test("chứng từ đúng chiều, đúng tiền, đúng cửa hàng thì nối được", () => {
  assert.equal(bankVoucherLinkError(dongChi, phieuChi), null);
});

test("chặn nối NGƯỢC CHIỀU", () => {
  // Nối phiếu thu vào dòng chi là số dư ngân hàng đi sai hướng đúng hai lần số tiền.
  const loi = bankVoucherLinkError(dongChi, { ...phieuChi, voucherType: "RECEIPT", code: "UNT-01" });
  assert.match(loi, /tiền RA/);
  assert.match(loi, /phiếu CHI/);
  const loiNguoc = bankVoucherLinkError(dongThu, phieuChi);
  assert.match(loiNguoc, /tiền VÀO/);
});

test("chặn nối chứng từ KHÁC SỐ TIỀN", () => {
  const loi = bankVoucherLinkError(dongChi, { ...phieuChi, amount: 24000000 });
  assert.match(loi, /24\.000\.000/);
  assert.match(loi, /28\.000\.000/);
});

test("chặn nối chứng từ của CỬA HÀNG KHÁC", () => {
  assert.match(bankVoucherLinkError(dongChi, { ...phieuChi, branchCode: "HN" }), /cửa hàng khác/);
});

test("chặn nối phiếu TIỀN MẶT vào dòng sao kê ngân hàng", () => {
  assert.match(bankVoucherLinkError(dongChi, { ...phieuChi, documentChannel: "CASH" }), /tiền mặt/);
});

test("chặn nối chứng từ CHƯA DUYỆT", () => {
  assert.match(bankVoucherLinkError(dongChi, { ...phieuChi, status: "DRAFT" }), /chưa được duyệt/);
});

test("chứng từ đã nối dòng khác thì không chào lại", () => {
  // Chào lại là hai dòng sao kê cùng trỏ một phiếu, tiền ghi nhận hai lần.
  assert.deepEqual(pickVoucherCandidates(dongChi, [phieuChi], new Set(["v1"])), []);
  assert.deepEqual(pickVoucherCandidates(dongChi, [phieuChi], new Set()), [phieuChi]);
});

test("danh sách ứng viên loại sạch mọi chứng từ không hợp lệ", () => {
  const vouchers = [
    phieuChi,
    { ...phieuChi, id: "v2", code: "UNT-02", voucherType: "RECEIPT" },
    { ...phieuChi, id: "v3", code: "UNC-03", amount: 1 },
    { ...phieuChi, id: "v4", code: "UNC-04", branchCode: "HN" },
    { ...phieuChi, id: "v5", code: "PTHU-05", documentChannel: "CASH" },
    { ...phieuChi, id: "v6", code: "UNC-06", status: "DRAFT" },
  ];
  assert.deepEqual(pickVoucherCandidates(dongChi, vouchers, new Set()).map((row) => row.id), ["v1"]);
});
