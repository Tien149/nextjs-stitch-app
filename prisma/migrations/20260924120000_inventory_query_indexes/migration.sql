-- Màn Kho & Định lượng cộng tổng nhập/xuất và báo cáo hủy theo cửa hàng ngay trong SQL; lọc
-- theo cửa hàng mà không có chỉ mục là quét trọn bảng phiếu kho.
CREATE INDEX IF NOT EXISTS "InventoryTransaction_branchCode_idx" ON "InventoryTransaction"("branchCode");
