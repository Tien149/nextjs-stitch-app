/**
 * Gắn bộ phận (departmentCode: KIT/BAR/FOH...) cho các dòng doanh thu ĐÃ import trước khi
 * có cột này (feedback chị Bình 26/08/2026 — report_Feedback.pdf). Dòng import mới đã tự
 * gắn lúc commit (lib/import-commit.ts), script này chỉ dọn dữ liệu cũ.
 *
 * Suy luận dùng chung đúng một resolver với luồng import (lib/revenue-department.ts):
 *   mã hàng -> nhóm mặt hàng -> nhóm kho; không có mã hàng thì theo nguồn doanh thu
 *   (REV_FOOD -> KIT, REV_DRINK -> BAR).
 *
 * Đồng thời cập nhật departmentCode cho dòng Có 511 của các bút toán REVENUE_POS đã ghi sổ
 * — chỉ đổi nhãn bộ phận, KHÔNG đụng số tiền nên không làm lệch sổ; kỳ đã khóa vẫn cập
 * nhật được vì bản chất là bổ sung phân loại, không phải sửa nghiệp vụ.
 *
 * Mặc định DRY-RUN in thống kê. Muốn ghi database thêm --apply:
 *   npm run backfill:revenue-department
 *   npm run backfill:revenue-department -- --apply
 */
import { createRequire } from "node:module";
import { buildRevenueDepartmentResolver } from "../lib/revenue-department.ts";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/custom-client");

const prisma = new PrismaClient();
const apply = process.argv.includes("--apply");

async function main() {
  const rows = await prisma.revenueImportRow.findMany({
    where: { deletedAt: null, departmentCode: null },
    select: { id: true, productCode: true, revenueSource: true, branchCode: true },
  });
  console.log(`Dòng doanh thu chưa gắn bộ phận: ${rows.length}`);
  if (rows.length === 0) return;

  const resolve = await buildRevenueDepartmentResolver(prisma, rows.map((row) => row.productCode || ""));

  const byDepartment = new Map();
  const updates = [];
  for (const row of rows) {
    const departmentCode = resolve({ productCode: row.productCode, revenueSource: row.revenueSource });
    const key = departmentCode || "(không suy được)";
    byDepartment.set(key, (byDepartment.get(key) || 0) + 1);
    if (departmentCode) updates.push({ id: row.id, departmentCode });
  }
  console.log("Kết quả suy luận:");
  for (const [department, count] of byDepartment) console.log(`  ${department}: ${count} dòng`);

  if (!apply) {
    console.log("\nDRY-RUN — chưa ghi gì. Chạy lại với --apply để cập nhật.");
    return;
  }

  // Gom theo bộ phận để updateMany theo lô thay vì từng dòng.
  const idsByDepartment = new Map();
  for (const update of updates) {
    const list = idsByDepartment.get(update.departmentCode) || [];
    list.push(update.id);
    idsByDepartment.set(update.departmentCode, list);
  }
  for (const [departmentCode, ids] of idsByDepartment) {
    await prisma.revenueImportRow.updateMany({ where: { id: { in: ids } }, data: { departmentCode } });
    console.log(`Đã gắn ${departmentCode} cho ${ids.length} dòng doanh thu.`);

    // Bút toán 511 tương ứng: chỉ dòng Có (credit > 0) của entry REVENUE_POS mới mang doanh thu.
    const entries = await prisma.journalEntry.findMany({
      where: { sourceType: "REVENUE_POS", sourceId: { in: ids }, deletedAt: null },
      select: { id: true },
    });
    const entryIds = entries.map((entry) => entry.id);
    if (entryIds.length > 0) {
      const result = await prisma.journalLine.updateMany({
        where: { entryId: { in: entryIds }, credit: { gt: 0 }, departmentCode: null },
        data: { departmentCode },
      });
      console.log(`  -> cập nhật ${result.count} dòng bút toán 511.`);
    }
  }
  console.log("\nXong. Mở tab P&L đa chiều / Ngân sách nhân sự để kiểm tra số liệu.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
