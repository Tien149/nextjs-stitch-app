-- Ghi chú từng dòng hàng của phiếu kho (khách 27/10/2026: xuất kho & hủy hàng).
ALTER TABLE "InventoryTransactionLine" ADD COLUMN "note" TEXT;
