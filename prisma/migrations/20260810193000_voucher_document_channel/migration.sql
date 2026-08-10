-- Tách kênh chứng từ tiền mặt/ngân hàng mà không làm mất dữ liệu lịch sử.
ALTER TABLE "FinancialVoucher"
ADD COLUMN "documentChannel" TEXT NOT NULL DEFAULT 'CASH',
ADD COLUMN "businessEffect" TEXT NOT NULL DEFAULT 'RECOGNITION';

-- Phiếu tự sinh từ sao kê chắc chắn thuộc kênh ngân hàng.
UPDATE "FinancialVoucher"
SET "documentChannel" = 'BANK'
WHERE "sourceScope" = 'BANK_STATEMENT_AUTO';

-- Backfill các phiếu ngân hàng khác theo nhóm nguồn tiền hiện có.
UPDATE "FinancialVoucher" AS voucher
SET "documentChannel" = 'BANK'
WHERE EXISTS (
  SELECT 1
  FROM "MasterDataItem" AS source
  WHERE source."type" = 'MONEY_SOURCE'
    AND source."code" = voucher."moneySourceCode"
    AND UPPER(COALESCE(source."group", '')) IN ('BANK', 'NGAN_HANG', 'NGÂN HÀNG')
);

CREATE INDEX "FinancialVoucher_documentChannel_idx" ON "FinancialVoucher"("documentChannel");
CREATE INDEX "FinancialVoucher_businessEffect_idx" ON "FinancialVoucher"("businessEffect");
