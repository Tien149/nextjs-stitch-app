-- ĐVT đặt hàng trên PR / báo giá / PO (số lượng, đơn giá vẫn lưu theo ĐVT tồn kho).
ALTER TABLE "PurchaseRequestLine" ADD COLUMN IF NOT EXISTS "unitCode" TEXT;
ALTER TABLE "PurchaseRequestLine" ADD COLUMN IF NOT EXISTS "conversionRate" DOUBLE PRECISION NOT NULL DEFAULT 1;
ALTER TABLE "SupplierQuoteLine" ADD COLUMN IF NOT EXISTS "unitCode" TEXT;
ALTER TABLE "SupplierQuoteLine" ADD COLUMN IF NOT EXISTS "conversionRate" DOUBLE PRECISION NOT NULL DEFAULT 1;
ALTER TABLE "PurchaseOrderLine" ADD COLUMN IF NOT EXISTS "unitCode" TEXT;
ALTER TABLE "PurchaseOrderLine" ADD COLUMN IF NOT EXISTS "conversionRate" DOUBLE PRECISION NOT NULL DEFAULT 1;

-- PR lập theo mẫu trước đây quy về ĐVT tồn và ghi chú "Đặt <số> <ĐVT>": khôi phục ĐVT đặt khi
-- ghi chú khớp đúng một ĐVT quy đổi của mặt hàng và đúng hệ số (số lượng ÷ số đặt).
WITH parsed AS (
  SELECT l."id", l."itemId", l."quantity", regexp_match(l."note", '^Đặt ([0-9]+(?:\.[0-9]+)?) (.+)$') AS m
  FROM "PurchaseRequestLine" l
  WHERE l."unitCode" IS NULL AND l."note" LIKE 'Đặt %'
)
UPDATE "PurchaseRequestLine" t
SET "unitCode" = c."unitCode", "conversionRate" = c."conversionRate", "note" = NULL
FROM parsed p
JOIN "ItemUnitConversion" c ON c."itemId" = p."itemId" AND c."deletedAt" IS NULL
  AND (c."unitCode" = p.m[2] OR c."unitName" = p.m[2])
WHERE t."id" = p."id" AND p.m IS NOT NULL AND p.m[1]::float > 0
  AND abs(p."quantity" / p.m[1]::float - c."conversionRate") < 0.000001;

-- Kho của mẫu đặt hàng và của yêu cầu mua (phạm vi xem theo kho được phân công).
ALTER TABLE "PurchaseRequestTemplate" ADD COLUMN IF NOT EXISTS "warehouseCode" TEXT;
ALTER TABLE "PurchaseRequest" ADD COLUMN IF NOT EXISTS "warehouseCode" TEXT;
ALTER TABLE "PurchaseRequest" ADD COLUMN IF NOT EXISTS "rejectReason" TEXT;
