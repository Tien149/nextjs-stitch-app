-- Master data partner classification
ALTER TABLE "MasterDataItem"
ADD COLUMN "partnerType" TEXT,
ADD COLUMN "partnerGroup" TEXT;

CREATE INDEX "MasterDataItem_partnerType_idx" ON "MasterDataItem"("partnerType");
CREATE INDEX "MasterDataItem_partnerGroup_idx" ON "MasterDataItem"("partnerGroup");

UPDATE "MasterDataItem"
SET "partnerType" = "group"
WHERE "type" = 'PARTNER' AND "partnerType" IS NULL;

UPDATE "MasterDataItem"
SET "partnerGroup" = COALESCE(NULLIF("branch", ''), 'EXTERNAL')
WHERE "type" = 'PARTNER' AND "partnerGroup" IS NULL;

-- Opening balance source details
ALTER TABLE "OpeningBalance"
ADD COLUMN "warehouseCode" TEXT,
ADD COLUMN "departmentCode" TEXT,
ADD COLUMN "quantity" DOUBLE PRECISION,
ADD COLUMN "unitCost" DOUBLE PRECISION,
ADD COLUMN "allocationMonths" INTEGER,
ADD COLUMN "allocationStartPeriod" TEXT;

CREATE INDEX "OpeningBalance_branchCode_idx" ON "OpeningBalance"("branchCode");

-- Inventory and procurement attachments
ALTER TABLE "InventoryItem"
ADD COLUMN "requiresImage" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "PurchaseRequestLine"
ADD COLUMN "imageUrl" TEXT;

ALTER TABLE "PurchaseOrderLine"
ADD COLUMN "imageUrl" TEXT;

-- Asset lifecycle and traceability
ALTER TABLE "AssetRecord"
ADD COLUMN "imageUrl" TEXT,
ADD COLUMN "location" TEXT,
ADD COLUMN "quantity" DOUBLE PRECISION NOT NULL DEFAULT 1,
ADD COLUMN "sourcePurchaseOrderId" TEXT,
ADD COLUMN "sourceReceiptId" TEXT,
ADD COLUMN "disposalDate" TIMESTAMP(3),
ADD COLUMN "disposalStatus" TEXT;

CREATE INDEX "AssetRecord_departmentCode_idx" ON "AssetRecord"("departmentCode");
CREATE INDEX "AssetRecord_sourcePurchaseOrderId_idx" ON "AssetRecord"("sourcePurchaseOrderId");

-- Work management links and checklist payload
ALTER TABLE "WorkItem"
ADD COLUMN "linkedModule" TEXT,
ADD COLUMN "linkedId" TEXT,
ADD COLUMN "linkedCode" TEXT,
ADD COLUMN "checklistJson" TEXT,
ADD COLUMN "attachmentUrl" TEXT;

CREATE INDEX "WorkItem_linkedModule_linkedId_idx" ON "WorkItem"("linkedModule", "linkedId");
