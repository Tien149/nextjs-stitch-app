ALTER TABLE "AssetMaintenance"
ADD COLUMN "recurrenceRule" TEXT,
ADD COLUMN "recurrenceInterval" INTEGER DEFAULT 1,
ADD COLUMN "recurrenceEndDate" TIMESTAMP(3),
ADD COLUMN "linkedWorkItemId" TEXT;

ALTER TABLE "AssetDamageReport"
ADD COLUMN "linkedWorkItemId" TEXT;

CREATE INDEX "AssetMaintenance_linkedWorkItemId_idx" ON "AssetMaintenance"("linkedWorkItemId");
CREATE INDEX "AssetDamageReport_linkedWorkItemId_idx" ON "AssetDamageReport"("linkedWorkItemId");
