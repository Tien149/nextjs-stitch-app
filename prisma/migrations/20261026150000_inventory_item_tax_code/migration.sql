-- Mã hàng thuế của mặt hàng (khách 26/10/2026) — ghi tự do, cho phép trùng nên không có unique.
ALTER TABLE "InventoryItem" ADD COLUMN "taxItemCode" TEXT;
