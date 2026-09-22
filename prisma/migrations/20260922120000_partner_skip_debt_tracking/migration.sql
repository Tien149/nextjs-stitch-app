-- Cờ "Không theo dõi công nợ" cho danh mục Đối tác (khách lẻ / khách vãng lai).
ALTER TABLE "MasterDataItem" ADD COLUMN IF NOT EXISTS "skipDebtTracking" BOOLEAN NOT NULL DEFAULT false;
