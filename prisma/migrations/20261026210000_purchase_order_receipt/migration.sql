-- Lần nhận hàng của PO (khách 26/10/2026): ghi lại để "Huỷ lần nhận" đảo đúng phần đã làm.
CREATE TABLE "PurchaseOrderReceipt" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "stockTransactionId" TEXT,
  "receivedDate" TIMESTAMP(3) NOT NULL,
  "payableAmount" DOUBLE PRECISION NOT NULL,
  "lines" JSONB NOT NULL,
  "assetIds" JSONB,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cancelledBy" TEXT,
  "cancelledAt" TIMESTAMP(3),
  CONSTRAINT "PurchaseOrderReceipt_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PurchaseOrderReceipt_orderId_idx" ON "PurchaseOrderReceipt"("orderId");
CREATE INDEX "PurchaseOrderReceipt_stockTransactionId_idx" ON "PurchaseOrderReceipt"("stockTransactionId");
