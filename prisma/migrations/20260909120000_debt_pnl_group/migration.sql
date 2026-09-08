-- Nhóm hạng mục P&L cho khoản công nợ PHẢI THU.
-- Khoản phải thu (khách nợ tiền hàng, đối tác trả lại khoản chi hộ) không thuộc một hạng mục
-- chi phí nào, nên popup Thêm công nợ chỉ cho khai tới NHÓM hạng mục P&L. Cột pnlItemCode giữ
-- nguyên cho khoản phải trả; dữ liệu cũ để trống.
-- AlterTable
ALTER TABLE "DebtRecord" ADD COLUMN "pnlGroupCode" TEXT;
