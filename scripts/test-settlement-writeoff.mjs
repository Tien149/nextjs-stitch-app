/**
 * Khoản chênh "khách trả thiếu" đẩy từ bảng "Tiền về đủ chưa" vào chi phí.
 *
 * Khách chốt 21/09/2026, hai luật:
 *  1. KHÔNG trừ vào quỹ / số dư nguồn tiền. Tiền vào của nguồn ngân hàng & ví đọc thẳng sổ
 *     sao kê nên đã là số THỰC NHẬN; trừ thêm phần chênh là trừ khống, số dư tụt xuống dưới
 *     cả sao kê. Nguyên văn: "không có tiền vào sao trừ ra được".
 *  2. VẪN lên Tổng hợp chi phí và P&L — bảng đó đọc dòng Nợ tài khoản chi phí trên sổ nhật ký,
 *     nên bút toán phải còn nguyên.
 *
 * Chạy: npm run test:settlement-writeoff
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  adjustmentMovesCash,
  CASH_MOVING_ADJUSTMENT_FILTER,
  REVENUE_SETTLEMENT_WRITEOFF_SOURCE,
} from "../lib/revenue-settlement-writeoff.ts";

test("khoản chênh đẩy vào chi phí không được tính là tiền ra khỏi quỹ", () => {
  assert.equal(adjustmentMovesCash({ sourceType: REVENUE_SETTLEMENT_WRITEOFF_SOURCE }), false);
});

test("phiếu điều chỉnh quỹ bình thường vẫn chạm quỹ như cũ", () => {
  // Phiếu kế toán lập tay ở màn Sổ quỹ là tiền thật ra/vào — đụng vào là sai số dư hàng loạt.
  assert.equal(adjustmentMovesCash({ sourceType: null }), true);
  assert.equal(adjustmentMovesCash({ sourceType: undefined }), true);
  assert.equal(adjustmentMovesCash({}), true);
  assert.equal(adjustmentMovesCash({ sourceType: "MANUAL" }), true);
});

test("bộ lọc Prisma giữ lại cả phiếu chưa có sourceType", () => {
  // Phiếu lập trước 21/09/2026 mang sourceType NULL. Lọc bằng `{ not: ... }` trần thì Postgres
  // loại luôn các dòng NULL và cả sổ quỹ cũ biến mất — phải có nhánh `null` đi kèm.
  const branches = CASH_MOVING_ADJUSTMENT_FILTER.OR;
  assert.equal(branches.length, 2);
  assert.deepEqual(branches[0], { sourceType: null });
  assert.deepEqual(branches[1], { sourceType: { not: REVENUE_SETTLEMENT_WRITEOFF_SOURCE } });
});

test("mã nguồn khớp đúng mã đang ghi xuống database", () => {
  // Lệch một ký tự là khoản chênh lại chui vào sổ quỹ mà không ai thấy.
  assert.equal(REVENUE_SETTLEMENT_WRITEOFF_SOURCE, "REVENUE_SETTLEMENT");
});
