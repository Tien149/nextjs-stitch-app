-- Bảng giá NCC theo khoảng hiệu lực + thuế suất trên dòng báo giá (03/10/2026).
ALTER TABLE "SupplierQuoteLine" ADD COLUMN IF NOT EXISTS "vatRate" DOUBLE PRECISION;

CREATE TABLE IF NOT EXISTS "SupplierPriceList" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "supplierCode" TEXT NOT NULL,
    "supplierName" TEXT NOT NULL,
    "branchCode" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "note" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    CONSTRAINT "SupplierPriceList_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "SupplierPriceList_code_key" ON "SupplierPriceList"("code");
CREATE INDEX IF NOT EXISTS "SupplierPriceList_supplierCode_idx" ON "SupplierPriceList"("supplierCode");
CREATE INDEX IF NOT EXISTS "SupplierPriceList_effectiveFrom_idx" ON "SupplierPriceList"("effectiveFrom");
CREATE INDEX IF NOT EXISTS "SupplierPriceList_branchCode_idx" ON "SupplierPriceList"("branchCode");
CREATE INDEX IF NOT EXISTS "SupplierPriceList_deletedAt_idx" ON "SupplierPriceList"("deletedAt");

CREATE TABLE IF NOT EXISTS "SupplierPriceListLine" (
    "id" TEXT NOT NULL,
    "priceListId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "unitCode" TEXT NOT NULL,
    "conversionRate" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "unitPrice" DOUBLE PRECISION NOT NULL,
    "vatRate" DOUBLE PRECISION,
    "note" TEXT,
    CONSTRAINT "SupplierPriceListLine_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "SupplierPriceListLine_priceListId_idx" ON "SupplierPriceListLine"("priceListId");
CREATE INDEX IF NOT EXISTS "SupplierPriceListLine_itemId_idx" ON "SupplierPriceListLine"("itemId");
DO $$ BEGIN
  ALTER TABLE "SupplierPriceListLine" ADD CONSTRAINT "SupplierPriceListLine_priceListId_fkey" FOREIGN KEY ("priceListId") REFERENCES "SupplierPriceList"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "SupplierPriceListLine" ADD CONSTRAINT "SupplierPriceListLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
