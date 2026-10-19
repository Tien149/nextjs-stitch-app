-- Số liệu P&L thực tế trước khi lên phần mềm (nhập tay để lên báo cáo).
CREATE TABLE IF NOT EXISTS "PnlHistoryEntry" (
    "id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "branchCode" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PnlHistoryEntry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PnlHistoryEntry_period_branchCode_metric_key" ON "PnlHistoryEntry"("period", "branchCode", "metric");
CREATE INDEX IF NOT EXISTS "PnlHistoryEntry_period_idx" ON "PnlHistoryEntry"("period");
