-- Kiểm kê CCDC/tài sản: ảnh chụp từng dòng + phạm vi phòng ban của người dùng (26/09/2026).
ALTER TABLE "AssetStocktakeLine" ADD COLUMN IF NOT EXISTS "imageUrl" TEXT;

CREATE TABLE IF NOT EXISTS "UserDepartmentAccess" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "departmentCode" TEXT NOT NULL,
    CONSTRAINT "UserDepartmentAccess_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "UserDepartmentAccess_userId_departmentCode_key" ON "UserDepartmentAccess"("userId", "departmentCode");
CREATE INDEX IF NOT EXISTS "UserDepartmentAccess_userId_idx" ON "UserDepartmentAccess"("userId");
DO $$ BEGIN
  ALTER TABLE "UserDepartmentAccess" ADD CONSTRAINT "UserDepartmentAccess_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
