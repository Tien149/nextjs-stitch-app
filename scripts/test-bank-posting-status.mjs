/**
 * Lọc dòng sao kê theo TRẠNG THÁI VÀO SỔ (khách yêu cầu 21/09/2026: một ngày nhiều giao dịch,
 * dò bằng mắt xem dòng nào chưa vào sổ thì quá bất tiện).
 *
 * Điều phải giữ: ba trạng thái PHỦ KÍN và KHÔNG CHỒNG LẤN, và bộ lọc phía máy chủ khớp đúng
 * nhãn phía màn hình. Lệch nhau là lọc "Chưa vào sổ" lại ra dòng đang hiện chữ "ĐÃ VÀO SỔ",
 * và người dùng hết tin vào bộ lọc.
 *
 * Chạy: npm run test:bank-posting-status
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  BANK_POSTING_STATUS_LABELS,
  BANK_POSTING_STATUSES,
  bankPostingStatusFilter,
  bankPostingStatusOf,
  isBankPostingStatus,
} from "../lib/bank-posting-status.ts";

/** Đủ mọi tổ hợp hai cột quyết định trạng thái, kể cả những cột lạ. */
const everyRow = [
  { reconcileStatus: "MATCHED", autoProcessType: "MANUAL_REQUIRED" },
  { reconcileStatus: "MATCHED", autoProcessType: null },
  { reconcileStatus: "MATCHED", autoProcessType: "WALLET_SETTLEMENT" },
  { reconcileStatus: "UNMATCHED", autoProcessType: "MANUAL_REQUIRED" },
  { reconcileStatus: "UNMATCHED", autoProcessType: null },
  { reconcileStatus: "UNMATCHED", autoProcessType: "WALLET_SETTLEMENT" },
  { reconcileStatus: "PARTIAL", autoProcessType: null },
];

test("đã nối chứng từ thì luôn là ĐÃ VÀO SỔ, bất kể cột xử lý tự động", () => {
  assert.equal(bankPostingStatusOf({ reconcileStatus: "MATCHED", autoProcessType: "MANUAL_REQUIRED" }), "POSTED");
  assert.equal(bankPostingStatusOf({ reconcileStatus: "MATCHED", autoProcessType: null }), "POSTED");
});

test("chưa nối + đã đánh dấu cần xử tay = CHƯA VÀO SỔ (rổ việc phải làm)", () => {
  assert.equal(bankPostingStatusOf({ reconcileStatus: "UNMATCHED", autoProcessType: "MANUAL_REQUIRED" }), "NOT_POSTED");
});

test("chưa nối nhưng chưa đánh dấu = DỮ LIỆU CŨ, không trộn vào việc hôm nay", () => {
  assert.equal(bankPostingStatusOf({ reconcileStatus: "UNMATCHED", autoProcessType: null }), "LEGACY");
  assert.equal(bankPostingStatusOf({ reconcileStatus: "UNMATCHED", autoProcessType: "WALLET_SETTLEMENT" }), "LEGACY");
});

test("mọi dòng rơi vào đúng MỘT rổ — phủ kín, không chồng lấn", () => {
  for (const row of everyRow) {
    const matched = BANK_POSTING_STATUSES.filter((status) => status === bankPostingStatusOf(row));
    assert.equal(matched.length, 1, `${JSON.stringify(row)} phai thuoc dung mot ro`);
  }
});

test("mỗi trạng thái đều có nhãn hiển thị", () => {
  for (const status of BANK_POSTING_STATUSES) {
    assert.ok(BANK_POSTING_STATUS_LABELS[status], `${status} thieu nhan`);
  }
});

test("bộ lọc LEGACY phải bắt được cả dòng chưa khai cột xử lý", () => {
  // `NOT` của Prisma bỏ luôn dòng NULL, mà dòng chưa được đánh dấu mới đúng là thứ rổ này cần.
  const [filter] = bankPostingStatusFilter("LEGACY");
  assert.deepEqual(filter.OR[0], { autoProcessType: null });
});

test("bộ lọc CHƯA VÀO SỔ đòi đủ hai điều kiện", () => {
  // Thiếu vế `autoProcessType` là rổ này nuốt luôn dữ liệu cũ và danh sách việc phồng lên.
  const [filter] = bankPostingStatusFilter("NOT_POSTED");
  assert.deepEqual(filter, { NOT: { reconcileStatus: "MATCHED" }, autoProcessType: "MANUAL_REQUIRED" });
});

test("giá trị lạ thì không lọc gì, không ném lỗi ra giữa màn hình", () => {
  for (const value of ["", "ABC", "matched", "null", "  "]) {
    assert.deepEqual(bankPostingStatusFilter(value), [], `${value} phai ra mang rong`);
  }
  assert.equal(isBankPostingStatus("ABC"), false);
});

test("nhận mã viết thường (link từ màn khác có thể gửi chữ thường)", () => {
  assert.equal(bankPostingStatusFilter("not_posted").length, 1);
  assert.deepEqual(bankPostingStatusFilter("posted"), [{ reconcileStatus: "MATCHED" }]);
});
