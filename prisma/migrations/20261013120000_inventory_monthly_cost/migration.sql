-- Tính giá vốn bình quân cả tháng theo từng kho (khách chốt 13/10/2026): lần tính + giá tháng mã × kho.
CREATE TABLE IF NOT EXISTS "InventoryCostingRun" (
  "id" TEXT NOT NULL,
  "fromPeriod" TEXT NOT NULL,
  "toPeriod" TEXT NOT NULL,
  "fingerprintsJson" TEXT NOT NULL,
  "summaryJson" TEXT,
  "changedLines" INTEGER NOT NULL DEFAULT 0,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventoryCostingRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "InventoryCostingRun_createdAt_idx" ON "InventoryCostingRun"("createdAt");

CREATE TABLE IF NOT EXISTS "InventoryMonthlyCost" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  "itemId" TEXT NOT NULL,
  "warehouseCode" TEXT NOT NULL,
  "openingQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "openingValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "inQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "inValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "followQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "followValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "outQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "outValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "closingQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "closingValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "averageCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "priceSource" TEXT NOT NULL,
  "revaluation" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "residual" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventoryMonthlyCost_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "InventoryMonthlyCost_period_itemId_warehouseCode_key" ON "InventoryMonthlyCost"("period", "itemId", "warehouseCode");
CREATE INDEX IF NOT EXISTS "InventoryMonthlyCost_period_idx" ON "InventoryMonthlyCost"("period");
CREATE INDEX IF NOT EXISTS "InventoryMonthlyCost_warehouseCode_idx" ON "InventoryMonthlyCost"("warehouseCode");
