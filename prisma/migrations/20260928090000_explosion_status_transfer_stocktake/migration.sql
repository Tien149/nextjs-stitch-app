-- Rã BOM cho điều chuyển bán thành phẩm và phần kiểm dư bán thành phẩm (khách chốt 28/09/2026):
-- null = không có gì để rã, "PENDING" = chờ nút Rã ở tab Chế biến, "POSTED:RA-..." = đã rã.
ALTER TABLE "InventoryTransaction" ADD COLUMN IF NOT EXISTS "explosionStatus" TEXT;
CREATE INDEX IF NOT EXISTS "InventoryTransaction_explosionStatus_idx" ON "InventoryTransaction"("explosionStatus");
ALTER TABLE "StocktakeSession" ADD COLUMN IF NOT EXISTS "explosionStatus" TEXT;
CREATE INDEX IF NOT EXISTS "StocktakeSession_explosionStatus_idx" ON "StocktakeSession"("explosionStatus");
