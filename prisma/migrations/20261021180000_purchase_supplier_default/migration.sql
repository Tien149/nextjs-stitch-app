-- NCC mặc định trên mẫu đặt hàng và NCC đề xuất trên yêu cầu mua.
ALTER TABLE "PurchaseRequestTemplate" ADD COLUMN IF NOT EXISTS "supplierCode" TEXT;
ALTER TABLE "PurchaseRequestTemplate" ADD COLUMN IF NOT EXISTS "supplierName" TEXT;
ALTER TABLE "PurchaseRequest" ADD COLUMN IF NOT EXISTS "supplierCode" TEXT;
ALTER TABLE "PurchaseRequest" ADD COLUMN IF NOT EXISTS "supplierName" TEXT;
