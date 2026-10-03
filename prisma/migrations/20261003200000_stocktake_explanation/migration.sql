-- Giải trình kiểm kê (khách yêu cầu 03/10/2026): số liệu chụp theo đợt kiểm kê + giải trình từng dòng.
CREATE TABLE IF NOT EXISTS "StocktakeExplanation" (
    "id" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceCode" TEXT NOT NULL,
    "branchCode" TEXT NOT NULL,
    "warehouseCode" TEXT NOT NULL,
    "periodFrom" TIMESTAMP(3),
    "periodTo" TIMESTAMP(3) NOT NULL,
    "sourceApprovedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "lines" JSONB NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "snapshotBy" TEXT,
    "snapshotAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMP(3),
    "unlockedBy" TEXT,
    "unlockedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    CONSTRAINT "StocktakeExplanation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "StocktakeExplanation_sourceType_sourceId_key" ON "StocktakeExplanation"("sourceType", "sourceId");
CREATE INDEX IF NOT EXISTS "StocktakeExplanation_warehouseCode_idx" ON "StocktakeExplanation"("warehouseCode");
CREATE INDEX IF NOT EXISTS "StocktakeExplanation_branchCode_idx" ON "StocktakeExplanation"("branchCode");
