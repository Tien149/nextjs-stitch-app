-- Ca theo từng nhà hàng + phút bán (khách 20/11/2026): báo cáo DT theo ca & món.
ALTER TABLE "RevenueImportRow" ADD COLUMN IF NOT EXISTS "saleMinute" INTEGER;

CREATE TABLE IF NOT EXISTS "SalesShiftConfig" (
    "branchCode" TEXT NOT NULL,
    "shiftsJson" TEXT NOT NULL,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SalesShiftConfig_pkey" PRIMARY KEY ("branchCode")
);

-- Ca khách gửi 20/11/2026. Sửa tiếp trên màn Báo cáo & BI > DT theo ca & món > Cấu hình ca.
INSERT INTO "SalesShiftConfig" ("branchCode", "shiftsJson", "updatedBy", "updatedAt") VALUES
  ('NME', '[{"name":"Sáng","from":"10:00"},{"name":"Tối","from":"15:00"}]', 'Khách chốt 20/11/2026', CURRENT_TIMESTAMP),
  ('ASA', '[{"name":"Sáng","from":"00:00"},{"name":"Trưa","from":"10:30"},{"name":"Tối","from":"15:00"}]', 'Khách chốt 20/11/2026', CURRENT_TIMESTAMP)
ON CONFLICT ("branchCode") DO NOTHING;
