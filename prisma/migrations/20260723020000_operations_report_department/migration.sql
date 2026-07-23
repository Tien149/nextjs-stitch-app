ALTER TABLE "PurchaseRequest"
ADD COLUMN "departmentCode" TEXT;

ALTER TABLE "PurchaseOrder"
ADD COLUMN "departmentCode" TEXT;

CREATE INDEX "PurchaseRequest_departmentCode_idx" ON "PurchaseRequest"("departmentCode");
CREATE INDEX "PurchaseOrder_departmentCode_idx" ON "PurchaseOrder"("departmentCode");
