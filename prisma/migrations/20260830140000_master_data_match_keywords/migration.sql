-- Từ khoá nhận dạng khai tay trên danh mục, để người dùng tự dạy hệ thống đọc file mà không
-- phải sửa mã nguồn: file doanh thu ghi "ĐỒ ĂN"/"ĐỒ UỐNG" thay vì mã danh mục Thu.
-- AlterTable
ALTER TABLE "MasterDataItem" ADD COLUMN "matchKeywords" TEXT;
