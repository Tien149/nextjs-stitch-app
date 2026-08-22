/**
 * Kiểm tra luồng đọc file doanh thu POS thô: gộp dòng chi tiết theo món thành doanh thu theo
 * ngày và phương thức thanh toán, nhận cửa hàng từ tên đầy đủ, và chọn đúng cột tiền.
 *
 * Chạy: npm run test:pos-raw
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { parseImportFile } from "../lib/import-parser.ts";
import { getImportTemplate } from "../lib/import-templates.ts";
import { validateImportResult } from "../lib/import-validation.ts";
import { prisma, prismaRaw } from "../lib/prisma.ts";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");

const session = { name: "test", role: "Admin", allowedBranches: ["ALL"] };
const template = getImportTemplate("REVENUE_POS", "REVENUE_POS_RAW_V1");

// Validation tra cửa hàng và mã món trong DB, nên test tự seed đúng những mã fixture cần
// rồi dọn lại — không phụ thuộc máy nào đã seed dữ liệu demo của khách hay chưa.
// Dùng prismaRaw cho cả seed lẫn dọn: client `prisma` xoá mềm (chỉ set deletedAt), lần chạy
// sau findFirst lọc bản ghi sống sẽ không thấy nhưng create vẫn đụng unique (type, code).
const seeded = { branch: false, item: false };

before(async () => {
  const branch = await prismaRaw.masterDataItem.findFirst({ where: { type: "BRANCH", code: "NME" } });
  if (!branch) {
    await prismaRaw.masterDataItem.create({
      data: { type: "BRANCH", code: "NME", name: "NAM MÊ Kitchen & Bar", status: "ACTIVE" },
    });
    seeded.branch = true;
  } else if (branch.deletedAt || branch.status !== "ACTIVE") {
    // Xác bản ghi test cũ còn kẹt lại -> hồi sinh cho lần chạy này rồi dọn ở after().
    await prismaRaw.masterDataItem.update({ where: { id: branch.id }, data: { deletedAt: null, status: "ACTIVE" } });
    seeded.branch = true;
  }
  const item = await prismaRaw.inventoryItem.findUnique({ where: { code: "SP001" } });
  if (!item) {
    await prismaRaw.inventoryItem.create({
      data: { code: "SP001", name: "Món test POS", unit: "Phần", itemType: "FINISHED", minStock: 0 },
    });
    seeded.item = true;
  } else if (item.deletedAt) {
    await prismaRaw.inventoryItem.update({ where: { id: item.id }, data: { deletedAt: null } });
    seeded.item = true;
  }
});

after(async () => {
  if (seeded.branch) await prismaRaw.masterDataItem.deleteMany({ where: { type: "BRANCH", code: "NME", name: "NAM MÊ Kitchen & Bar" } });
  if (seeded.item) await prismaRaw.inventoryItem.deleteMany({ where: { code: "SP001", name: "Món test POS" } });
  await prisma.$disconnect();
  await prismaRaw.$disconnect();
});

/** Dựng đúng hình dạng file máy bán hàng xuất ra: mỗi món một dòng, nhiều cột tiền gần giống nhau. */
function posFile(rows) {
  const header = [
    "Cửa hàng", "Mã hàng", "Tên hàng", "PTTT", "Nguồn", "Thời gian", "Số lượng",
    "Thành tiền", "Giảm giá", "Tổng tiền (không bao gồm VAT)", "Tổng tiền",
  ];
  const sheet = XLSX.utils.aoa_to_sheet([header, ...rows]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Import doanh thu");
  const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" });
  return new File([buffer], "pos.xlsx");
}

const line = (pttt, nguon, ngay, thanhTien, khongVat, tongTien) => [
  "NAM MÊ Kitchen & Bar", "SP001", "Món test", pttt, nguon, ngay, 1, thanhTien, 0, khongVat, tongTien,
];

test("gộp dòng theo món thành doanh thu theo ngày và phương thức thanh toán", async () => {
  const parsed = await parseImportFile(posFile([
    line("FDS - GrabFood", "TẠI CHỖ", "01/08/2026", 100, 105, 110),
    line("FDS - GrabFood", "TẠI CHỖ", "01/08/2026", 200, 210, 220),
    line("FDS - GrabFood", "TẠI CHỖ", "02/08/2026", 300, 310, 330),
    line("FDS - Tiền Mặt", "TẠI CHỖ", "01/08/2026", 400, 410, 440),
  ]), template);

  assert.equal(parsed.rows.length, 3, "4 dòng món gộp còn 3 tổ hợp ngày + phương thức");
  const grab = parsed.rows.find((row) => row.values.payment_method === "FDS - GrabFood"
    && row.values.sale_date.toISOString().slice(0, 10) === "2026-08-01");
  assert.equal(grab.values.net_amount, 330, "hai dòng cùng ngày cùng phương thức phải cộng lại");
});

test("lấy đúng cột Tổng tiền, không lấy nhầm Thành tiền hay Tổng tiền chưa gồm VAT", async () => {
  const parsed = await parseImportFile(posFile([
    line("FDS - GrabFood", "TẠI CHỖ", "01/08/2026", 100, 105, 110),
  ]), template);

  // "Thành tiền" là doanh thu trước phí/thuế của dòng món (meeting 22/08/2026); số tiền
  // khách trả vẫn đi qua net_amount = "Tổng tiền", không lấy nhầm cột "Tổng tiền (không bao gồm VAT)".
  assert.equal(parsed.mapping.gross_amount, "Thành tiền");
  assert.equal(parsed.mapping.net_amount, "Tổng tiền");
  assert.equal(parsed.rows[0].values.gross_amount, 100);
  assert.equal(parsed.rows[0].values.net_amount, 110);
});

/** Bố cục chị Bình chốt (Zalo 18/08): Ngày, Cửa hàng, Hình thức bán, Nhóm DT, Nguồn tiền, Doanh thu, SVC, VAT, Tổng doanh thu. */
function posFileChiBinh(rows) {
  const header = ["Ngày", "Cửa hàng", "Hình thức bán", "Nhóm doanh thu", "Nguồn tiền", "Doanh thu", "SVC", "VAT", "Tổng doanh thu"];
  const sheet = XLSX.utils.aoa_to_sheet([header, ...rows]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Import doanh thu");
  return new File([XLSX.write(book, { type: "buffer", bookType: "xlsx" })], "pos-chibinh.xlsx");
}

test("bố cục file chị Bình: map đủ 9 cột, SVC/VAT vào đúng chỗ, cộng gộp giữ công thức", async () => {
  const parsed = await parseImportFile(posFileChiBinh([
    ["01/08/2026", "NME", "Grab", "REV_FOOD", "FDSGRABFOOD", 100, 5, 8, 113],
    ["01/08/2026", "NME", "Grab", "REV_FOOD", "FDSGRABFOOD", 200, 10, 16, 226],
    ["01/08/2026", "NME", "Tại chỗ", "REV_DRINK", "FDSTIENMAT", 300, 0, 24, 324],
  ]), template);
  await validateImportResult(parsed, "REVENUE_POS", session, {});

  assert.equal(parsed.mapping.payment_method, "Nguồn tiền");
  assert.equal(parsed.mapping.revenue_source, "Nhóm doanh thu");
  assert.equal(parsed.mapping.fee_amount, "SVC");
  assert.equal(parsed.mapping.vat_amount, "VAT");
  assert.equal(parsed.rows.length, 2, "hai dòng Grab cùng ngày cùng nguồn tiền phải gộp lại");
  const grab = parsed.rows.find((row) => row.values.payment_method === "FDSGRABFOOD");
  assert.equal(grab.values.gross_amount, 300);
  assert.equal(grab.values.fee_amount, 15);
  assert.equal(grab.values.vat_amount, 24);
  assert.equal(grab.values.net_amount, 339);
  assert.deepEqual(parsed.rows.flatMap((row) => row.errors), [], "công thức khớp thì không dòng nào lỗi");
});

test("Tổng doanh thu lệch Doanh thu + SVC + VAT phải bị chặn ngay tại preview", async () => {
  const parsed = await parseImportFile(posFileChiBinh([
    ["01/08/2026", "NME", "Grab", "REV_FOOD", "FDSGRABFOOD", 100, 5, 8, 999],
  ]), template);
  await validateImportResult(parsed, "REVENUE_POS", session, {});

  assert.equal(parsed.rows[0].errors.length, 1);
  assert.match(parsed.rows[0].errors[0], /không bằng Doanh thu/);
});

test("tách theo kênh bán, vì mỗi kênh là một dòng doanh thu riêng", async () => {
  const parsed = await parseImportFile(posFile([
    line("FDS - GrabFood", "TẠI CHỖ", "01/08/2026", 100, 105, 110),
    line("FDS - GrabFood", "MANG VỀ", "01/08/2026", 100, 105, 120),
  ]), template);

  assert.equal(parsed.rows.length, 2);
  assert.deepEqual(parsed.rows.map((row) => row.values.net_amount).sort((a, b) => a - b), [110, 120]);
});

test("nhận cửa hàng từ tên đầy đủ máy bán hàng ghi, không bắt khách sửa thành mã", async () => {
  const parsed = await parseImportFile(posFile([
    line("FDS - GrabFood", "TẠI CHỖ", "01/08/2026", 100, 105, 110),
  ]), template);
  await validateImportResult(parsed, "REVENUE_POS", session, {});

  assert.deepEqual(parsed.rows[0].errors, [], "không được báo lỗi cửa hàng");
  assert.equal(parsed.rows[0].values.branch_code, "NME", '"NAM MÊ Kitchen & Bar" phải ra mã NME');
});

test("mỗi tổ hợp ngày + phương thức có mã tham chiếu riêng, không báo trùng", async () => {
  const parsed = await parseImportFile(posFile([
    line("FDS - GrabFood", "TẠI CHỖ", "01/08/2026", 100, 105, 110),
    line("FDS - GrabFood", "TẠI CHỖ", "01/08/2026", 200, 210, 220),
    line("FDS - Tiền Mặt", "TẠI CHỖ", "01/08/2026", 400, 410, 440),
  ]), template);
  await validateImportResult(parsed, "REVENUE_POS", session, {});

  const errors = parsed.rows.flatMap((row) => row.errors);
  assert.deepEqual(errors, [], `không được có lỗi nào: ${errors.join(" / ")}`);
});
