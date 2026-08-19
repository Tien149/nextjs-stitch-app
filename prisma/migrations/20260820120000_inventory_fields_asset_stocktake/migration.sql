-- 1) Ghi chú của định lượng: cột "Ghi chu" trên file import BOM trước đây không có chỗ chứa.
ALTER TABLE "Recipe" ADD COLUMN "note" TEXT;

-- 2) NCC/Đối tượng trên phiếu kho: cột "NCC / Doi tuong" trên file import trước đây bị nuốt im lặng.
ALTER TABLE "InventoryTransaction" ADD COLUMN "partnerCode" TEXT;
CREATE INDEX "InventoryTransaction_partnerCode_idx" ON "InventoryTransaction"("partnerCode");

-- 3) Kiểm kê CCDC & Tài sản — hàng hoá kiểm ở Kho, CCDC/tài sản kiểm ở Tài sản & khấu hao.
CREATE TABLE "AssetStocktakeSession" (
    "id" TEXT NOT NULL,
    "importBatchId" TEXT,
    "code" TEXT NOT NULL,
    "stocktakeDate" TIMESTAMP(3) NOT NULL,
    "branchCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'APPROVED',
    "note" TEXT,
    "createdBy" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "AssetStocktakeSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AssetStocktakeSession_code_key" ON "AssetStocktakeSession"("code");
CREATE INDEX "AssetStocktakeSession_branchCode_idx" ON "AssetStocktakeSession"("branchCode");
CREATE INDEX "AssetStocktakeSession_stocktakeDate_idx" ON "AssetStocktakeSession"("stocktakeDate");
CREATE INDEX "AssetStocktakeSession_deletedAt_idx" ON "AssetStocktakeSession"("deletedAt");

ALTER TABLE "AssetStocktakeSession" ADD CONSTRAINT "AssetStocktakeSession_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "AssetStocktakeLine" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "systemQuantity" DOUBLE PRECISION NOT NULL,
    "actualQuantity" DOUBLE PRECISION NOT NULL,
    "varianceQuantity" DOUBLE PRECISION NOT NULL,
    "condition" TEXT,
    "note" TEXT,

    CONSTRAINT "AssetStocktakeLine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AssetStocktakeLine_sessionId_idx" ON "AssetStocktakeLine"("sessionId");
CREATE INDEX "AssetStocktakeLine_assetId_idx" ON "AssetStocktakeLine"("assetId");

ALTER TABLE "AssetStocktakeLine" ADD CONSTRAINT "AssetStocktakeLine_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AssetStocktakeSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssetStocktakeLine" ADD CONSTRAINT "AssetStocktakeLine_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "AssetRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
