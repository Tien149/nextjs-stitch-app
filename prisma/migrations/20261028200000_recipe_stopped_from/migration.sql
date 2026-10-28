-- Ngưng áp dụng định lượng từ ngày (khách 28/10/2026).
ALTER TABLE "Recipe" ADD COLUMN "stoppedFrom" TIMESTAMP(3);
