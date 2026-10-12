-- Danh mục mã Tài sản / CCDC (master list). Sinh sẵn từ mã đang có: tên / nhóm / phòng ban lấy
-- theo đợt mới nhất còn sống của mã.
CREATE TABLE IF NOT EXISTS "AssetCatalogItem" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "assetGroup" TEXT NOT NULL,
  "departmentCode" TEXT,
  "unit" TEXT,
  "note" TEXT,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3),
  "deletedBy" TEXT,
  CONSTRAINT "AssetCatalogItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AssetCatalogItem_code_key" ON "AssetCatalogItem"("code");
CREATE INDEX IF NOT EXISTS "AssetCatalogItem_assetGroup_idx" ON "AssetCatalogItem"("assetGroup");
CREATE INDEX IF NOT EXISTS "AssetCatalogItem_status_idx" ON "AssetCatalogItem"("status");

INSERT INTO "AssetCatalogItem" ("id", "code", "name", "assetGroup", "departmentCode", "createdBy", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, latest."code", latest."name", latest."assetGroup", latest."departmentCode", 'migration', NOW(), NOW()
FROM (
  SELECT DISTINCT ON ("code") "code", "name", "assetGroup", "departmentCode"
  FROM "AssetRecord"
  WHERE "deletedAt" IS NULL
  ORDER BY "code", "lotNo" DESC
) latest
ON CONFLICT ("code") DO NOTHING;
