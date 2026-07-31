-- Extend internal money transfers to support daily cash deposit submissions.
ALTER TABLE "MoneyTransfer"
ADD COLUMN "transferPurpose" TEXT,
ADD COLUMN "depositTargetType" TEXT,
ADD COLUMN "sourceReportDate" TIMESTAMP(3),
ADD COLUMN "sourceShift" TEXT;

CREATE TABLE "MoneyTransferDenomination" (
    "id" TEXT NOT NULL,
    "moneyTransferId" TEXT NOT NULL,
    "denomination" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MoneyTransferDenomination_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MoneyTransferDenomination_moneyTransferId_denomination_key" ON "MoneyTransferDenomination"("moneyTransferId", "denomination");
CREATE INDEX "MoneyTransferDenomination_moneyTransferId_idx" ON "MoneyTransferDenomination"("moneyTransferId");
CREATE INDEX "MoneyTransfer_transferPurpose_idx" ON "MoneyTransfer"("transferPurpose");
CREATE INDEX "MoneyTransfer_sourceReportDate_idx" ON "MoneyTransfer"("sourceReportDate");

ALTER TABLE "MoneyTransferDenomination"
ADD CONSTRAINT "MoneyTransferDenomination_moneyTransferId_fkey"
FOREIGN KEY ("moneyTransferId") REFERENCES "MoneyTransfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
