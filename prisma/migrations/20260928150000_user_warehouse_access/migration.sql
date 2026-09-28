-- Phân quyền kho theo người dùng (28/09/2026): không gán kho nào = mọi kho của cửa hàng được gán.
CREATE TABLE IF NOT EXISTS "UserWarehouseAccess" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "warehouseCode" TEXT NOT NULL,
    CONSTRAINT "UserWarehouseAccess_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "UserWarehouseAccess_userId_warehouseCode_key" ON "UserWarehouseAccess"("userId", "warehouseCode");
CREATE INDEX IF NOT EXISTS "UserWarehouseAccess_userId_idx" ON "UserWarehouseAccess"("userId");
DO $$ BEGIN
  ALTER TABLE "UserWarehouseAccess" ADD CONSTRAINT "UserWarehouseAccess_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
