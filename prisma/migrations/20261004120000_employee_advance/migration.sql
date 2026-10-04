-- Tạm ứng & hoàn ứng nhân viên (04/10/2026): khoản mục thu cho nhân viên nộp lại tiền tạm ứng
-- thừa (ghi Có 141, không phải doanh thu). Mã đã có (kể cả đang trong Thùng rác) thì để nguyên.
INSERT INTO "MasterDataItem" ("id", "type", "code", "name", "group", "status", "note", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'REVENUE_EXPENSE_CATEGORY', 'THU_HOAN_UNG', 'Thu Hoàn Tạm Ứng Nhân Viên', 'RECEIPT', 'ACTIVE',
        'Nhân viên nộp lại tiền tạm ứng thừa — giảm tạm ứng (141), không phải doanh thu', NOW(), NOW())
ON CONFLICT ("type", "code") DO NOTHING;

-- Khoản mục chi tạm ứng (VPS đã có sẵn CHI_TAM_UNG — chỉ tạo ở môi trường chưa có).
INSERT INTO "MasterDataItem" ("id", "type", "code", "name", "group", "status", "note", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'REVENUE_EXPENSE_CATEGORY', 'CHI_TAM_UNG', 'Chi Tạm Ứng Nhân Viên', 'PAYMENT', 'ACTIVE',
        'Tạm ứng cho nhân viên — treo 141, vào chi phí khi lập phiếu hoàn ứng ở Công nợ Đối tác', NOW(), NOW())
ON CONFLICT ("type", "code") DO NOTHING;
