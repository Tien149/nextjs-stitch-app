-- Số dư đầu kỳ nguồn vốn & bảng cân đối theo mẫu (04/10/2026) — lib/balance-sheet.ts.
-- Tài khoản mới: vay 341, lợi nhuận chưa phân phối 421, chênh lệch số dư đầu kỳ 4199.
INSERT INTO "AccountingAccount" ("id", "code", "name", "accountType", "normalBalance", "reportGroup", "status", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, '341', 'Vay và nợ khác', 'LIABILITY', 'CREDIT', 'LOAN', 'ACTIVE', NOW(), NOW()),
  (gen_random_uuid()::text, '421', 'Lợi nhuận sau thuế chưa phân phối', 'EQUITY', 'CREDIT', 'RETAINED_EARNINGS', 'ACTIVE', NOW(), NOW()),
  (gen_random_uuid()::text, '4199', 'Chênh lệch số dư đầu kỳ chưa phân loại', 'EQUITY', 'CREDIT', 'OPENING_DIFFERENCE', 'ACTIVE', NOW(), NOW())
ON CONFLICT ("code") DO NOTHING;

UPDATE "AccountingAccount" SET "name" = 'Vốn góp của chủ sở hữu', "updatedAt" = NOW() WHERE "code" = '411';

-- Vế 411 của số dư đầu kỳ đã ghi sổ chỉ là số tự cân, không phải vốn góp: chuyển sang 4199.
UPDATE "JournalLine" l
SET "accountId" = (SELECT "id" FROM "AccountingAccount" WHERE "code" = '4199')
FROM "JournalEntry" e
WHERE e."id" = l."entryId"
  AND e."sourceType" = 'OPENING_BALANCE'
  AND l."accountId" = (SELECT "id" FROM "AccountingAccount" WHERE "code" = '411');
