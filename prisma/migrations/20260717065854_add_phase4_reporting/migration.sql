-- CreateTable
CREATE TABLE "AccountingAccount" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accountType" TEXT NOT NULL,
    "normalBalance" TEXT NOT NULL,
    "reportGroup" TEXT NOT NULL,
    "parentCode" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountingAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "entryDate" TIMESTAMP(3) NOT NULL,
    "period" TEXT NOT NULL,
    "branchCode" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceCode" TEXT,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalLine" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "debit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "credit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "departmentCode" TEXT,
    "partnerCode" TEXT,
    "categoryCode" TEXT,
    "description" TEXT,

    CONSTRAINT "JournalLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostingRule" (
    "id" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "ruleCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "debitAccountCode" TEXT NOT NULL,
    "creditAccountCode" TEXT NOT NULL,
    "conditionJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PostingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollImportRow" (
    "id" TEXT NOT NULL,
    "importBatchId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "employeeName" TEXT NOT NULL,
    "branchCode" TEXT NOT NULL,
    "departmentCode" TEXT NOT NULL,
    "baseSalary" DOUBLE PRECISION NOT NULL,
    "allowanceAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "bonusAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "insuranceAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "taxAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "deductionAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "netAmount" DOUBLE PRECISION NOT NULL,
    "externalRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkItem" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "branchCode" TEXT NOT NULL,
    "departmentCode" TEXT NOT NULL,
    "assigneeId" TEXT,
    "assigneeName" TEXT NOT NULL,
    "period" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "status" TEXT NOT NULL DEFAULT 'TODO',
    "dueDate" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkItemHistory" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "note" TEXT,
    "actor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkItemHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ForecastAssumption" (
    "id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "branchCode" TEXT NOT NULL,
    "scenario" TEXT NOT NULL,
    "assumptionType" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ForecastAssumption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportTarget" (
    "id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "branchCode" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "targetValue" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportTarget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountingAccount_code_key" ON "AccountingAccount"("code");

-- CreateIndex
CREATE INDEX "AccountingAccount_accountType_idx" ON "AccountingAccount"("accountType");

-- CreateIndex
CREATE INDEX "AccountingAccount_reportGroup_idx" ON "AccountingAccount"("reportGroup");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_code_key" ON "JournalEntry"("code");

-- CreateIndex
CREATE INDEX "JournalEntry_period_idx" ON "JournalEntry"("period");

-- CreateIndex
CREATE INDEX "JournalEntry_branchCode_idx" ON "JournalEntry"("branchCode");

-- CreateIndex
CREATE INDEX "JournalEntry_status_idx" ON "JournalEntry"("status");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_sourceType_sourceId_key" ON "JournalEntry"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "JournalLine_entryId_idx" ON "JournalLine"("entryId");

-- CreateIndex
CREATE INDEX "JournalLine_accountId_idx" ON "JournalLine"("accountId");

-- CreateIndex
CREATE INDEX "JournalLine_departmentCode_idx" ON "JournalLine"("departmentCode");

-- CreateIndex
CREATE UNIQUE INDEX "PostingRule_ruleCode_key" ON "PostingRule"("ruleCode");

-- CreateIndex
CREATE INDEX "PostingRule_sourceType_idx" ON "PostingRule"("sourceType");

-- CreateIndex
CREATE INDEX "PostingRule_status_idx" ON "PostingRule"("status");

-- CreateIndex
CREATE INDEX "PayrollImportRow_period_idx" ON "PayrollImportRow"("period");

-- CreateIndex
CREATE INDEX "PayrollImportRow_branchCode_idx" ON "PayrollImportRow"("branchCode");

-- CreateIndex
CREATE INDEX "PayrollImportRow_departmentCode_idx" ON "PayrollImportRow"("departmentCode");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollImportRow_period_employeeCode_branchCode_key" ON "PayrollImportRow"("period", "employeeCode", "branchCode");

-- CreateIndex
CREATE UNIQUE INDEX "WorkItem_code_key" ON "WorkItem"("code");

-- CreateIndex
CREATE INDEX "WorkItem_branchCode_idx" ON "WorkItem"("branchCode");

-- CreateIndex
CREATE INDEX "WorkItem_departmentCode_idx" ON "WorkItem"("departmentCode");

-- CreateIndex
CREATE INDEX "WorkItem_status_idx" ON "WorkItem"("status");

-- CreateIndex
CREATE INDEX "WorkItem_dueDate_idx" ON "WorkItem"("dueDate");

-- CreateIndex
CREATE INDEX "WorkItemHistory_workItemId_idx" ON "WorkItemHistory"("workItemId");

-- CreateIndex
CREATE INDEX "ForecastAssumption_period_idx" ON "ForecastAssumption"("period");

-- CreateIndex
CREATE INDEX "ForecastAssumption_scenario_idx" ON "ForecastAssumption"("scenario");

-- CreateIndex
CREATE UNIQUE INDEX "ForecastAssumption_period_branchCode_scenario_assumptionTyp_key" ON "ForecastAssumption"("period", "branchCode", "scenario", "assumptionType");

-- CreateIndex
CREATE INDEX "ReportTarget_period_idx" ON "ReportTarget"("period");

-- CreateIndex
CREATE UNIQUE INDEX "ReportTarget_period_branchCode_metric_key" ON "ReportTarget"("period", "branchCode", "metric");

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "AccountingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollImportRow" ADD CONSTRAINT "PayrollImportRow_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkItemHistory" ADD CONSTRAINT "WorkItemHistory_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
