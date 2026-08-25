-- Mẫu yêu cầu mua hàng + link chia sẻ PO cho nhà cung cấp (yêu cầu chị Bình 25/08):
--
-- 1) Mẫu yêu cầu mua hàng: quản lý set sẵn danh sách (tên hàng + ĐVT), bộ phận cần đặt
--    chỉ mở mẫu điền số lượng rồi gửi — hệ thống tạo PR nhiều dòng từ mẫu.
CREATE TABLE "PurchaseRequestTemplate" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "branchCode" TEXT,
    "departmentCode" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "PurchaseRequestTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PurchaseRequestTemplate_code_key" ON "PurchaseRequestTemplate"("code");
CREATE INDEX "PurchaseRequestTemplate_status_idx" ON "PurchaseRequestTemplate"("status");
CREATE INDEX "PurchaseRequestTemplate_branchCode_idx" ON "PurchaseRequestTemplate"("branchCode");
CREATE INDEX "PurchaseRequestTemplate_deletedAt_idx" ON "PurchaseRequestTemplate"("deletedAt");

CREATE TABLE "PurchaseRequestTemplateLine" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "unitCode" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,

    CONSTRAINT "PurchaseRequestTemplateLine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PurchaseRequestTemplateLine_templateId_idx" ON "PurchaseRequestTemplateLine"("templateId");
CREATE INDEX "PurchaseRequestTemplateLine_itemId_idx" ON "PurchaseRequestTemplateLine"("itemId");

ALTER TABLE "PurchaseRequestTemplateLine" ADD CONSTRAINT "PurchaseRequestTemplateLine_templateId_fkey"
    FOREIGN KEY ("templateId") REFERENCES "PurchaseRequestTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PurchaseRequestTemplateLine" ADD CONSTRAINT "PurchaseRequestTemplateLine_itemId_fkey"
    FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2) Link công khai gửi NCC: PO mang token ngẫu nhiên, ai có link xem được phiếu đặt hàng
--    (kèm QR) mà không cần đăng nhập. Null = chưa chia sẻ; thu hồi link = set về null.
ALTER TABLE "PurchaseOrder" ADD COLUMN "shareToken" TEXT;
CREATE UNIQUE INDEX "PurchaseOrder_shareToken_key" ON "PurchaseOrder"("shareToken");
