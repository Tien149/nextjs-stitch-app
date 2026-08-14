ALTER TABLE "AssetRecord"
ADD COLUMN "paymentStatus" TEXT NOT NULL DEFAULT 'UNSPECIFIED',
ADD COLUMN "payableAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN "paymentDueDate" TIMESTAMP(3);

UPDATE "MasterDataItem"
SET "codePrefix" = CASE
  WHEN UPPER(COALESCE("group", '')) IN ('CCDC', 'TOOL') OR UPPER("code") IN ('CCDC', 'TOOL') THEN 'CCDC'
  ELSE 'TSCD'
END
WHERE "type" = 'ASSET_GROUP';

-- Chỉ tự gán các phòng ban phổ biến; phòng ban khác cần cấu hình đúng 3 ký tự.
UPDATE "MasterDataItem"
SET "codePrefix" = CASE
  WHEN UPPER("code") LIKE '%KIT%' OR UPPER("name") LIKE '%BẾP%' OR UPPER("name") LIKE '%BEP%' THEN 'KIT'
  WHEN UPPER("code") LIKE '%BAR%' OR UPPER("name") LIKE '%BAR%' THEN 'BAR'
  WHEN UPPER("code") LIKE '%FOH%' OR UPPER("name") LIKE '%SẢNH%' OR UPPER("name") LIKE '%SANH%' THEN 'FOH'
  ELSE "codePrefix"
END
WHERE "type" = 'DEPARTMENT';
