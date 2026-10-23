-- NCC theo từng dòng mẫu đặt hàng / dòng PR (khách 23/10/2026).
ALTER TABLE "PurchaseRequestTemplateLine" ADD COLUMN IF NOT EXISTS "supplierCode" TEXT;
ALTER TABLE "PurchaseRequestTemplateLine" ADD COLUMN IF NOT EXISTS "supplierName" TEXT;
ALTER TABLE "PurchaseRequestLine" ADD COLUMN IF NOT EXISTS "supplierCode" TEXT;
ALTER TABLE "PurchaseRequestLine" ADD COLUMN IF NOT EXISTS "supplierName" TEXT;
-- Mẫu đã có NCC mặc định: chép xuống các dòng để giữ nguyên cách đặt hiện tại.
UPDATE "PurchaseRequestTemplateLine" l SET "supplierCode" = t."supplierCode", "supplierName" = t."supplierName"
FROM "PurchaseRequestTemplate" t
WHERE l."templateId" = t."id" AND l."supplierCode" IS NULL AND t."supplierCode" IS NOT NULL;
