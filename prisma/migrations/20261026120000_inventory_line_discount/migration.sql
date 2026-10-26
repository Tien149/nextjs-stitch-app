-- Chiết khấu theo dòng phiếu nhập (khách 26/10/2026): trừ trước thuế, vào giá nhập kho và công nợ NCC.
ALTER TABLE "InventoryTransactionLine" ADD COLUMN "discountRate" DOUBLE PRECISION;
ALTER TABLE "InventoryTransactionLine" ADD COLUMN "discountAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;
