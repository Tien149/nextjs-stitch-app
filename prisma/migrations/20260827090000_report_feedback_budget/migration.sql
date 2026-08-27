-- Feedback chị Bình 26/08/2026 (report_Feedback.pdf):
-- 1. Doanh thu gắn bộ phận (Bếp/Bar/FOH) để so với tỷ trọng lương từng bộ phận.
-- 2. Ngân sách set được theo % doanh thu, không chỉ trị giá tuyệt đối.
-- 3. Bảng tỷ trọng chi phí chuẩn của từng bộ phận.

-- AlterTable
ALTER TABLE "RevenueImportRow" ADD COLUMN "departmentCode" TEXT;

-- CreateIndex
CREATE INDEX "RevenueImportRow_departmentCode_idx" ON "RevenueImportRow"("departmentCode");

-- AlterTable
ALTER TABLE "ReportTarget"
ADD COLUMN "targetMode" TEXT NOT NULL DEFAULT 'AMOUNT',
ADD COLUMN "targetPercent" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "DepartmentCostRatio" (
    "id" TEXT NOT NULL,
    "year" TEXT NOT NULL,
    "branchCode" TEXT NOT NULL,
    "departmentCode" TEXT NOT NULL,
    "metric" TEXT NOT NULL DEFAULT 'payroll',
    "industryMin" DOUBLE PRECISION,
    "industryMax" DOUBLE PRECISION,
    "ratio" DOUBLE PRECISION NOT NULL,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "DepartmentCostRatio_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DepartmentCostRatio_year_branchCode_departmentCode_metric_key" ON "DepartmentCostRatio"("year", "branchCode", "departmentCode", "metric");
CREATE INDEX "DepartmentCostRatio_year_idx" ON "DepartmentCostRatio"("year");
CREATE INDEX "DepartmentCostRatio_deletedAt_idx" ON "DepartmentCostRatio"("deletedAt");
