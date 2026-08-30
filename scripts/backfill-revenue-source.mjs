/**
 * Chuẩn hoá "Nhóm doanh thu" (revenueSource) cho các dòng doanh thu ĐÃ import — bản dòng lệnh
 * của nút "Chuẩn hoá nhóm doanh thu đã import" trên màn hình Cài đặt > Danh mục Thu/Chi.
 * Người dùng bình thường bấm nút; script này để chạy hàng loạt trên server hoặc khi cần log.
 *
 * Luật và phạm vi ghi nằm hết trong lib/revenue-source-normalize.ts (dùng chung với nút bấm).
 *
 * Mặc định DRY-RUN in thống kê. Muốn ghi database thêm --apply:
 *   npm run backfill:revenue-source
 *   npm run backfill:revenue-source -- --apply
 */
import { createRequire } from "node:module";
import { normalizeRevenueSources } from "../lib/revenue-source-normalize.ts";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/custom-client");

const prisma = new PrismaClient();
const apply = process.argv.includes("--apply");

async function main() {
  const result = await normalizeRevenueSources(prisma, { apply });
  console.log(`Dòng doanh thu đang có: ${result.total}`);
  console.log(`  (giữ nguyên) không phải sửa gì: ${result.unchanged} dòng`);
  if (result.unresolved > 0) {
    console.log(`  (bỏ qua) không quy được chữ trong file và mã hàng cũng chưa gán Nhóm doanh thu: ${result.unresolved} dòng`);
  }
  if (result.groups.length === 0) {
    console.log("Không có dòng nào cần đổi.");
    return;
  }

  console.log("Sẽ chuyển thành:");
  for (const group of result.groups) {
    console.log(`  ${group.revenueSource}${group.departmentCode ? ` / ${group.departmentCode}` : " / (chưa suy được bộ phận)"}: ${group.rows} dòng`);
  }

  if (!result.applied) {
    console.log("\nDRY-RUN — chưa ghi gì. Khai Nhóm doanh thu / Từ khoá nhận dạng cho các món còn thiếu rồi chạy lại với --apply.");
    return;
  }
  console.log(`\nĐã cập nhật ${result.changedRows} dòng doanh thu và ${result.journalLines} dòng bút toán 511.`);
  console.log("Mở Báo cáo > P&L đa chiều để kiểm tra doanh thu đã về đúng nhóm.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
