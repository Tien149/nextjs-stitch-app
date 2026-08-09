INSERT INTO "MasterDataItem"
  ("id", "type", "code", "name", "group", "branch", "status", "note", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, 'MONEY_SOURCE', 'FDSCHKHVPBANK', 'FDS - VPBank', 'BANK', 'NME', 'ACTIVE', 'Nguồn ngân hàng dùng trong file Theo dõi nguồn tiền', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("type", "code") DO UPDATE SET
  "name" = EXCLUDED."name",
  "group" = EXCLUDED."group",
  "branch" = EXCLUDED."branch",
  "status" = 'ACTIVE',
  "deletedAt" = NULL,
  "deletedBy" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP;
