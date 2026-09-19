-- Công nợ phải trả: phân biệt "số dư đầu kỳ mang sang" với "chi phí phát sinh trong kỳ".
--
-- Trước đây engine ghi sổ chỉ nhận khoản khai tay (sourceType = MANUAL), còn công nợ nhập từ
-- file luôn bị coi là số dư đầu kỳ nên chi phí không bao giờ lên P&L. Màn import lại không nói
-- điều đó, nên khách đổ công nợ phát sinh hàng tháng bằng file và mất trắng phần chi phí
-- (khách báo 19/09/2026).
--
-- Mặc định false để dữ liệu cũ giữ nguyên cách hiểu; riêng khoản khai tay trước giờ vốn đã
-- được ghi chi phí nên bật lên đúng bằng luật cũ, số liệu các kỳ đã chốt không đổi một đồng.
-- Viết idempotent để chạy được ở cả hai kiểu môi trường: nơi dùng `prisma migrate deploy`,
-- và nơi dựng schema bằng `prisma db push` (cột đã có sẵn, chỉ còn thiếu câu backfill).
-- Chạy lại nhiều lần không đổi kết quả.
ALTER TABLE "DebtRecord" ADD COLUMN IF NOT EXISTS "recognizeExpense" BOOLEAN NOT NULL DEFAULT false;

UPDATE "DebtRecord"
   SET "recognizeExpense" = true
 WHERE "debtType" = 'PAYABLE'
   AND "sourceType" = 'MANUAL'
   AND "recognizeExpense" = false;
