/**
 * Liệt kê các mặt hàng TRÙNG TÊN (cùng tên, khác mã) để gửi khách chốt mã chính trước khi
 * gắn định lượng/BOM — gắn BOM vào mã này nhưng POS bán mã kia là không trừ kho.
 *
 * Chỉ ĐỌC dữ liệu, không sửa gì. Kết quả in ra màn hình và ghi file Excel trong outputs/.
 *
 * Chạy: node scripts/report-duplicate-items.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const XLSX = require("xlsx");
const { PrismaClient } = require("@prisma/custom-client");

const prisma = new PrismaClient();

async function main() {
  const items = await prisma.inventoryItem.findMany({
    where: { deletedAt: null },
    select: { code: true, name: true, itemType: true, unit: true, category: true, status: true },
    orderBy: { name: "asc" },
  });
  const byName = new Map();
  for (const item of items) {
    const key = item.name.trim().toLowerCase();
    byName.set(key, [...(byName.get(key) || []), item]);
  }
  const duplicated = [...byName.values()].filter((group) => group.length > 1);
  console.log(`Tổng mặt hàng: ${items.length} · Tên bị trùng: ${duplicated.length} nhóm`);
  console.log();

  const rows = [];
  for (const group of duplicated.sort((a, b) => b.length - a.length)) {
    console.log(`${String(group.length).padStart(2)} mã · ${group[0].name}`);
    for (const item of group) {
      console.log(`     ${item.code.padEnd(16)} ${item.itemType.padEnd(14)} ${item.unit.padEnd(8)} ${item.status}`);
      rows.push({
        "Tên mặt hàng": group[0].name,
        "Số mã trùng": group.length,
        "Mã": item.code,
        "Loại": item.itemType,
        "ĐVT": item.unit,
        "Nhóm": item.category || "",
        "Trạng thái": item.status,
        "Mã CHÍNH (khách đánh dấu X)": "",
      });
    }
  }

  const outDir = path.join(__dirname, "..", "outputs");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const outFile = path.join(outDir, `mat_hang_trung_ten_${stamp}.xlsx`);
  const sheet = XLSX.utils.json_to_sheet(rows);
  sheet["!cols"] = [{ wch: 40 }, { wch: 10 }, { wch: 18 }, { wch: 14 }, { wch: 8 }, { wch: 14 }, { wch: 10 }, { wch: 24 }];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Trung ten");
  XLSX.writeFile(book, outFile);
  console.log();
  console.log(`Đã ghi file gửi khách: ${outFile}`);
}

main()
  .catch((error) => { console.error("LỖI:", error.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
