/**
 * Bỏ cụm hình thức thanh toán ("Quẹt thẻ", "Chuyển khoản") khỏi TÊN nguồn tiền trong danh mục
 * (MasterDataItem type=MONEY_SOURCE), ví dụ:
 *   "FDS quẹt thẻ Vietinbank"          → "FDS Vietinbank"
 *   "ASA - Chuyển Khoản Sacombank (HKD)" → "ASA - Sacombank (HKD)"
 *
 * Dùng chung đúng một hàm cắt chữ với app (stripMoneySourceLabel trong lib/money-sources.ts),
 * cũng chính là hàm mà API danh mục và luồng import gọi lúc lưu — nên nguồn tiền nhập mới đã
 * tự sạch, script này chỉ để dọn dữ liệu có sẵn.
 *
 * Sửa cả hai trường hiển thị: name và summarySourceName ("Nguồn tiền tổng" — báo cáo nguồn tiền
 * lấy tên tổng làm tên dòng khi gộp, nên bỏ sót trường này thì báo cáo vẫn hiện chữ cũ).
 *
 * Mã nguồn tiền (code) KHÔNG đụng tới: mọi phiếu thu/chi, sao kê, điều tiền đều tham chiếu theo
 * code, đổi code là hỏng dữ liệu cũ.
 *
 * Mặc định chỉ DRY-RUN in ra những gì sẽ đổi. Muốn ghi database phải thêm --apply:
 *   npm run clean:money-source-names
 *   npm run clean:money-source-names -- --apply
 */
import { createRequire } from "node:module";
import { stripMoneySourceLabel } from "../lib/money-sources.ts";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/custom-client");

const prisma = new PrismaClient();
const apply = process.argv.includes("--apply");

async function main() {
  const sources = await prisma.masterDataItem.findMany({
    where: { type: "MONEY_SOURCE" },
    select: { id: true, code: true, name: true, summarySourceName: true, branch: true, status: true, deletedAt: true },
    orderBy: [{ branch: "asc" }, { name: "asc" }],
  });

  const changes = [];
  for (const source of sources) {
    const name = stripMoneySourceLabel(source.name);
    const summary = source.summarySourceName ? stripMoneySourceLabel(source.summarySourceName) : source.summarySourceName;
    const data = {};
    // Tên rỗng sau khi cắt nghĩa là nguồn tiền chỉ được đặt tên đúng bằng cụm bị cắt
    // ("Chuyển khoản"); xoá trắng tên thì danh mục mất chỗ dựa để nhận ra dòng, nên bỏ qua
    // và báo lên để người dùng tự đặt lại tên.
    if (name && name !== source.name) data.name = name;
    else if (!name) console.warn(`BỎ QUA (tên sẽ thành rỗng): ${source.code} · ${source.name}`);
    if (summary && summary !== source.summarySourceName) data.summarySourceName = summary;
    if (Object.keys(data).length > 0) changes.push({ source, data });
  }

  console.log(`Nguồn tiền trong danh mục: ${sources.length} · cần đổi tên: ${changes.length}`);
  console.log();
  for (const { source, data } of changes) {
    const state = [source.status, source.deletedAt ? "ĐÃ XOÁ" : null].filter(Boolean).join(" · ");
    console.log(`${source.code.padEnd(16)} [${state}]`);
    if (data.name) console.log(`   tên      : ${source.name}  →  ${data.name}`);
    if (data.summarySourceName) console.log(`   tên tổng : ${source.summarySourceName}  →  ${data.summarySourceName}`);
  }

  if (changes.length === 0) return console.log("Không có gì để sửa.");
  if (!apply) {
    console.log();
    console.log("DRY-RUN: chưa ghi database. Chạy lại kèm --apply để đổi thật.");
    return;
  }

  await prisma.$transaction(changes.map(({ source, data }) => prisma.masterDataItem.update({ where: { id: source.id }, data })));
  console.log();
  console.log(`Đã đổi tên ${changes.length} nguồn tiền.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
