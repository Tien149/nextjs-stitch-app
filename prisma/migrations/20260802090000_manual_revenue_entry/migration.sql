-- Doanh thu thu ngân tự nhập khi kết ca (thay cho việc phải import file doanh thu POS).
CREATE TABLE "ManualRevenueEntry" (
    "id" TEXT NOT NULL,
    "reportDate" TIMESTAMP(3) NOT NULL,
    "shift" TEXT NOT NULL,
    "branchCode" TEXT NOT NULL,
    "cashAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "transferAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cardAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "grabAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "otherAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "ManualRevenueEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ManualRevenueEntry_branchCode_reportDate_shift_key" ON "ManualRevenueEntry"("branchCode", "reportDate", "shift");
CREATE INDEX "ManualRevenueEntry_reportDate_idx" ON "ManualRevenueEntry"("reportDate");
CREATE INDEX "ManualRevenueEntry_branchCode_idx" ON "ManualRevenueEntry"("branchCode");
CREATE INDEX "ManualRevenueEntry_deletedAt_idx" ON "ManualRevenueEntry"("deletedAt");
