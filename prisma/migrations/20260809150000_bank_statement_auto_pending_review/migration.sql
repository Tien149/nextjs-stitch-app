ALTER TABLE "BankStatementTransaction"
ADD COLUMN "sourceDate" TIMESTAMP(3),
ADD COLUMN "revenueDate" TIMESTAMP(3),
ADD COLUMN "summaryMoneySourceCode" TEXT,
ADD COLUMN "increaseMoneySourceCode" TEXT,
ADD COLUMN "decreaseMoneySourceCode" TEXT,
ADD COLUMN "autoProcessType" TEXT,
ADD COLUMN "autoProcessNote" TEXT;

CREATE INDEX "BankStatementTransaction_autoProcessType_idx"
ON "BankStatementTransaction"("autoProcessType");
