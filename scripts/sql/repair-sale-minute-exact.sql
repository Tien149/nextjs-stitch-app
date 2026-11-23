-- Giờ bán đúng như file đã up (khách 23/11/2026: "lấy đúng giờ chị up lên, đừng đổi giờ").
-- 20–23/11 hệ thống lưu phút theo khung 15 phút (07:10 -> 07:00) nên file tải xuống lệch file up.
-- Lấy lại phút gốc từ ImportRow.rawJson theo cột giờ đã map của lô (mappingJson.sale_hour), chỉ khi
-- ô có dạng HH:MM và đúng giờ đang lưu. Không đổi externalRef: nạp lại các ngày này đã bị chặn theo
-- ngày ở import-commit (EXACT_MINUTE_SINCE).
-- Chạy: psql "$URL" -v ON_ERROR_STOP=1 -f scripts/sql/repair-sale-minute-exact.sql
BEGIN;
WITH src AS (
  SELECT r.id, r."saleHour",
         trim(i."rawJson"::json ->> (b."mappingJson"::json ->> 'sale_hour')) AS raw_time
  FROM "RevenueImportRow" r
  JOIN "ImportRow" i ON i."targetId" = r.id AND i."targetType" = 'REVENUE_POS'
  JOIN "ImportBatch" b ON b.id = r."importBatchId"
  WHERE r."saleMinute" IS NOT NULL AND r."createdAt" < '2026-11-23T05:30:00Z'
    AND b."mappingJson"::json ->> 'sale_hour' IS NOT NULL
),
parsed AS (
  SELECT id, "saleHour", split_part(raw_time, ':', 1)::int AS h, split_part(raw_time, ':', 2)::int AS m
  FROM src WHERE raw_time ~ '^\d{1,2}:\d{2}(:\d{2})?$'
)
UPDATE "RevenueImportRow" t SET "saleMinute" = parsed.m
FROM parsed
WHERE t.id = parsed.id AND parsed.h = parsed."saleHour" AND parsed.m BETWEEN 0 AND 59 AND t."saleMinute" IS DISTINCT FROM parsed.m;

SELECT "branchCode", count(*) AS rows_with_minute, count(*) FILTER (WHERE "saleMinute" % 15 <> 0) AS off_slot
FROM "RevenueImportRow" WHERE "saleMinute" IS NOT NULL AND "deletedAt" IS NULL GROUP BY 1;
COMMIT;
