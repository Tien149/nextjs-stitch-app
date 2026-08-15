ALTER TABLE "MoneyTransfer"
ADD COLUMN "actualTransferDate" TIMESTAMP(3),
ADD COLUMN "approvedAt" TIMESTAMP(3);

CREATE INDEX "MoneyTransfer_actualTransferDate_idx" ON "MoneyTransfer"("actualTransferDate");
