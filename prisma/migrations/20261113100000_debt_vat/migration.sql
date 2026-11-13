-- Công nợ khai tay tách thuế GTGT (khách 13/11/2026): trước thuế, thuế suất, tiền thuế.
-- originalAmount vẫn là số SAU thuế, báo cáo không đổi cách đọc.
ALTER TABLE "DebtRecord" ADD COLUMN IF NOT EXISTS "amountBeforeTax" DOUBLE PRECISION;
ALTER TABLE "DebtRecord" ADD COLUMN IF NOT EXISTS "vatRate" DOUBLE PRECISION;
ALTER TABLE "DebtRecord" ADD COLUMN IF NOT EXISTS "vatAmount" DOUBLE PRECISION;
