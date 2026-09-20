-- Dòng sao kê dựng tay từ phiếu thu.
--
-- Bảng "Tiền về đủ chưa" chỉ đọc sổ sao kê, nên phiếu thu lập tay chưa có dòng sao kê thì
-- không được tính là tiền đã về. Khi sao kê của tài khoản đó chưa import, kế toán không có
-- đường nào khác ngoài đi làm file Excel (khách hỏi 20/09/2026).
--
-- entrySource NULL = dòng đọc từ file sao kê ngân hàng (giữ nguyên toàn bộ dữ liệu cũ).
-- entrySource = 'MANUAL_VOUCHER' = dòng kế toán tự dựng từ phiếu tay: vẫn là lời khai nên
-- hiện nhãn riêng, và khi file sao kê thật được import sau thì dòng thật thay thế nó.
-- Idempotent để chạy được ở cả nơi dùng `prisma migrate deploy` lẫn nơi `prisma db push`.
ALTER TABLE "BankStatementTransaction" ADD COLUMN IF NOT EXISTS "entrySource" TEXT;

CREATE INDEX IF NOT EXISTS "BankStatementTransaction_entrySource_idx" ON "BankStatementTransaction"("entrySource");
