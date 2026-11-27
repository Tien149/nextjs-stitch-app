-- Thông báo trong app + Web Push (27/11/2026). Viết IF NOT EXISTS để chạy lại an toàn (VPS áp bằng db execute).
CREATE TABLE IF NOT EXISTS "AppNotification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "url" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "dedupeKey" TEXT,
    "readAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AppNotification_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AppNotification_userId_dedupeKey_key" ON "AppNotification"("userId", "dedupeKey");
CREATE INDEX IF NOT EXISTS "AppNotification_userId_createdAt_idx" ON "AppNotification"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "AppNotification_entityType_entityId_idx" ON "AppNotification"("entityType", "entityId");

CREATE TABLE IF NOT EXISTS "WebPushSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "lastSuccessAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WebPushSubscription_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "WebPushSubscription_endpoint_key" ON "WebPushSubscription"("endpoint");
CREATE INDEX IF NOT EXISTS "WebPushSubscription_userId_idx" ON "WebPushSubscription"("userId");

CREATE TABLE IF NOT EXISTS "WebPushVapidKey" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "publicKey" TEXT NOT NULL,
    "privateKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebPushVapidKey_pkey" PRIMARY KEY ("id")
);

-- Vai trò chọn loại thông báo được nhận (tick ở Phân quyền). Mặc định chỉ vai trò Thu Mua nhận
-- "PR chờ duyệt" (khách 27/11/2026); chỉ gán khi cột vừa tạo xong (chạy lại không ghi đè lựa chọn đã sửa).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Role' AND column_name = 'notificationTypes') THEN
    ALTER TABLE "Role" ADD COLUMN "notificationTypes" TEXT[] DEFAULT ARRAY[]::TEXT[];
    UPDATE "Role" SET "notificationTypes" = ARRAY['PR_PENDING'] WHERE lower(trim("name")) = 'thu mua' AND "deletedAt" IS NULL;
  END IF;
END $$;
