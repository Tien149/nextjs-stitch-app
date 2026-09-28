-- Giờ bán trên dòng doanh thu POS (khách chốt 28/09/2026): rã nguyên liệu tới đúng giờ chốt kiểm kê.
ALTER TABLE "RevenueImportRow" ADD COLUMN IF NOT EXISTS "saleHour" INTEGER;
CREATE INDEX IF NOT EXISTS "RevenueImportRow_saleDate_saleHour_idx" ON "RevenueImportRow"("saleDate", "saleHour");
