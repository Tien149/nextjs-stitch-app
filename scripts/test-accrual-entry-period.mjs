/**
 * Bút toán cuối kỳ (khấu hao, phân bổ trả trước) phải đứng ĐÚNG KỲ của nó.
 *
 * Trước 21/09/2026 bút toán phân bổ lấy `postedAt` — lúc kế toán bấm "Ghi nhận phân bổ" — làm
 * ngày ghi sổ. Bấm trễ sang tháng sau là cả khoản nhảy sang tháng đó: kỳ phân bổ ghi 2026-08
 * mà chi phí lên Tổng hợp chi phí và P&L của tháng 9 (khách báo: tiền thuê mặt bằng GS25
 * 47.021.700 đ của kỳ 08 hiện ở tháng 9).
 *
 * Chạy: npm run test:accrual-entry-period
 */
import test from "node:test";
import assert from "node:assert/strict";
import { periodClosingEntryDate } from "../lib/accounting.ts";
import { periodFromDate } from "../lib/phase3.ts";

test("ngày ghi sổ luôn rơi đúng vào kỳ của nó, cả 12 tháng", () => {
  for (let month = 1; month <= 12; month += 1) {
    const period = `2026-${String(month).padStart(2, "0")}`;
    assert.equal(periodFromDate(periodClosingEntryDate(period)), period, `kỳ ${period} lệch tháng`);
  }
});

test("tháng 2 (tháng ngắn nhất) vẫn có ngày 28", () => {
  const date = periodClosingEntryDate("2026-02");
  assert.equal(date.getMonth() + 1, 2);
  assert.equal(date.getDate(), 28);
});

test("năm nhuận và cuối năm không tràn kỳ", () => {
  assert.equal(periodFromDate(periodClosingEntryDate("2028-02")), "2028-02");
  assert.equal(periodFromDate(periodClosingEntryDate("2026-12")), "2026-12");
  assert.equal(periodFromDate(periodClosingEntryDate("2027-01")), "2027-01");
});

test("hàm chỉ nhận KỲ, không có đường nào nhét ngày bấm nút vào", () => {
  // Chữ ký một tham số là chốt chặn: muốn lấy postedAt làm ngày ghi sổ thì phải sửa hàm này,
  // không lỡ tay truyền nhầm được.
  assert.equal(periodClosingEntryDate.length, 1);
});
