-- Ảnh chứng từ: phiếu hủy hàng & điều chuyển bắt buộc có ảnh (khách 28/11/2026).
CREATE TABLE IF NOT EXISTS "DocumentImage" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "content" BYTEA NOT NULL,
    "uploadedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DocumentImage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "DocumentImage_entityType_entityId_idx" ON "DocumentImage"("entityType", "entityId");
