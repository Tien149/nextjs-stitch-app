-- Điều chuyển "hàng đi đường" (khách 26/10/2026): phiếu chuyển đi trừ kho xuất ngay lúc lập phiếu chờ duyệt.
ALTER TABLE "InventoryTransferRequest" ADD COLUMN "dispatchTransactionId" TEXT;
