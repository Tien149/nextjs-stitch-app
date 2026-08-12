ALTER TABLE "MasterDataItem" ADD COLUMN "codePrefix" TEXT;

UPDATE "MasterDataItem"
SET "codePrefix" = CASE
  WHEN UPPER(COALESCE("group", '')) IN ('CCDC', 'TOOL') THEN 'CCDC-'
  WHEN UPPER("code") = 'FURNITURE' THEN 'NT-'
  ELSE 'TSCD-'
END
WHERE "type" = 'ASSET_GROUP' AND "codePrefix" IS NULL;
