-- Kiểm kê CCDC/tài sản theo bộ phận: phiên kiểm ghi rõ phòng ban (null = kiểm cả cửa hàng).
ALTER TABLE "AssetStocktakeSession" ADD COLUMN IF NOT EXISTS "departmentCode" TEXT;
CREATE INDEX IF NOT EXISTS "AssetStocktakeSession_departmentCode_idx" ON "AssetStocktakeSession"("departmentCode");
