-- Ghi chú từng món trên báo cáo DT theo ca & món (khách 20/11/2026).
CREATE TABLE IF NOT EXISTS "SalesItemNote" (
    "id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "branchCode" TEXT NOT NULL,
    "productCode" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SalesItemNote_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "SalesItemNote_period_branchCode_productCode_key" ON "SalesItemNote"("period", "branchCode", "productCode");
