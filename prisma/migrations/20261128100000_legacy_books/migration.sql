-- Sổ sách kế toán trước 08/2026: lưu file Excel cũ + từng dòng để tra cứu (khách 28/11/2026).
CREATE TABLE IF NOT EXISTS "LegacyBookFile" (
    "id" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT,
    "fileSize" INTEGER NOT NULL,
    "content" BYTEA NOT NULL,
    "branchCode" TEXT NOT NULL DEFAULT 'ALL',
    "periodLabel" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "sheetsJson" JSONB NOT NULL,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "uploadedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LegacyBookFile_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "LegacyBookFile_branchCode_idx" ON "LegacyBookFile"("branchCode");
CREATE INDEX IF NOT EXISTS "LegacyBookFile_createdAt_idx" ON "LegacyBookFile"("createdAt");

CREATE TABLE IF NOT EXISTS "LegacyBookRow" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "sheetIndex" INTEGER NOT NULL,
    "sheetName" TEXT NOT NULL,
    "rowNo" INTEGER NOT NULL,
    "cells" JSONB NOT NULL,
    "searchText" TEXT NOT NULL,
    CONSTRAINT "LegacyBookRow_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "LegacyBookRow_fileId_sheetIndex_rowNo_idx" ON "LegacyBookRow"("fileId", "sheetIndex", "rowNo");
DO $$ BEGIN
  ALTER TABLE "LegacyBookRow" ADD CONSTRAINT "LegacyBookRow_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "LegacyBookFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
