-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "importType" TEXT NOT NULL,
    "templateCode" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "uploadedBy" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PREVIEW',
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "validRows" INTEGER NOT NULL DEFAULT 0,
    "errorRows" INTEGER NOT NULL DEFAULT 0,
    "mappingJson" TEXT,
    "errorJson" TEXT,
    "committedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankStatementTransaction" (
    "id" TEXT NOT NULL,
    "importBatchId" TEXT NOT NULL,
    "transactionDate" TIMESTAMP(3) NOT NULL,
    "bankAccount" TEXT NOT NULL,
    "transactionCode" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "debitAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "creditAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "balanceAfter" DOUBLE PRECISION,
    "branchCode" TEXT,
    "partnerHint" TEXT,
    "reconcileStatus" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankStatementTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevenueImportRow" (
    "id" TEXT NOT NULL,
    "importBatchId" TEXT NOT NULL,
    "saleDate" TIMESTAMP(3) NOT NULL,
    "branchCode" TEXT NOT NULL,
    "channel" TEXT,
    "revenueSource" TEXT NOT NULL,
    "paymentMethod" TEXT NOT NULL,
    "orderCount" INTEGER,
    "grossAmount" DOUBLE PRECISION NOT NULL,
    "discountAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "vatAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "feeAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "netAmount" DOUBLE PRECISION NOT NULL,
    "externalRef" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevenueImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportBatch_importType_idx" ON "ImportBatch"("importType");

-- CreateIndex
CREATE INDEX "ImportBatch_status_idx" ON "ImportBatch"("status");

-- CreateIndex
CREATE INDEX "ImportBatch_createdAt_idx" ON "ImportBatch"("createdAt");

-- CreateIndex
CREATE INDEX "BankStatementTransaction_transactionDate_idx" ON "BankStatementTransaction"("transactionDate");

-- CreateIndex
CREATE INDEX "BankStatementTransaction_bankAccount_idx" ON "BankStatementTransaction"("bankAccount");

-- CreateIndex
CREATE INDEX "BankStatementTransaction_reconcileStatus_idx" ON "BankStatementTransaction"("reconcileStatus");

-- CreateIndex
CREATE UNIQUE INDEX "BankStatementTransaction_bankAccount_transactionCode_key" ON "BankStatementTransaction"("bankAccount", "transactionCode");

-- CreateIndex
CREATE INDEX "RevenueImportRow_saleDate_idx" ON "RevenueImportRow"("saleDate");

-- CreateIndex
CREATE INDEX "RevenueImportRow_branchCode_idx" ON "RevenueImportRow"("branchCode");

-- CreateIndex
CREATE INDEX "RevenueImportRow_paymentMethod_idx" ON "RevenueImportRow"("paymentMethod");

-- CreateIndex
CREATE UNIQUE INDEX "RevenueImportRow_branchCode_saleDate_externalRef_key" ON "RevenueImportRow"("branchCode", "saleDate", "externalRef");

-- AddForeignKey
ALTER TABLE "BankStatementTransaction" ADD CONSTRAINT "BankStatementTransaction_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevenueImportRow" ADD CONSTRAINT "RevenueImportRow_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
