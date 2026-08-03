-- Ghi nhận ca làm việc của phiếu thu/chi để báo cáo Thu chi ngày xếp đúng ca,
-- thay vì suy ra từ giờ của ngày lập phiếu (luôn là 00:00 khi nhập tay).
ALTER TABLE "FinancialVoucher" ADD COLUMN "shift" TEXT;
CREATE INDEX "FinancialVoucher_shift_idx" ON "FinancialVoucher"("shift");
