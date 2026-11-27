-- Điều chuyển tài sản/CCDC giữa các nhà hàng (27/11/2026). IF NOT EXISTS để chạy lại an toàn (VPS áp bằng db execute).
ALTER TABLE "AssetRecord" ADD COLUMN IF NOT EXISTS "transferredFromId" TEXT;
ALTER TABLE "AssetRecord" ADD COLUMN IF NOT EXISTS "transferId" TEXT;
CREATE INDEX IF NOT EXISTS "AssetRecord_transferId_idx" ON "AssetRecord"("transferId");

CREATE TABLE IF NOT EXISTS "AssetTransfer" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "transferDate" TIMESTAMP(3) NOT NULL,
    "period" TEXT NOT NULL,
    "fromBranchCode" TEXT NOT NULL,
    "toBranchCode" TEXT NOT NULL,
    "toWarehouseCode" TEXT,
    "toDepartmentCode" TEXT,
    "sourceAssetId" TEXT NOT NULL,
    "assetCode" TEXT NOT NULL,
    "assetName" TEXT NOT NULL,
    "isTool" BOOLEAN NOT NULL DEFAULT true,
    "quantity" DOUBLE PRECISION NOT NULL,
    "sourceQuantity" DOUBLE PRECISION NOT NULL,
    "originalCost" DOUBLE PRECISION NOT NULL,
    "accumulatedDepreciation" DOUBLE PRECISION NOT NULL,
    "remainingValue" DOUBLE PRECISION NOT NULL,
    "depreciatedPeriods" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "remainingPeriods" DOUBLE PRECISION,
    "targetAssetId" TEXT,
    "keptAssetId" TEXT,
    "sourceSnapshotJson" TEXT NOT NULL,
    "receivableDebtCode" TEXT,
    "payableDebtCode" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "createdBy" TEXT,
    "cancelledBy" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AssetTransfer_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AssetTransfer_code_key" ON "AssetTransfer"("code");
CREATE INDEX IF NOT EXISTS "AssetTransfer_fromBranchCode_idx" ON "AssetTransfer"("fromBranchCode");
CREATE INDEX IF NOT EXISTS "AssetTransfer_toBranchCode_idx" ON "AssetTransfer"("toBranchCode");
CREATE INDEX IF NOT EXISTS "AssetTransfer_sourceAssetId_idx" ON "AssetTransfer"("sourceAssetId");
CREATE INDEX IF NOT EXISTS "AssetTransfer_period_idx" ON "AssetTransfer"("period");
