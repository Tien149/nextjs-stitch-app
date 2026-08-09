CREATE TABLE "BankStatementAllocation" (
    "id" TEXT NOT NULL,
    "bankTransactionId" TEXT NOT NULL,
    "sourceRowNumber" INTEGER NOT NULL,
    "sheetName" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "debitAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "creditAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "grossAmount" DOUBLE PRECISION,
    "sourceDate" TIMESTAMP(3),
    "revenueDate" TIMESTAMP(3),
    "categoryCode" TEXT,
    "summaryMoneySourceCode" TEXT,
    "increaseMoneySourceCode" TEXT,
    "decreaseMoneySourceCode" TEXT,
    "autoProcessType" TEXT,
    "autoProcessNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BankStatementAllocation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BankStatementAllocation_bankTransactionId_sheetName_sourceRowNumber_key"
ON "BankStatementAllocation"("bankTransactionId", "sheetName", "sourceRowNumber");
CREATE INDEX "BankStatementAllocation_bankTransactionId_idx" ON "BankStatementAllocation"("bankTransactionId");
CREATE INDEX "BankStatementAllocation_revenueDate_idx" ON "BankStatementAllocation"("revenueDate");
CREATE INDEX "BankStatementAllocation_categoryCode_idx" ON "BankStatementAllocation"("categoryCode");

ALTER TABLE "BankStatementAllocation"
ADD CONSTRAINT "BankStatementAllocation_bankTransactionId_fkey"
FOREIGN KEY ("bankTransactionId") REFERENCES "BankStatementTransaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Các khoản mục đang xuất hiện trong file vận hành thực tế của khách.
INSERT INTO "MasterDataItem" ("id", "type", "code", "name", "group", "status", "createdAt", "updatedAt") VALUES
  (gen_random_uuid()::text, 'REVENUE_EXPENSE_CATEGORY', 'CHI_BHXH_NHANVIEN', 'Chi bảo hiểm nhân viên', 'PAYMENT', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'REVENUE_EXPENSE_CATEGORY', 'CHI_LUONG_NHANVIEN', 'Chi lương nhân viên', 'PAYMENT', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'REVENUE_EXPENSE_CATEGORY', 'CHI_HOAN_COC', 'Hoàn cọc cho khách', 'PAYMENT', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'REVENUE_EXPENSE_CATEGORY', 'CHI_PHI_QUET_THE', 'Chi phí quẹt thẻ', 'PAYMENT', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'REVENUE_EXPENSE_CATEGORY', 'THU_KHAC', 'Thu khác', 'RECEIPT', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'REVENUE_EXPENSE_CATEGORY', 'CHI_DI_CHUYEN_BOD', 'Chi phí di chuyển của BOD', 'PAYMENT', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("type", "code") DO NOTHING;
