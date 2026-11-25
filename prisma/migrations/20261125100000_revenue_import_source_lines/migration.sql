-- Dòng gốc của file doanh thu POS (khách 25/11/2026): xuất lại đúng số dòng, đúng thứ tự như lúc nạp.
ALTER TABLE "ImportBatch" ADD COLUMN IF NOT EXISTS "sourceHeadersJson" TEXT;

CREATE TABLE IF NOT EXISTS "RevenueImportSourceLine" (
    "id" TEXT NOT NULL,
    "importBatchId" TEXT NOT NULL,
    "revenueRowId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "cellsJson" TEXT NOT NULL,
    CONSTRAINT "RevenueImportSourceLine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "RevenueImportSourceLine_revenueRowId_idx" ON "RevenueImportSourceLine"("revenueRowId");
CREATE INDEX IF NOT EXISTS "RevenueImportSourceLine_importBatchId_rowNumber_idx" ON "RevenueImportSourceLine"("importBatchId", "rowNumber");

DO $$ BEGIN
  ALTER TABLE "RevenueImportSourceLine" ADD CONSTRAINT "RevenueImportSourceLine_revenueRowId_fkey"
    FOREIGN KEY ("revenueRowId") REFERENCES "RevenueImportRow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
