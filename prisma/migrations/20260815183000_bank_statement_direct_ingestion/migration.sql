ALTER TABLE "BankStatementTransaction"
  ADD COLUMN "operationType" TEXT,
  ADD COLUMN "accountingDate" TIMESTAMP(3),
  ADD COLUMN "partnerCode" TEXT,
  ADD COLUMN "pnlItemCode" TEXT,
  ADD COLUMN "debtReference" TEXT,
  ADD COLUMN "depositCode" TEXT,
  ADD COLUMN "grossAmount" DOUBLE PRECISION,
  ADD COLUMN "grabExpenseAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "cardFeeAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;

ALTER TABLE "BankStatementAllocation"
  ADD COLUMN "operationType" TEXT,
  ADD COLUMN "accountingDate" TIMESTAMP(3),
  ADD COLUMN "partnerCode" TEXT,
  ADD COLUMN "pnlItemCode" TEXT,
  ADD COLUMN "debtReference" TEXT,
  ADD COLUMN "depositCode" TEXT,
  ADD COLUMN "grabExpenseAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "cardFeeAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;

CREATE INDEX "BankStatementTransaction_operationType_idx" ON "BankStatementTransaction"("operationType");
CREATE INDEX "BankStatementTransaction_accountingDate_idx" ON "BankStatementTransaction"("accountingDate");
CREATE INDEX "BankStatementTransaction_partnerCode_idx" ON "BankStatementTransaction"("partnerCode");
CREATE INDEX "BankStatementTransaction_pnlItemCode_idx" ON "BankStatementTransaction"("pnlItemCode");
