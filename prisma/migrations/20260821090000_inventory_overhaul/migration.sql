-- Nâng cấp module Kho & Định lượng theo spec vận hành nhà hàng:
--
-- 1) Phiếu kho: thêm phân loại chi tiết (subType — hiện dùng cho loại hủy: hết hạn sử
--    dụng / không đảm bảo chất lượng) và điều chuyển LIÊN nhà hàng. Kho nhận thuộc cửa
--    hàng khác thì nhớ cửa hàng nhận + cặp mã công nợ nội bộ (phải thu ở bên chuyển,
--    phải trả ở bên nhận) — cùng cơ chế với phiếu Điều tiền liên nhà hàng.
ALTER TABLE "InventoryTransaction" ADD COLUMN "subType" TEXT;
ALTER TABLE "InventoryTransaction" ADD COLUMN "toBranchCode" TEXT;
ALTER TABLE "InventoryTransaction" ADD COLUMN "internalReceivableDebtCode" TEXT;
ALTER TABLE "InventoryTransaction" ADD COLUMN "internalPayableDebtCode" TEXT;

CREATE INDEX "InventoryTransaction_subType_idx" ON "InventoryTransaction"("subType");
CREATE INDEX "InventoryTransaction_toBranchCode_idx" ON "InventoryTransaction"("toBranchCode");

-- 2) Định lượng theo file mẫu của kế toán: bán thành phẩm khai định lượng cho MỘT mẻ
--    chuẩn bị (1kg, 400gr, 1 lít...), cần hệ số quy đổi mẻ về ĐVT tồn kho để tính cost.
--    Nguyên liệu trên định lượng có thể khai bằng ĐVT quy đổi (chai830gr...) nên từng
--    dòng nhớ ĐVT + hệ số quy đổi về ĐVT tồn kho của nguyên liệu đó.
ALTER TABLE "Recipe" ADD COLUMN "outputConversionRate" DOUBLE PRECISION NOT NULL DEFAULT 1;
ALTER TABLE "RecipeLine" ADD COLUMN "unitCode" TEXT;
ALTER TABLE "RecipeLine" ADD COLUMN "conversionRate" DOUBLE PRECISION NOT NULL DEFAULT 1;

CREATE INDEX "Recipe_effectiveFrom_idx" ON "Recipe"("effectiveFrom");
