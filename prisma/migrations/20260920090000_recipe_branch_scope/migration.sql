-- Định lượng (BOM) theo từng cửa hàng.
--
-- Cùng một mã bán thành phẩm nhưng mỗi cửa hàng pha một công thức khác nhau (khách báo
-- 20/09/2026). Trước đây Recipe chỉ gắn với mã món nên rã nguyên liệu ở cửa hàng nào cũng
-- trừ kho theo đúng một công thức.
--
-- NULL = công thức DÙNG CHUNG cho mọi cửa hàng. Toàn bộ định lượng đang có giữ nguyên là
-- bản chung: nơi nào chưa khai riêng vẫn rã đúng như trước, không phải khai lại gì.
-- Viết idempotent để chạy được ở cả nơi dùng `prisma migrate deploy` lẫn nơi dựng schema
-- bằng `prisma db push`.
ALTER TABLE "Recipe" ADD COLUMN IF NOT EXISTS "branchCode" TEXT;

CREATE INDEX IF NOT EXISTS "Recipe_branchCode_idx" ON "Recipe"("branchCode");
