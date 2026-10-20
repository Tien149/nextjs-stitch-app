-- CCDC/tài sản đầu kỳ: ngày nhập + đối tác bán (khách 20/10/2026), đẩy sang AssetRecord.
ALTER TABLE "OpeningBalance" ADD COLUMN IF NOT EXISTS "purchaseDate" TIMESTAMP(3);
ALTER TABLE "OpeningBalance" ADD COLUMN IF NOT EXISTS "partnerCode" TEXT;
ALTER TABLE "OpeningBalance" ADD COLUMN IF NOT EXISTS "partnerName" TEXT;
