-- Tách phân loại thu/chi thành ba tầng để khớp cấu trúc báo cáo P&L:
--   PNL_GROUP (nhóm hạng mục P&L) -> PNL_ITEM (hạng mục chi tiết) -> REVENUE_EXPENSE_CATEGORY (danh mục thu/chi)
-- Tầng con trỏ về tầng cha bằng cột subGroup.
--
-- "Nhóm thu / chi" cũ (REVENUE_EXPENSE_SUBGROUP) chính là tầng nhóm P&L nên đổi tên loại.
UPDATE "MasterDataItem" SET "type" = 'PNL_GROUP' WHERE "type" = 'REVENUE_EXPENSE_SUBGROUP';

-- Danh mục thu/chi trước đây trỏ thẳng vào nhóm cũ; giờ tầng giữa là PNL_ITEM nên bỏ
-- liên kết cũ để kế toán gán lại hạng mục chi tiết, tránh trỏ nhầm sang tầng nhóm.
UPDATE "MasterDataItem" SET "subGroup" = NULL WHERE "type" = 'REVENUE_EXPENSE_CATEGORY' AND "subGroup" IS NOT NULL;
