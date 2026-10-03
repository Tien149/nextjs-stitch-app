-- Ngày áp dụng / ngày kết thúc của mẫu đặt hàng (03/10/2026).
ALTER TABLE "PurchaseRequestTemplate" ADD COLUMN IF NOT EXISTS "effectiveFrom" TIMESTAMP(3);
ALTER TABLE "PurchaseRequestTemplate" ADD COLUMN IF NOT EXISTS "effectiveTo" TIMESTAMP(3);
