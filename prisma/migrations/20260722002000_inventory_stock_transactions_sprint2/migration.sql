-- Sprint 2 inventory stock transaction normalization
ALTER TABLE "InventoryTransaction"
ADD COLUMN "importBatchId" TEXT,
ADD COLUMN "toWarehouseCode" TEXT;

ALTER TABLE "InventoryTransactionLine"
ADD COLUMN "inputQuantity" DOUBLE PRECISION,
ADD COLUMN "inputUnitCode" TEXT,
ADD COLUMN "conversionRate" DOUBLE PRECISION NOT NULL DEFAULT 1,
ADD COLUMN "inputUnitCost" DOUBLE PRECISION;

UPDATE "InventoryTransactionLine"
SET "inputQuantity" = "quantity",
    "conversionRate" = 1,
    "inputUnitCost" = "unitCost"
WHERE "inputQuantity" IS NULL;

CREATE INDEX "InventoryTransaction_importBatchId_idx" ON "InventoryTransaction"("importBatchId");
CREATE INDEX "InventoryTransaction_toWarehouseCode_idx" ON "InventoryTransaction"("toWarehouseCode");

ALTER TABLE "InventoryTransaction"
ADD CONSTRAINT "InventoryTransaction_importBatchId_fkey"
FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
