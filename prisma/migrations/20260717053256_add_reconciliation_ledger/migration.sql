-- CreateTable
CREATE TABLE "ReconciliationMatch" (
    "id" TEXT NOT NULL,
    "bankTransactionId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "targetCode" TEXT NOT NULL,
    "targetDate" TIMESTAMP(3),
    "targetAmount" DOUBLE PRECISION NOT NULL,
    "matchedAmount" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'MATCHED',
    "note" TEXT,
    "matchedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconciliationMatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReconciliationMatch_targetType_idx" ON "ReconciliationMatch"("targetType");

-- CreateIndex
CREATE INDEX "ReconciliationMatch_status_idx" ON "ReconciliationMatch"("status");

-- CreateIndex
CREATE INDEX "ReconciliationMatch_createdAt_idx" ON "ReconciliationMatch"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReconciliationMatch_bankTransactionId_targetType_targetId_key" ON "ReconciliationMatch"("bankTransactionId", "targetType", "targetId");

-- AddForeignKey
ALTER TABLE "ReconciliationMatch" ADD CONSTRAINT "ReconciliationMatch_bankTransactionId_fkey" FOREIGN KEY ("bankTransactionId") REFERENCES "BankStatementTransaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
