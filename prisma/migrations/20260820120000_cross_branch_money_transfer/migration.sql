-- Điều tiền liên nhà hàng (Asa chuyển tiền qua Nam Mê): nguồn đi và nguồn nhận thuộc hai
-- cửa hàng khác nhau, nên phải nhớ cửa hàng của TỪNG đầu để ghi sổ đúng bên và sinh công
-- nợ nội bộ. Cột trống = phiếu điều tiền trong cùng một cửa hàng như trước.
ALTER TABLE "MoneyTransfer" ADD COLUMN "fromBranchCode" TEXT;
ALTER TABLE "MoneyTransfer" ADD COLUMN "toBranchCode" TEXT;
ALTER TABLE "MoneyTransfer" ADD COLUMN "internalReceivableDebtCode" TEXT;
ALTER TABLE "MoneyTransfer" ADD COLUMN "internalPayableDebtCode" TEXT;

CREATE INDEX "MoneyTransfer_fromBranchCode_idx" ON "MoneyTransfer"("fromBranchCode");
CREATE INDEX "MoneyTransfer_toBranchCode_idx" ON "MoneyTransfer"("toBranchCode");
