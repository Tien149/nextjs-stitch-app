-- Sao kê ngân hàng khai luôn khoản mục thu/chi trên file, để giao dịch được phân loại
-- ngay khi import thay vì đợi đối soát xong mới biết khoản đó là thu hay chi gì.
ALTER TABLE "BankStatementTransaction" ADD COLUMN "categoryCode" TEXT;
CREATE INDEX "BankStatementTransaction_categoryCode_idx" ON "BankStatementTransaction"("categoryCode");
