-- Hạng mục P&L khai ngay ở số dư đầu kỳ chi phí phân bổ.
-- Trước đây chỉ khoản phân bổ (Accrual) mới có cột này, nên kế toán khai xong số dư đầu kỳ
-- còn phải mở tab Trích trước gán lại hạng mục cho từng khoản. Để trống với dữ liệu cũ.
-- AlterTable
ALTER TABLE "OpeningBalance" ADD COLUMN "pnlItemCode" TEXT;
