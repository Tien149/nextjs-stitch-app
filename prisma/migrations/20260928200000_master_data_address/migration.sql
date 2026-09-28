-- Địa chỉ cho danh mục (cửa hàng, đối tác). Cửa hàng: in ở "Nơi nhận" trên phiếu đặt hàng gửi NCC.
ALTER TABLE "MasterDataItem" ADD COLUMN IF NOT EXISTS "address" TEXT;
