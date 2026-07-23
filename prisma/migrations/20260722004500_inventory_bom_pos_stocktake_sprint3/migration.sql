-- Sprint 3 inventory BOM/POS/stocktake foundation
ALTER TABLE "RevenueImportRow"
ADD COLUMN "productCode" TEXT,
ADD COLUMN "productQuantity" DOUBLE PRECISION,
ADD COLUMN "inventoryStatus" TEXT;

CREATE INDEX "RevenueImportRow_productCode_idx" ON "RevenueImportRow"("productCode");
CREATE INDEX "RevenueImportRow_inventoryStatus_idx" ON "RevenueImportRow"("inventoryStatus");

CREATE TABLE "StocktakeSession" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "stocktakeDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "branchCode" TEXT NOT NULL,
  "warehouseCode" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "approvedBy" TEXT,
  "approvedAt" TIMESTAMP(3),
  "note" TEXT,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StocktakeSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StocktakeLine" (
  "id" TEXT NOT NULL,
  "stocktakeId" TEXT NOT NULL,
  "itemId" TEXT NOT NULL,
  "systemQuantity" DOUBLE PRECISION NOT NULL,
  "actualQuantity" DOUBLE PRECISION NOT NULL,
  "varianceQuantity" DOUBLE PRECISION NOT NULL,
  "reason" TEXT,
  CONSTRAINT "StocktakeLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StocktakeSession_code_key" ON "StocktakeSession"("code");
CREATE INDEX "StocktakeSession_branchCode_idx" ON "StocktakeSession"("branchCode");
CREATE INDEX "StocktakeSession_warehouseCode_idx" ON "StocktakeSession"("warehouseCode");
CREATE INDEX "StocktakeSession_status_idx" ON "StocktakeSession"("status");
CREATE INDEX "StocktakeSession_stocktakeDate_idx" ON "StocktakeSession"("stocktakeDate");
CREATE INDEX "StocktakeLine_stocktakeId_idx" ON "StocktakeLine"("stocktakeId");
CREATE INDEX "StocktakeLine_itemId_idx" ON "StocktakeLine"("itemId");

ALTER TABLE "StocktakeLine"
ADD CONSTRAINT "StocktakeLine_stocktakeId_fkey"
FOREIGN KEY ("stocktakeId") REFERENCES "StocktakeSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StocktakeLine"
ADD CONSTRAINT "StocktakeLine_itemId_fkey"
FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
