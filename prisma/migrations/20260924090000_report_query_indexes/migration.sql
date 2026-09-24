-- Chỉ mục cho các cột lọc theo ngày của báo cáo Dòng tiền (Báo cáo & BI). Không có chúng thì
-- mỗi tab mở ra phải quét trọn bảng bút toán / sao kê / lịch sử cọc, dữ liệu càng dài càng chậm.
CREATE INDEX IF NOT EXISTS "JournalEntry_entryDate_idx" ON "JournalEntry"("entryDate");
CREATE INDEX IF NOT EXISTS "JournalEntry_createdAt_idx" ON "JournalEntry"("createdAt");
CREATE INDEX IF NOT EXISTS "BankStatementTransaction_revenueDate_idx" ON "BankStatementTransaction"("revenueDate");
CREATE INDEX IF NOT EXISTS "BankStatementTransaction_sourceDate_idx" ON "BankStatementTransaction"("sourceDate");
CREATE INDEX IF NOT EXISTS "BankStatementAllocation_sourceDate_idx" ON "BankStatementAllocation"("sourceDate");
CREATE INDEX IF NOT EXISTS "DepositHistory_actionDate_idx" ON "DepositHistory"("actionDate");
CREATE INDEX IF NOT EXISTS "ReconciliationMatch_targetId_idx" ON "ReconciliationMatch"("targetId");
