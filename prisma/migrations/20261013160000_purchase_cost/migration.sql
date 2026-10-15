-- Chi phí mua hàng trên phiếu nhập mua (khách chốt 13/10/2026): số của phiếu + phần phân bổ từng dòng.
ALTER TABLE "InventoryTransaction" ADD COLUMN IF NOT EXISTS "purchaseCost" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "InventoryTransactionLine" ADD COLUMN IF NOT EXISTS "purchaseCostShare" DOUBLE PRECISION NOT NULL DEFAULT 0;
