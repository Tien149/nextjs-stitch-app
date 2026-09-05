-- Phí sàn giữ lại trên từng dòng doanh thu POS: phí quẹt thẻ và phí bán hàng qua app.
-- Là CHI PHÍ của nhà hàng (Nợ 6428, tiền thực nhận giảm đúng số này), khác hẳn cột SVC
-- (`feeAmount`) vốn là doanh thu phụ thu dịch vụ.
-- Mặc định 0 để dòng doanh thu đã import trước đây giữ nguyên cách hạch toán cũ.
-- AlterTable
ALTER TABLE "RevenueImportRow" ADD COLUMN "cardFeeAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "RevenueImportRow" ADD COLUMN "appFeeAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;
