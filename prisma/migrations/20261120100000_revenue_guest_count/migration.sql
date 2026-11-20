-- Lượt khách trên dòng doanh thu POS (khách 20/11/2026): cột Số khách của file POS, cho báo cáo Lượt khách.
ALTER TABLE "RevenueImportRow" ADD COLUMN IF NOT EXISTS "guestCount" INTEGER;
