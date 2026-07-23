ALTER TABLE "Accrual"
ADD COLUMN "sourceType" TEXT,
ADD COLUMN "sourceId" TEXT;

CREATE INDEX "Accrual_sourceType_sourceId_idx" ON "Accrual"("sourceType", "sourceId");
