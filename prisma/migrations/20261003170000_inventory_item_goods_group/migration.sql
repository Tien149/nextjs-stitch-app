-- Nhóm hàng hóa của mặt hàng (khách yêu cầu 03/10/2026): ghi tự do, lọc khi giải trình kiểm kê.
ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "goodsGroup" TEXT;
