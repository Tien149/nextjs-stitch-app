-- Tách cột bảo hiểm trên bảng lương theo bộ phận làm hai: phần công ty chịu (đã có, cộng vào
-- TỔNG CHI PHÍ CÔNG TY) và phần bảo hiểm bắt buộc trừ vào lương người lao động. Phần bắt buộc
-- không phải chi phí của công ty nên mặc định 0 cho các kỳ đã import theo mẫu cũ; hai cột cộng
-- lại là khoản phải trả cơ quan BHXH.
ALTER TABLE "PayrollDepartmentRow" ADD COLUMN "mandatoryInsurance" DOUBLE PRECISION NOT NULL DEFAULT 0;
