/**
 * Bỏ cụm "Chuyển khoản" trong TÊN nguồn tiền của danh mục (MasterDataItem type=MONEY_SOURCE),
 * ví dụ "ASA - Chuyển Khoản Sacombank (HKD)" → "ASA - Sacombank (HKD)".
 *
 * Sửa cả hai trường hiển thị: name và summarySourceName ("Nguồn tiền tổng" — báo cáo nguồn tiền
 * lấy tên tổng làm tên dòng khi gộp, nên bỏ sót trường này thì báo cáo vẫn hiện chữ cũ).
 *
 * Mã nguồn tiền (code) KHÔNG đụng tới: mọi phiếu thu/chi, sao kê, điều tiền đều tham chiếu theo
 * code, đổi code là hỏng dữ liệu cũ. Đổi tên thì an toàn vì không có nghiệp vụ nào dò theo tên
 * (nhóm CASH/BANK/WALLET đọc từ cột group, riêng Grab dò chữ "grab" — không liên quan cụm này).
 *
 * Mặc định chỉ DRY-RUN in ra những gì sẽ đổi. Muốn ghi database phải thêm --apply:
 *   node scripts/rename-money-source-drop-transfer-label.cjs
 *   node scripts/rename-money-source-drop-transfer-label.cjs --apply
 */
const { PrismaClient } = require("@prisma/custom-client");

const prisma = new PrismaClient();
const apply = process.argv.includes("--apply");

/** Giữ đúng một quy tắc cắt chữ với hàm cashSourceLabel() của báo cáo nguồn tiền. */
function stripTransferLabel(value) {
  return value.replace(/chuyển\s+khoản/gi, " ").replace(/\s+/g, " ").trim();
}

async function main() {
  const sources = await prisma.masterDataItem.findMany({
    where: { type: "MONEY_SOURCE" },
    select: { id: true, code: true, name: true, summarySourceName: true, branch: true, status: true, deletedAt: true },
    orderBy: [{ branch: "asc" }, { name: "asc" }],
  });

  const changes = [];
  for (const source of sources) {
    const name = stripTransferLabel(source.name || "");
    const summary = source.summarySourceName ? stripTransferLabel(source.summarySourceName) : source.summarySourceName;
    const data = {};
    // Tên rỗng sau khi cắt nghĩa là nguồn tiền chỉ được đặt tên đúng bằng cụm "Chuyển khoản";
    // xoá trắng tên thì danh mục mất chỗ dựa để nhận ra dòng, nên bỏ qua và báo lên.
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
