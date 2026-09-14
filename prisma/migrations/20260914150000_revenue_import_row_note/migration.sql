-- Ghi chú tự do trên từng dòng doanh thu đã import.
-- Một tháng doanh thu POS lên tới hàng nghìn dòng, soát tay không có chỗ đánh dấu dòng nào
-- đã đối chiếu, dòng nào còn phải hỏi lại. Cột này thuần văn bản, không tham gia phép tính
-- nào và không ảnh hưởng bút toán. Để trống với dữ liệu cũ.
-- AlterTable
ALTER TABLE "RevenueImportRow" ADD COLUMN "note" TEXT;
