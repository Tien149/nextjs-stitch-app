-- Nhóm cấp 2 cho khoản mục thu/chi: OPEX -> "Chi phí cố định" -> khoản mục cụ thể.
ALTER TABLE "MasterDataItem" ADD COLUMN "subGroup" TEXT;
CREATE INDEX "MasterDataItem_subGroup_idx" ON "MasterDataItem"("subGroup");
