-- Nhóm doanh thu khai ngay trên danh mục mặt hàng.
-- File POS của khách xuất ra cột "Nhóm doanh thu" toàn dấu "-", nên doanh thu import về
-- không có danh mục Thu để lên 511 lẫn bộ phận Bếp/Bar. Khai một lần theo mã hàng ở đây,
-- import sau đó tự điền khi cột trong file để trống (lib/revenue-source.ts).
-- AlterTable
ALTER TABLE "InventoryItem" ADD COLUMN "revenueGroup" TEXT;

-- CreateIndex
CREATE INDEX "InventoryItem_revenueGroup_idx" ON "InventoryItem"("revenueGroup");
