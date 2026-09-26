-- Tài sản/CCDC nhiều đợt dưới một mã (khách chốt 26/09/2026): mua tăng cùng loại dùng lại mã cũ,
-- số dư đầu kỳ khai hai đợt cùng mã khác thời gian phân bổ. Mỗi đợt là một dòng AssetRecord,
-- khoá duy nhất chuyển từ (code) sang (code, lotNo). Dữ liệu cũ toàn bộ là đợt 1.
ALTER TABLE "AssetRecord" ADD COLUMN IF NOT EXISTS "lotNo" INTEGER NOT NULL DEFAULT 1;
DROP INDEX IF EXISTS "AssetRecord_code_key";
CREATE UNIQUE INDEX IF NOT EXISTS "AssetRecord_code_lotNo_key" ON "AssetRecord"("code", "lotNo");
CREATE INDEX IF NOT EXISTS "AssetRecord_code_idx" ON "AssetRecord"("code");
