-- Tài sản/CCDC đầu kỳ đang phân bổ dở: nguyên giá, số kỳ và giá trị đã phân bổ trước khi lên hệ thống.
ALTER TABLE "OpeningBalance" ADD COLUMN IF NOT EXISTS "originalCost" DOUBLE PRECISION;
ALTER TABLE "OpeningBalance" ADD COLUMN IF NOT EXISTS "depreciatedPeriods" INTEGER;
ALTER TABLE "OpeningBalance" ADD COLUMN IF NOT EXISTS "depreciatedAmount" DOUBLE PRECISION;
ALTER TABLE "AssetRecord" ADD COLUMN IF NOT EXISTS "openingDepreciatedPeriods" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AssetRecord" ADD COLUMN IF NOT EXISTS "openingBalanceId" TEXT;
