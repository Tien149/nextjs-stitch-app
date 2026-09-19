/**
 * Chẩn đoán "đã phân bổ giảm rồi mà Tổng hợp chi phí vẫn hiện đủ số".
 *
 * Phiếu phân bổ chỉ kéo chi phí xuống ở ĐÚNG kỳ, ĐÚNG nhà hàng, ĐÚNG hạng mục của bút toán
 * gốc. Script này in ra cạnh nhau: phiếu phân bổ nằm ở kỳ nào, và chi phí của chính hạng mục
 * đó ở nhà hàng đã trả đang nằm ở những kỳ nào — lệch chỗ nào là thấy ngay.
 *
 * Chạy:
 *   npm run chan-doan:phan-bo
 *   npm run chan-doan:phan-bo -- --hang-muc "Bảo Trì" --nha-hang NME
 */
import { prisma } from "@/lib/prisma";
import { postedExpenseForPnlItem } from "@/lib/expense-summary";

const arg = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : null;
};
const money = (value) => new Intl.NumberFormat("vi-VN").format(Math.round(value));
const keyword = arg("hang-muc");
const branchFilter = arg("nha-hang");

const reallocations = await prisma.costReallocation.findMany({
  where: {
    ...(branchFilter ? { fromBranchCode: branchFilter.toUpperCase() } : {}),
  },
  include: { lines: true },
  orderBy: [{ documentDate: "desc" }],
  take: 50,
});

const pnlItems = await prisma.masterDataItem.findMany({ where: { type: "PNL_ITEM" }, select: { code: true, name: true } });
const itemName = new Map(pnlItems.map((row) => [row.code, row.name]));
const matches = reallocations.filter((row) => !keyword
  || (itemName.get(row.pnlItemCode) || "").toLowerCase().includes(keyword.toLowerCase())
  || row.pnlItemCode.toLowerCase().includes(keyword.toLowerCase()));

if (matches.length === 0) {
  console.log("Không tìm thấy phiếu phân bổ nào khớp bộ lọc.");
  process.exit(0);
}

for (const row of matches) {
  const name = itemName.get(row.pnlItemCode) || row.pnlItemCode;
  console.log(`\n=== ${row.code} · ngày ${row.documentDate.toISOString().slice(0, 10)} · KỲ ${row.period} · ${row.status}`);
  console.log(`    ${row.fromBranchCode} giảm ${money(row.totalAmount)} đ ở hạng mục "${name}" [${row.pnlItemCode}]`);
  for (const line of row.lines) console.log(`      -> ${line.toBranchCode} nhận ${money(line.amount)} đ`);

  // Chi phí của chính hạng mục đó ở nhà hàng đã trả, quanh kỳ của phiếu: kỳ nào có số dương
  // lớn mà không phải kỳ của phiếu, nghĩa là ngày chứng từ đang sai kỳ.
  const [year, month] = row.period.split("-").map(Number);
  console.log(`    Chi phí hạng mục này ở ${row.fromBranchCode} theo kỳ (đã trừ mọi phiếu phân bổ):`);
  for (let offset = -3; offset <= 1; offset += 1) {
    const date = new Date(Date.UTC(year, month - 1 + offset, 1));
    const period = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    const amount = await postedExpenseForPnlItem(period, row.fromBranchCode, row.pnlItemCode);
    const mark = period === row.period ? "  <-- kỳ của phiếu phân bổ" : "";
    if (amount !== 0 || period === row.period) console.log(`      ${period}: ${money(amount)} đ${mark}`);
  }
}
process.exit(0);
