-- AlterTable
ALTER TABLE "AssetRecord" ADD COLUMN     "accumulatedDepreciation" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "warehouseCode" TEXT;

-- CreateIndex
CREATE INDEX "AssetRecord_warehouseCode_idx" ON "AssetRecord"("warehouseCode");
