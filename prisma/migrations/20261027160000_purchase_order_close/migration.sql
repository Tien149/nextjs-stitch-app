-- Đóng PO nhận thiếu + PR tự Hoàn tất (khách 27/10/2026). Chạy SAU 20261027150000 (cần requestLineId).
ALTER TABLE "PurchaseOrder" ADD COLUMN "closedAt" TIMESTAMP(3);
ALTER TABLE "PurchaseOrder" ADD COLUMN "closedBy" TEXT;
ALTER TABLE "PurchaseOrder" ADD COLUMN "closeReason" TEXT;

-- PR đã huỷ một trong các PO trước bản sửa (luật cũ chỉ mở lại khi hết PO): mở lại phần chưa lên PO.
UPDATE "PurchaseRequest" AS pr SET status = 'APPROVED', "updatedAt" = now()
WHERE pr.status = 'ORDERED' AND pr."deletedAt" IS NULL
  AND EXISTS (SELECT 1 FROM "PurchaseOrder" po WHERE po."requestId" = pr.id AND (po.status = 'CANCELLED' OR po."deletedAt" IS NOT NULL))
  AND EXISTS (
    SELECT 1 FROM "PurchaseRequestLine" l
    WHERE l."requestId" = pr.id AND NOT EXISTS (
      SELECT 1 FROM "PurchaseOrderLine" ol JOIN "PurchaseOrder" po ON po.id = ol."orderId"
      WHERE ol."requestLineId" = l.id AND po."deletedAt" IS NULL AND po.status <> 'CANCELLED'));

-- PR có mọi PO còn hiệu lực đã nhận đủ → Hoàn tất (trước đây không chỗ nào đặt trạng thái này).
UPDATE "PurchaseRequest" AS pr SET status = 'COMPLETED', "updatedAt" = now()
WHERE pr.status = 'ORDERED' AND pr."deletedAt" IS NULL
  AND EXISTS (SELECT 1 FROM "PurchaseOrder" po WHERE po."requestId" = pr.id AND po."deletedAt" IS NULL AND po.status <> 'CANCELLED')
  AND NOT EXISTS (SELECT 1 FROM "PurchaseOrder" po WHERE po."requestId" = pr.id AND po."deletedAt" IS NULL AND po.status NOT IN ('CANCELLED', 'COMPLETED'));
