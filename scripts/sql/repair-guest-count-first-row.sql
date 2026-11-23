-- Lượt khách theo Ngày + Ghi chú, lấy DÒNG ĐẦU TIÊN mỗi hoá đơn (khách 23/11/2026).
-- File POS ASA ghi Số khách lặp trên mọi dòng món, số hoá đơn nằm ở cột Ghi chú, không có cột Số hoá
-- đơn -> lúc import mọi dòng giữ nguyên số khách, báo cáo cộng trùng (ASA 11/2026: 37.608 thay vì 7.839).
-- Chỉ đụng dòng có guestCount và có Ghi chú; thứ tự dòng theo ImportRow.sourceRowNumber của file.
-- Chạy: psql "$URL" -v ON_ERROR_STOP=1 -f scripts/sql/repair-guest-count-first-row.sql
BEGIN;
WITH r AS (
  SELECT r.id, (r."saleDate" + interval '7 hours')::date AS d, r."branchCode", trim(r.note) AS bill, r."guestCount",
         i."importBatchId", i."sourceRowNumber"
  FROM "RevenueImportRow" r
  JOIN "ImportRow" i ON i."targetId" = r.id AND i."targetType" = 'REVENUE_POS'
  WHERE r."deletedAt" IS NULL AND r."guestCount" IS NOT NULL AND coalesce(trim(r.note), '') <> ''
),
ranked AS (
  SELECT id, "guestCount",
         row_number() OVER (PARTITION BY d, "branchCode", bill ORDER BY "importBatchId", "sourceRowNumber", id) AS rn
  FROM r
)
UPDATE "RevenueImportRow" t
SET "guestCount" = CASE WHEN ranked.rn = 1 THEN ranked."guestCount" ELSE 0 END,
    "orderCount" = CASE WHEN ranked.rn = 1 THEN 1 ELSE 0 END
FROM ranked
WHERE t.id = ranked.id;

SELECT "branchCode", to_char(("saleDate" + interval '7 hours')::date, 'YYYY-MM') AS ky,
       sum("guestCount") AS luot_khach, sum("orderCount") AS hoa_don
FROM "RevenueImportRow" WHERE "deletedAt" IS NULL AND "guestCount" IS NOT NULL GROUP BY 1, 2 ORDER BY 1, 2;
COMMIT;
