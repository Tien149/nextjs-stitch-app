-- Số lượng nhân sự nhận số lẻ 2 chữ số thập phân (khách 28/09/2026): nhân sự chia đôi hai bộ phận ghi 0,5.
ALTER TABLE "PayrollDepartmentRow" ALTER COLUMN "headcount" TYPE DOUBLE PRECISION USING "headcount"::double precision;
