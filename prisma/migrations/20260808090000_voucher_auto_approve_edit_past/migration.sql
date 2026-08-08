-- Cấp quyền sửa phiếu Thu/Chi ngày cũ cho đúng hai vai trò nghiệp vụ đã chốt.
-- array_append + điều kiện ANY giúp migration chạy an toàn, không tạo quyền trùng.
UPDATE "Role"
SET "actions" = array_append("actions", 'edit_past')
WHERE "name" IN ('Admin', 'Kế toán tổng hợp')
  AND NOT ('edit_past' = ANY("actions"));

-- Phòng trường hợp quyền đã từng bị gán nhầm cho vai trò khác trước khi có rule kép.
UPDATE "Role"
SET "actions" = array_remove("actions", 'edit_past')
WHERE "name" NOT IN ('Admin', 'Kế toán tổng hợp')
  AND 'edit_past' = ANY("actions");
