-- Bảng lương gom theo bộ phận: file lương mới bỏ cột Mã/Tên nhân viên, thay bằng số lượng
-- nhân sự, và tách rõ TỔNG CHI PHÍ CÔNG TY (vào P&L) với LƯƠNG THỰC NHẬN (khoản phải trả
-- người lao động). Bảng cũ PayrollImportRow giữ nguyên cho các kỳ đã chốt theo mẫu cũ.
-- CreateTable
CREATE TABLE "PayrollDepartmentRow" (
    "id" TEXT NOT NULL,
    "importBatchId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "branchCode" TEXT NOT NULL,
    "departmentCode" TEXT NOT NULL,
    "headcount" INTEGER NOT NULL DEFAULT 0,
    "monthlySalary" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "hourlySalary" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "mealAllowance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "parkingAllowance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "svcAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "kpiAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "otherAllowance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "companyInsurance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalCompanyCost" DOUBLE PRECISION NOT NULL,
    "netAmount" DOUBLE PRECISION NOT NULL,
    "externalRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "PayrollDepartmentRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PayrollDepartmentRow_period_branchCode_departmentCode_key" ON "PayrollDepartmentRow"("period", "branchCode", "departmentCode");
CREATE INDEX "PayrollDepartmentRow_period_idx" ON "PayrollDepartmentRow"("period");
CREATE INDEX "PayrollDepartmentRow_branchCode_idx" ON "PayrollDepartmentRow"("branchCode");
CREATE INDEX "PayrollDepartmentRow_departmentCode_idx" ON "PayrollDepartmentRow"("departmentCode");
CREATE INDEX "PayrollDepartmentRow_deletedAt_idx" ON "PayrollDepartmentRow"("deletedAt");

-- AddForeignKey
ALTER TABLE "PayrollDepartmentRow" ADD CONSTRAINT "PayrollDepartmentRow_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
