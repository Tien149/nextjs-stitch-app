ALTER TABLE "MoneyTransfer"
ADD COLUMN "grabExpenseAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN "grabExpenseCategoryCode" TEXT;

INSERT INTO "MasterDataItem" ("id", "type", "code", "name", "group", "status", "createdAt", "updatedAt") VALUES
  (gen_random_uuid()::text, 'REVENUE_EXPENSE_CATEGORY', 'CHI_PHI_BAN_HANG_GRAB', 'Chi phí bán hàng Grab', 'PAYMENT', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'REVENUE_EXPENSE_CATEGORY', 'CHI_PHI_QUET_THE', 'Chi phí quẹt thẻ', 'PAYMENT', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("type", "code") DO UPDATE SET "status" = 'ACTIVE', "updatedAt" = CURRENT_TIMESTAMP;
