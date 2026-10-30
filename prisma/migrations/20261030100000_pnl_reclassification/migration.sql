-- Phiếu điều chỉnh hạng mục P&L trong một nhà hàng (khách 30/10/2026).
CREATE TABLE IF NOT EXISTS "PnlReclassification" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "documentDate" TIMESTAMP(3) NOT NULL,
    "period" TEXT NOT NULL,
    "branchCode" TEXT NOT NULL,
    "fromPnlItemCode" TEXT NOT NULL,
    "toPnlItemCode" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    CONSTRAINT "PnlReclassification_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PnlReclassification_code_key" ON "PnlReclassification"("code");
CREATE INDEX IF NOT EXISTS "PnlReclassification_period_idx" ON "PnlReclassification"("period");
CREATE INDEX IF NOT EXISTS "PnlReclassification_branchCode_idx" ON "PnlReclassification"("branchCode");
CREATE INDEX IF NOT EXISTS "PnlReclassification_deletedAt_idx" ON "PnlReclassification"("deletedAt");
