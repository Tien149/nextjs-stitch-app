-- Phiếu chi đại diện: một người nhận, nhiều đối tác.
-- 1) Người nhận tiền tách khỏi đối tác công nợ.
ALTER TABLE "FinancialVoucher" ADD COLUMN "recipientName" TEXT;

-- 2) Một phiếu có thể gạch nhiều khoản công nợ -> bỏ unique, thay bằng index thường.
DROP INDEX "DebtSettlement_voucherId_key";
CREATE INDEX "DebtSettlement_voucherId_idx" ON "DebtSettlement"("voucherId");

-- 3) Bảng dòng phân bổ đối tác của phiếu.
CREATE TABLE "VoucherAllocation" (
    "id" TEXT NOT NULL,
    "voucherId" TEXT NOT NULL,
    "partnerCode" TEXT NOT NULL,
    "partnerName" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "debtReference" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoucherAllocation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "VoucherAllocation_voucherId_idx" ON "VoucherAllocation"("voucherId");
CREATE INDEX "VoucherAllocation_partnerCode_idx" ON "VoucherAllocation"("partnerCode");

ALTER TABLE "VoucherAllocation" ADD CONSTRAINT "VoucherAllocation_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "FinancialVoucher"("id") ON DELETE CASCADE ON UPDATE CASCADE;
