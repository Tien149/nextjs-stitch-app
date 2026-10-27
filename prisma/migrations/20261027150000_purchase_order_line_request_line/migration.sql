-- Dòng PO nhớ dòng PR nguồn: huỷ một PO thì PR mở lại đúng phần của PO đó (khách 27/10/2026).
ALTER TABLE "PurchaseOrderLine" ADD COLUMN "requestLineId" TEXT;
CREATE INDEX "PurchaseOrderLine_requestLineId_idx" ON "PurchaseOrderLine"("requestLineId");

-- Dữ liệu cũ: nối theo mặt hàng trong cùng PR (PR không lặp mặt hàng).
UPDATE "PurchaseOrderLine" AS pol
SET "requestLineId" = m."requestLineId"
FROM (
  SELECT DISTINCT ON (l.id) l.id AS "orderLineId", rl.id AS "requestLineId"
  FROM "PurchaseOrderLine" l
  JOIN "PurchaseOrder" po ON po.id = l."orderId"
  JOIN "PurchaseRequestLine" rl ON rl."requestId" = po."requestId" AND rl."itemId" = l."itemId"
  WHERE po."requestId" IS NOT NULL
  ORDER BY l.id, rl.id
) AS m
WHERE pol.id = m."orderLineId" AND pol."requestLineId" IS NULL;
