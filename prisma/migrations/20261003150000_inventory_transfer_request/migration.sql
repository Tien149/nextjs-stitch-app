-- Phiếu điều chuyển chờ duyệt (khách chốt 03/10/2026): nhà hàng chuyển lập, nhà hàng nhận duyệt.
CREATE TABLE IF NOT EXISTS "InventoryTransferRequest" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestDate" TIMESTAMP(3) NOT NULL,
    "branchCode" TEXT NOT NULL,
    "warehouseCode" TEXT NOT NULL,
    "toBranchCode" TEXT NOT NULL,
    "toWarehouseCode" TEXT NOT NULL,
    "referenceCode" TEXT,
    "note" TEXT,
    "lines" JSONB NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "receivedDate" TIMESTAMP(3),
    "returnedBy" TEXT,
    "returnedAt" TIMESTAMP(3),
    "returnedReason" TEXT,
    "transactionId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    CONSTRAINT "InventoryTransferRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "InventoryTransferRequest_code_key" ON "InventoryTransferRequest"("code");
CREATE INDEX IF NOT EXISTS "InventoryTransferRequest_status_idx" ON "InventoryTransferRequest"("status");
CREATE INDEX IF NOT EXISTS "InventoryTransferRequest_branchCode_idx" ON "InventoryTransferRequest"("branchCode");
CREATE INDEX IF NOT EXISTS "InventoryTransferRequest_toBranchCode_idx" ON "InventoryTransferRequest"("toBranchCode");
