-- Kiểm kê hai bước (khách yêu cầu 28/09/2026): nhà hàng Gửi duyệt -> kế toán Duyệt / Trả lại.
ALTER TABLE "StocktakeLine" ADD COLUMN IF NOT EXISTS "unitCost" DOUBLE PRECISION;
ALTER TABLE "StocktakeSession" ADD COLUMN IF NOT EXISTS "returnedReason" TEXT;
ALTER TABLE "StocktakeSession" ADD COLUMN IF NOT EXISTS "returnedBy" TEXT;
ALTER TABLE "StocktakeSession" ADD COLUMN IF NOT EXISTS "returnedAt" TIMESTAMP(3);
ALTER TABLE "AssetStocktakeSession" ADD COLUMN IF NOT EXISTS "returnedReason" TEXT;
ALTER TABLE "AssetStocktakeSession" ADD COLUMN IF NOT EXISTS "returnedBy" TEXT;
ALTER TABLE "AssetStocktakeSession" ADD COLUMN IF NOT EXISTS "returnedAt" TIMESTAMP(3);
