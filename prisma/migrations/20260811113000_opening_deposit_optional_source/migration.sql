-- Tiền cọc đầu kỳ là số công nợ còn treo, không phải một giao dịch nhận tiền mới.
-- Nguồn tiền thực tế đã được khai báo riêng qua số dư Tiền mặt/Ngân hàng/Ví.
ALTER TABLE "Deposit" ALTER COLUMN "moneySourceCode" DROP NOT NULL;

-- Backfill các số dư cọc đã chốt trước đây nhưng không có nguồn tiền.
WITH inserted AS (
  INSERT INTO "Deposit" (
    "id", "code", "receivedDate", "partnerCode", "partnerName", "branchCode",
    "moneySourceCode", "amount", "remainingAmount", "purpose", "status", "note",
    "sourceOpeningBalanceId", "createdAt", "updatedAt"
  )
  SELECT
    md5(random()::text || clock_timestamp()::text)::uuid::text,
    CONCAT('COC-DK-', REPLACE(opening.period, '-', ''), '-', UPPER(SUBSTRING(opening.id, 1, 8))),
    (opening.period || '-01')::date,
    opening."objectCode",
    COALESCE(opening."objectName", opening."objectCode"),
    opening."branchCode",
    NULL,
    opening.amount,
    opening.amount,
    'Tiền cọc đầu kỳ',
    'HOLDING',
    opening.note,
    opening.id,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  FROM "OpeningBalance" AS opening
  WHERE opening."balanceType" = 'DEPOSIT'
    AND opening.status IN ('POSTED', 'CONFIRMED')
    AND opening."deletedAt" IS NULL
    AND opening."objectCode" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM "Deposit" AS deposit
      WHERE deposit."sourceOpeningBalanceId" = opening.id
    )
  RETURNING id, amount, "receivedDate", "createdAt"
)
INSERT INTO "DepositHistory" (
  "id", "depositId", "action", "amount", "actionDate", "treatmentNote", "actor", "createdAt"
)
SELECT md5(random()::text || clock_timestamp()::text)::uuid::text, id, 'OPENING', amount, "receivedDate", 'Số dư tiền cọc đầu kỳ', 'MIGRATION', "createdAt"
FROM inserted;
