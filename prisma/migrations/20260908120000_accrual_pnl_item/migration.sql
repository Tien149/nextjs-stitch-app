-- Hạng mục P&L cho khoản trích trước / phân bổ.
-- Bút toán phân bổ hàng kỳ trước đây chỉ mang khoản mục thu/chi nên rơi vào nhóm "chưa phân
-- loại hạng mục P&L" trên tab Tổng hợp chi phí. Để trống với dữ liệu cũ; kế toán khai bổ sung
-- rồi chạy lại hạch toán kỳ là bút toán tự cập nhật.
-- AlterTable
ALTER TABLE "Accrual" ADD COLUMN "pnlItemCode" TEXT;
