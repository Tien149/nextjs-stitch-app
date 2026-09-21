-- Phiếu Điều chỉnh quỹ được khai khoản mục chi phí / thu nhập.
--
-- Trước đây phiếu này chỉ đổi số dư quỹ: không có chỗ khai khoản mục nên trên Báo cáo nguồn
-- tiền nó rơi vào "Chưa phân loại · cần bổ sung", và không sinh bút toán nào nên không bao giờ
-- lên P&L. Khách cần đưa các khoản chênh vặt (khách chuyển thiếu vài đồng, chênh lệch làm tròn)
-- vào chi phí ngay từ chỗ phát hiện ra (khách hỏi 21/09/2026).
--
-- Hai cột để trống = giữ nguyên cách hiểu cũ, nên phiếu đã ghi không đổi một đồng nào.
-- Viết idempotent để chạy được ở cả nơi dùng `prisma migrate deploy` lẫn nơi dựng schema
-- bằng `prisma db push`. Chạy lại nhiều lần không đổi kết quả.
ALTER TABLE "CashbookAdjustment" ADD COLUMN IF NOT EXISTS "categoryCode" TEXT;
ALTER TABLE "CashbookAdjustment" ADD COLUMN IF NOT EXISTS "pnlItemCode" TEXT;
ALTER TABLE "CashbookAdjustment" ADD COLUMN IF NOT EXISTS "sourceType" TEXT;
