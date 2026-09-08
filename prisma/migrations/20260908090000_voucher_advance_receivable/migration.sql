-- Chi hộ trên phiếu chi / ủy nhiệm chi: khoản tiền chi ra nhưng một đối tác khác sẽ trả lại.
-- Phiếu mang debtAction = 'ACCRUE_RECEIVABLE' treo Nợ 131 của đối tác dưới đây thay vì ghi
-- chi phí, và khi duyệt sẽ tự sinh một khoản công nợ phải thu CNTHU-<mã phiếu>.
-- Để trống với mọi chứng từ cũ nên cách hạch toán lịch sử không đổi.
-- AlterTable
ALTER TABLE "FinancialVoucher" ADD COLUMN "receivablePartnerCode" TEXT;
ALTER TABLE "FinancialVoucher" ADD COLUMN "receivablePartnerName" TEXT;
