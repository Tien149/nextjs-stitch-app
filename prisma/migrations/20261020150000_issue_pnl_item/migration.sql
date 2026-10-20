-- Xuất khác chọn hạng mục P&L, không vào giá vốn (khách 20/10/2026).
ALTER TABLE "InventoryTransaction" ADD COLUMN IF NOT EXISTS "pnlItemCode" TEXT;
