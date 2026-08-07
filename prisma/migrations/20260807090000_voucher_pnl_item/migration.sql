-- Tách phân loại dòng tiền và phân loại quản trị P&L trên từng phiếu thu/chi.
-- Hai cột đều nullable để dữ liệu lịch sử tiếp tục hoạt động và hiện ở nhóm
-- "Chưa phân loại P&L" cho đến khi kế toán gán lại.
ALTER TABLE "FinancialVoucher" ADD COLUMN "pnlItemCode" TEXT;
ALTER TABLE "JournalLine" ADD COLUMN "pnlItemCode" TEXT;

CREATE INDEX "JournalLine_pnlItemCode_idx" ON "JournalLine"("pnlItemCode");
