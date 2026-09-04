-- Cờ "không theo dõi tồn kho" của NHÓM DOANH THU: doanh thu phụ thu / dịch vụ (REV_PHU) vẫn
-- ghi nhận đủ nhưng không vào hàng chờ "Rã nguyên liệu" và import không tự tạo mặt hàng cho nó.
-- AlterTable
ALTER TABLE "MasterDataItem" ADD COLUMN "skipInventory" BOOLEAN NOT NULL DEFAULT false;
