-- AlterTable
ALTER TABLE "ImportBatch"
ADD COLUMN "branchCode" TEXT,
ADD COLUMN "fileChecksum" TEXT;

-- AlterTable
ALTER TABLE "FinancialVoucher"
ADD COLUMN "importBatchId" TEXT,
ADD COLUMN "sourceDocumentCode" TEXT,
ADD COLUMN "sourceScope" TEXT NOT NULL DEFAULT 'EXTERNAL',
ADD COLUMN "externalRef" TEXT,
ADD COLUMN "counterpartyAccountNo" TEXT,
ADD COLUMN "counterpartyAccountName" TEXT,
ADD COLUMN "depositAction" TEXT,
ADD COLUMN "depositCode" TEXT,
ADD COLUMN "debtAction" TEXT,
ADD COLUMN "debtReference" TEXT,
ADD COLUMN "allocationMonths" INTEGER,
ADD COLUMN "allocationStartPeriod" TEXT;

-- AlterTable
ALTER TABLE "DepositHistory"
ADD COLUMN "voucherId" TEXT;

-- CreateTable
CREATE TABLE "ImportRow" (
    "id" TEXT NOT NULL,
    "importBatchId" TEXT NOT NULL,
    "sheetName" TEXT NOT NULL,
    "sourceRowNumber" INTEGER NOT NULL,
    "rawJson" TEXT NOT NULL,
    "normalizedJson" TEXT NOT NULL,
    "errorJson" TEXT,
    "rowFingerprint" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DebtRecord" (
    "id" TEXT NOT NULL,
    "importBatchId" TEXT,
    "code" TEXT NOT NULL,
    "debtType" TEXT NOT NULL,
    "partnerGroup" TEXT NOT NULL DEFAULT 'EXTERNAL',
    "partnerCode" TEXT NOT NULL,
    "partnerName" TEXT NOT NULL,
    "branchCode" TEXT NOT NULL,
    "documentDate" TIMESTAMP(3) NOT NULL,
    "dueDate" TIMESTAMP(3),
    "categoryCode" TEXT,
    "originalAmount" DOUBLE PRECISION NOT NULL,
    "outstandingAmount" DOUBLE PRECISION NOT NULL,
    "allocationMonths" INTEGER,
    "allocationStartPeriod" TEXT,
    "description" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL DEFAULT 'IMPORT',
    "sourceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DebtRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DebtSettlement" (
    "id" TEXT NOT NULL,
    "debtId" TEXT NOT NULL,
    "voucherId" TEXT NOT NULL,
    "settlementDate" TIMESTAMP(3) NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DebtSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MoneyTransfer" (
    "id" TEXT NOT NULL,
    "importBatchId" TEXT,
    "code" TEXT NOT NULL,
    "transferDate" TIMESTAMP(3) NOT NULL,
    "branchCode" TEXT NOT NULL,
    "fromMoneySourceCode" TEXT NOT NULL,
    "toMoneySourceCode" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "externalRef" TEXT,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
    "createdBy" TEXT,
    "approvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MoneyTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportBatch_fileChecksum_idx" ON "ImportBatch"("fileChecksum");
CREATE UNIQUE INDEX "ImportRow_importBatchId_sheetName_sourceRowNumber_key" ON "ImportRow"("importBatchId", "sheetName", "sourceRowNumber");
CREATE INDEX "ImportRow_rowFingerprint_idx" ON "ImportRow"("rowFingerprint");
CREATE INDEX "ImportRow_targetType_targetId_idx" ON "ImportRow"("targetType", "targetId");
CREATE INDEX "FinancialVoucher_importBatchId_idx" ON "FinancialVoucher"("importBatchId");
CREATE INDEX "FinancialVoucher_branchCode_voucherType_externalRef_idx" ON "FinancialVoucher"("branchCode", "voucherType", "externalRef");
CREATE INDEX "DepositHistory_voucherId_idx" ON "DepositHistory"("voucherId");
CREATE UNIQUE INDEX "DepositHistory_voucherId_action_key" ON "DepositHistory"("voucherId", "action");
CREATE UNIQUE INDEX "DebtRecord_code_key" ON "DebtRecord"("code");
CREATE INDEX "DebtRecord_branchCode_idx" ON "DebtRecord"("branchCode");
CREATE INDEX "DebtRecord_partnerCode_idx" ON "DebtRecord"("partnerCode");
CREATE INDEX "DebtRecord_debtType_status_idx" ON "DebtRecord"("debtType", "status");
CREATE INDEX "DebtRecord_importBatchId_idx" ON "DebtRecord"("importBatchId");
CREATE UNIQUE INDEX "DebtSettlement_voucherId_key" ON "DebtSettlement"("voucherId");
CREATE INDEX "DebtSettlement_debtId_idx" ON "DebtSettlement"("debtId");
CREATE INDEX "DebtSettlement_settlementDate_idx" ON "DebtSettlement"("settlementDate");
CREATE UNIQUE INDEX "MoneyTransfer_code_key" ON "MoneyTransfer"("code");
CREATE INDEX "MoneyTransfer_transferDate_idx" ON "MoneyTransfer"("transferDate");
CREATE INDEX "MoneyTransfer_branchCode_idx" ON "MoneyTransfer"("branchCode");
CREATE INDEX "MoneyTransfer_status_idx" ON "MoneyTransfer"("status");
CREATE INDEX "MoneyTransfer_importBatchId_idx" ON "MoneyTransfer"("importBatchId");
CREATE INDEX "MoneyTransfer_branchCode_externalRef_idx" ON "MoneyTransfer"("branchCode", "externalRef");

-- AddForeignKey
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FinancialVoucher" ADD CONSTRAINT "FinancialVoucher_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DepositHistory" ADD CONSTRAINT "DepositHistory_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "FinancialVoucher"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DebtRecord" ADD CONSTRAINT "DebtRecord_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DebtSettlement" ADD CONSTRAINT "DebtSettlement_debtId_fkey" FOREIGN KEY ("debtId") REFERENCES "DebtRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DebtSettlement" ADD CONSTRAINT "DebtSettlement_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "FinancialVoucher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MoneyTransfer" ADD CONSTRAINT "MoneyTransfer_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
