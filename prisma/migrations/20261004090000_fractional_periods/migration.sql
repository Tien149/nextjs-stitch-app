-- Số kỳ phân bổ / khấu hao cho số lẻ 2 chữ số thập phân (khách yêu cầu 03/10/2026).
ALTER TABLE "OpeningBalance" ALTER COLUMN "allocationMonths" TYPE DOUBLE PRECISION;
ALTER TABLE "OpeningBalance" ALTER COLUMN "depreciatedPeriods" TYPE DOUBLE PRECISION;
ALTER TABLE "FinancialVoucher" ALTER COLUMN "allocationMonths" TYPE DOUBLE PRECISION;
ALTER TABLE "DebtRecord" ALTER COLUMN "allocationMonths" TYPE DOUBLE PRECISION;
ALTER TABLE "Accrual" ALTER COLUMN "numberOfPeriods" TYPE DOUBLE PRECISION;
ALTER TABLE "AssetRecord" ALTER COLUMN "openingDepreciatedPeriods" TYPE DOUBLE PRECISION;
ALTER TABLE "AssetRecord" ALTER COLUMN "usefulLifeMonths" TYPE DOUBLE PRECISION;
