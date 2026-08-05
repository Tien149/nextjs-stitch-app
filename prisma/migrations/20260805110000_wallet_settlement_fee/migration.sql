-- Quyết toán ví/POS về ngân hàng: doanh thu ghi nhận đủ ở ví (VD 50tr), ngân hàng chỉ
-- nhận về phần sau phí (49tr), phần chênh (1tr) là phí quẹt thẻ và phải vào chi phí P&L.
-- Ghi chung trên phiếu điều tiền: tiền rời ví = amount + feeAmount.
ALTER TABLE "MoneyTransfer" ADD COLUMN "feeAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "MoneyTransfer" ADD COLUMN "feeCategoryCode" TEXT;
