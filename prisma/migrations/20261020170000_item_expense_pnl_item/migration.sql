-- Hạng mục P&L riêng khi bao bì / đồng phục xuất dùng (khách 20/10/2026).
ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "expensePnlItemCode" TEXT;
