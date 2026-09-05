-- =====================================================================
-- Chẩn đoán tab "Tiền về đủ chưa" (Báo cáo & BI) khi một kỳ thiếu dòng.
--
-- Dùng khi khách hỏi kiểu "tháng 8 lên đủ mà tháng 9 chỉ có tiền mặt".
-- Tab này đọc ĐÚNG BA nguồn, không nguồn nào khác:
--   - Cột "Doanh thu trong ngày"      <- RevenueImportRow  (file POS import)
--   - Cột "Tiền đã vô" ngân hàng/ví   <- BankStatementAllocation đã phân loại THU_BAN_HANG
--   - Cột "Tiền đã vô" tiền mặt       <- FinancialVoucher RECEIPT đã duyệt
-- Thiếu nguồn nào thì cột đó trống, KHÔNG phải lỗi tính toán.
-- Xem lib/reports.ts -> getRevenueSettlementReport.
--
-- Bộ lọc dưới đây bám đúng bộ lọc của báo cáo, kể cả xoá mềm và lọc khoản mục.
--
-- Chạy:  psql "$DATABASE_URL" -f scripts/chan-doan-tien-ve-du-chua.sql
-- Đổi khoảng kỳ cần soi ở hai dòng \set ngay dưới (ky_dau <= ngày < ky_cuoi).
-- =====================================================================

\set ky_dau  '2026-08-01'
\set ky_cuoi '2026-10-01'

\echo '=== (1) VẾ DOANH THU: dòng POS import theo tháng ==='
\echo '    Tháng nào không ra dòng nào thì cột Doanh thu của tháng đó trống.'
SELECT to_char("saleDate", 'YYYY-MM')  AS thang,
       "branchCode"                    AS cua_hang,
       count(*)                        AS so_dong,
       round(sum("netAmount"))         AS tong_doanh_thu
FROM "RevenueImportRow"
WHERE "deletedAt" IS NULL
  AND "saleDate" >= :'ky_dau' AND "saleDate" < :'ky_cuoi'
GROUP BY 1, 2 ORDER BY 1, 2;

\echo ''
\echo '=== (2) CÁC LÔ IMPORT DOANH THU POS gần nhất ==='
\echo '    Lô ROLLED_BACK bị xoá hết dòng, doanh thu biến mất theo.'
SELECT id, status, "branchCode", "fileName",
       "createdAt"::date   AS ngay_tao,
       "rolledBackAt"::date AS ngay_rollback,
       "rollbackNote"
FROM "ImportBatch"
WHERE "importType" = 'REVENUE_POS'
ORDER BY "createdAt" DESC
LIMIT 15;

\echo ''
\echo '=== (3) VẾ TIỀN VỀ ngân hàng / ví: sao kê đã phân loại THU_BAN_HANG ==='
SELECT to_char(a."revenueDate", 'YYYY-MM') AS thang,
       t."branchCode"                      AS cua_hang,
       a."decreaseMoneySourceCode"         AS nguon_tien,
       count(*)                            AS so_dong,
       round(sum(a."creditAmount"))        AS tien_ve
FROM "BankStatementAllocation" a
JOIN "BankStatementTransaction" t ON t.id = a."bankTransactionId"
WHERE t."deletedAt" IS NULL
  AND a."creditAmount" > 0
  AND a."revenueDate" >= :'ky_dau' AND a."revenueDate" < :'ky_cuoi'
  AND (a."categoryCode" = 'THU_BAN_HANG'
       OR (a."categoryCode" IS NULL AND t."categoryCode" = 'THU_BAN_HANG'))
GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;

\echo ''
\echo '=== (3b) Sao kê ĐÃ import nhưng phân loại KHÁC ==='
\echo '    Ra nhiều dòng nghĩa là tiền về có thật nhưng sai khoản mục nên không lên bảng.'
SELECT to_char(a."revenueDate", 'YYYY-MM') AS thang,
       coalesce(a."categoryCode", t."categoryCode", '(chưa phân loại)') AS khoan_muc,
       count(*)                            AS so_dong,
       round(sum(a."creditAmount"))        AS tien_ghi_co
FROM "BankStatementAllocation" a
JOIN "BankStatementTransaction" t ON t.id = a."bankTransactionId"
WHERE t."deletedAt" IS NULL
  AND a."creditAmount" > 0
  AND a."revenueDate" >= :'ky_dau' AND a."revenueDate" < :'ky_cuoi'
GROUP BY 1, 2 ORDER BY 1, 4 DESC;

\echo ''
\echo '=== (4) VẾ TIỀN VỀ tiền mặt: phiếu thu đã duyệt ==='
\echo '    Thu ngân lập hằng ngày nên nguồn này thường có sẵn kể cả khi chưa import POS.'
SELECT to_char("voucherDate", 'YYYY-MM') AS thang,
       "branchCode"                      AS cua_hang,
       "moneySourceCode"                 AS nguon_tien,
       count(*)                          AS so_phieu,
       round(sum(amount))                AS tien_ve
FROM "FinancialVoucher"
WHERE "deletedAt" IS NULL
  AND "voucherType" = 'RECEIPT'
  AND status IN ('APPROVED', 'POSTED')
  AND "depositAction" IS NULL
  AND "voucherDate" >= :'ky_dau' AND "voucherDate" < :'ky_cuoi'
GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
