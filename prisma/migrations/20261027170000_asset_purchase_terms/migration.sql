-- Phiếu mua tài sản/CCDC: số phiếu (in gộp) + chi tiết đơn giá, chiết khấu, thuế, chi phí mua (khách 27/10/2026).
ALTER TABLE "AssetRecord" ADD COLUMN "purchaseDocCode" TEXT;
ALTER TABLE "AssetRecord" ADD COLUMN "unitPrice" DOUBLE PRECISION;
ALTER TABLE "AssetRecord" ADD COLUMN "discountRate" DOUBLE PRECISION;
ALTER TABLE "AssetRecord" ADD COLUMN "discountAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "AssetRecord" ADD COLUMN "vatRate" DOUBLE PRECISION;
ALTER TABLE "AssetRecord" ADD COLUMN "vatAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "AssetRecord" ADD COLUMN "purchaseCostShare" DOUBLE PRECISION NOT NULL DEFAULT 0;
CREATE INDEX "AssetRecord_purchaseDocCode_idx" ON "AssetRecord"("purchaseDocCode");
