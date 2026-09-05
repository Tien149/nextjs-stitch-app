-- Tỷ trọng lương bộ phận đổi từ khóa NĂM sang THÁNG BẮT ĐẦU ÁP DỤNG (YYYY-MM): chốt quý xong
-- phân bổ lại tỷ lệ cho quý sau mà không đè cả năm. Bộ đã set theo năm cũ coi như áp từ tháng 1.
-- AlterTable
ALTER TABLE "DepartmentCostRatio" RENAME COLUMN "year" TO "period";
UPDATE "DepartmentCostRatio" SET "period" = "period" || '-01' WHERE "period" !~ '-';

-- RenameIndex
ALTER INDEX "DepartmentCostRatio_year_branchCode_departmentCode_metric_key" RENAME TO "DepartmentCostRatio_period_branchCode_departmentCode_metric_key";
ALTER INDEX "DepartmentCostRatio_year_idx" RENAME TO "DepartmentCostRatio_period_idx";
