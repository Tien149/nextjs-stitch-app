-- Thue suat GTGT dau vao tren tung dong phieu nhap mua.
--
-- `vatRate` NULL = KKKNT (khong ke khai, nop thue) hoac dong khong khai thue; 0 = thue suat 0%.
-- `vatAmount` la tien thue da lam tron toi dong, KHONG nam trong `totalCost`: gia von ton kho
-- giu so TRUOC thue, con cong no phai tra NCC lay `totalCost` + `vatAmount`.
--
-- Chay nhieu lan khong sao (IF NOT EXISTS): moi dong cu nhan mac dinh vatAmount = 0 nen cong no
-- va ton kho cua du lieu da co khong doi mot dong nao.
ALTER TABLE "InventoryTransactionLine" ADD COLUMN IF NOT EXISTS "vatRate" DOUBLE PRECISION;
ALTER TABLE "InventoryTransactionLine" ADD COLUMN IF NOT EXISTS "vatAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;
