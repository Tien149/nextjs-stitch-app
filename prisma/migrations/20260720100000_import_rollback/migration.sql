ALTER TABLE "ImportBatch"
ADD COLUMN "rolledBackAt" TIMESTAMP(3),
ADD COLUMN "rolledBackBy" TEXT,
ADD COLUMN "rollbackNote" TEXT;
