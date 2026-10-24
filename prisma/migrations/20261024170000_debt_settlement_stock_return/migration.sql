-- Gạch nợ bằng phiếu xuất trả hàng NCC (cấn vào nợ của phiếu nhập gốc), khách 24/10/2026.
ALTER TABLE "DebtSettlement" ADD COLUMN IF NOT EXISTS "stockTransactionId" TEXT;
CREATE INDEX IF NOT EXISTS "DebtSettlement_stockTransactionId_idx" ON "DebtSettlement"("stockTransactionId");
