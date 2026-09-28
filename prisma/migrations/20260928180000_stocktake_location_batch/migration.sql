-- Kiểm kê theo VỊ TRÍ + duyệt GỘP theo giờ chốt (khách chốt 28/09/2026) — lib/stocktake-batch.ts.
ALTER TABLE "StocktakeSession" ADD COLUMN IF NOT EXISTS "locationCode" TEXT;
ALTER TABLE "StocktakeSession" ADD COLUMN IF NOT EXISTS "batchId" TEXT;
ALTER TABLE "StocktakeLine" ADD COLUMN IF NOT EXISTS "unitInputs" TEXT;

CREATE TABLE IF NOT EXISTS "StocktakeLocation" (
    "id" TEXT NOT NULL,
    "branchCode" TEXT NOT NULL,
    "warehouseCode" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StocktakeLocation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "StocktakeLocation_warehouseCode_code_key" ON "StocktakeLocation"("warehouseCode", "code");
CREATE INDEX IF NOT EXISTS "StocktakeLocation_branchCode_idx" ON "StocktakeLocation"("branchCode");
CREATE INDEX IF NOT EXISTS "StocktakeLocation_status_idx" ON "StocktakeLocation"("status");

CREATE TABLE IF NOT EXISTS "StocktakeLocationItem" (
    "id" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "StocktakeLocationItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "StocktakeLocationItem_locationId_itemId_key" ON "StocktakeLocationItem"("locationId", "itemId");
CREATE INDEX IF NOT EXISTS "StocktakeLocationItem_itemId_idx" ON "StocktakeLocationItem"("itemId");

CREATE TABLE IF NOT EXISTS "StocktakeBatch" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "branchCode" TEXT NOT NULL,
    "warehouseCode" TEXT NOT NULL,
    "cutoffAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'APPROVED',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "reopenedBy" TEXT,
    "reopenedAt" TIMESTAMP(3),
    "note" TEXT,
    "shortageValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "surplusValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StocktakeBatch_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "StocktakeBatch_code_key" ON "StocktakeBatch"("code");
CREATE INDEX IF NOT EXISTS "StocktakeBatch_branchCode_idx" ON "StocktakeBatch"("branchCode");
CREATE INDEX IF NOT EXISTS "StocktakeBatch_warehouseCode_cutoffAt_idx" ON "StocktakeBatch"("warehouseCode", "cutoffAt");
CREATE INDEX IF NOT EXISTS "StocktakeBatch_status_idx" ON "StocktakeBatch"("status");

CREATE TABLE IF NOT EXISTS "StocktakeBatchLine" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "bookQuantity" DOUBLE PRECISION NOT NULL,
    "countedQuantity" DOUBLE PRECISION NOT NULL,
    "varianceQuantity" DOUBLE PRECISION NOT NULL,
    "unitCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "varianceValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "breakdownJson" TEXT,
    "notCounted" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "StocktakeBatchLine_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "StocktakeBatchLine_batchId_idx" ON "StocktakeBatchLine"("batchId");
CREATE INDEX IF NOT EXISTS "StocktakeBatchLine_itemId_idx" ON "StocktakeBatchLine"("itemId");

CREATE INDEX IF NOT EXISTS "StocktakeSession_locationCode_idx" ON "StocktakeSession"("locationCode");
CREATE INDEX IF NOT EXISTS "StocktakeSession_batchId_idx" ON "StocktakeSession"("batchId");

DO $$ BEGIN
  ALTER TABLE "StocktakeSession" ADD CONSTRAINT "StocktakeSession_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "StocktakeBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "StocktakeLocationItem" ADD CONSTRAINT "StocktakeLocationItem_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StocktakeLocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "StocktakeLocationItem" ADD CONSTRAINT "StocktakeLocationItem_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "StocktakeBatchLine" ADD CONSTRAINT "StocktakeBatchLine_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "StocktakeBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "StocktakeBatchLine" ADD CONSTRAINT "StocktakeBatchLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
