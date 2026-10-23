-- Chuyển công nợ phải trả giữa hai đối tác, không qua thu chi (khách 23/10/2026).
CREATE TABLE IF NOT EXISTS "DebtTransfer" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "branchCode" TEXT NOT NULL,
    "documentDate" TIMESTAMP(3) NOT NULL,
    "fromPartnerCode" TEXT NOT NULL,
    "fromPartnerName" TEXT NOT NULL,
    "toPartnerCode" TEXT NOT NULL,
    "toPartnerName" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "description" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DebtTransfer_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "DebtTransfer_code_key" ON "DebtTransfer"("code");
CREATE INDEX IF NOT EXISTS "DebtTransfer_branchCode_idx" ON "DebtTransfer"("branchCode");
CREATE INDEX IF NOT EXISTS "DebtTransfer_fromPartnerCode_idx" ON "DebtTransfer"("fromPartnerCode");
CREATE INDEX IF NOT EXISTS "DebtTransfer_toPartnerCode_idx" ON "DebtTransfer"("toPartnerCode");
CREATE INDEX IF NOT EXISTS "DebtTransfer_documentDate_idx" ON "DebtTransfer"("documentDate");

-- Gạch nợ bằng phiếu chuyển công nợ: không có phiếu thu/chi.
ALTER TABLE "DebtSettlement" ALTER COLUMN "voucherId" DROP NOT NULL;
ALTER TABLE "DebtSettlement" ADD COLUMN IF NOT EXISTS "transferId" TEXT;
CREATE INDEX IF NOT EXISTS "DebtSettlement_transferId_idx" ON "DebtSettlement"("transferId");
DO $$ BEGIN
  ALTER TABLE "DebtSettlement" ADD CONSTRAINT "DebtSettlement_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "DebtTransfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
