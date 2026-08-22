import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { getImportTemplate } from "../lib/import-templates.ts";
import { parseImportFile } from "../lib/import-parser.ts";
import { ensureRevenuePosReference, revenuePosReferenceKey } from "../lib/revenue-pos-reference.ts";

const template = getImportTemplate("REVENUE_POS", "REVENUE_POS_RAW_V1");

function fileFromRows(sheetName, rows) {
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  const buffer = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  return new File([buffer], "test.xlsx");
}

/**
 * Header đúng theo sheet "Import doanh thu" của file "Theo dõi nguồn tiền" (22/08/2026),
 * giữ nguyên các cột bẫy: "Ngày" chỉ là số ngày trong tháng, "VAT %" là phần trăm,
 * và hai cột "Tổng tiền (...)" khác nghĩa với "Tổng tiền".
 */
const customerHeaders = [
  "Cửa hàng", "Mã hàng", "Tên hàng", "Nhóm món", "Loại món", "Mã combo", "PTTT", "Nguồn",
  "Khu vực", "Bàn", "Mã hoá đơn", "Số HĐ", "Thời gian", "Giờ", "Số lượng", "Đơn vị tính",
  "Giá", "Giá bán", "Thành tiền", "Giảm giá", "Chiết khấu", "Phí hỗ trợ marketing", "Phiếu GG",
  "Phí dịch vụ", "VAT %", "Thuế", "Thuế khấu trừ", "Giảm giá VAT", "Phí ship",
  "Tổng tiền (không bao gồm VAT)", "Hoa hồng", "Tổng tiền (bao gồm hoa hồng)", "Tên CTKM",
  "Mã voucher", "Tên khách", "Số khách", "Số điện thoại", "Nhân viên", "Tổng tiền",
  "Loại nguồn tiền", "Năm", "Tháng", "Ngày",
];

function customerRow({ product, name, group, pttt, quantity, unit, gross, fee, vat, total }) {
  return [
    "NAM MÊ Kitchen & Bar", product, name, group, "ĐỒ ĂN", "-", pttt, "TẠI CHỖ",
    "KHU A", "BÀN 2", "MZZG83N4X82M", "FDS0001", "01/08/2026", "12:06", quantity, unit,
    gross / quantity, gross / quantity, gross, 0, 0, 0, 0,
    fee, "8%", vat, 0, 0, 0,
    gross + fee, 0, total, "",
    "", "", 4, "", "Thanh Hiền", total,
    "BANK - Tài khoản ngân hàng", 2026, 8, 1,
  ];
}

test("file POS chi tiết 43 cột: map đúng cột, né các cột bẫy", async () => {
  const file = fileFromRows("Import doanh thu", [
    customerHeaders,
    customerRow({ product: "BBQ010", name: "Xúc Xích Nướng", group: "BBQ", pttt: "FDS - Chuyển Khoản Vietinbank", quantity: 1, unit: "Phần", gross: 150000, fee: 7500, vat: 12600, total: 170100 }),
    customerRow({ product: "BBQ010", name: "Xúc Xích Nướng", group: "BBQ", pttt: "FDS - Chuyển Khoản Vietinbank", quantity: 2, unit: "Phần", gross: 300000, fee: 15000, vat: 25200, total: 340200 }),
    customerRow({ product: "CF012", name: "Cà Phê Latte", group: "MÊ CÀ PHÊ", pttt: "FDS - Tiền Mặt Thu Ngân", quantity: 1, unit: "Ly", gross: 55000, fee: 2750, vat: 4620, total: 62370 }),
  ]);

  const parsed = await parseImportFile(file, template);

  assert.equal(parsed.mapping.sale_date, "Thời gian", "ngày bán phải lấy từ Thời gian, không phải cột Ngày (số ngày trong tháng)");
  assert.equal(parsed.mapping.branch_code, "Cửa hàng");
  assert.equal(parsed.mapping.product_code, "Mã hàng");
  assert.equal(parsed.mapping.product_name, "Tên hàng");
  assert.equal(parsed.mapping.product_quantity, "Số lượng");
  assert.equal(parsed.mapping.unit, "Đơn vị tính");
  assert.equal(parsed.mapping.payment_method, "PTTT");
  assert.equal(parsed.mapping.channel, "Nguồn");
  assert.equal(parsed.mapping.revenue_source, "Loại món");
  assert.equal(parsed.mapping.gross_amount, "Thành tiền");
  assert.equal(parsed.mapping.discount_amount, "Giảm giá");
  assert.equal(parsed.mapping.fee_amount, "Phí dịch vụ");
  assert.equal(parsed.mapping.vat_amount, "Thuế", "tiền thuế phải lấy từ Thuế, không phải VAT % hay Thuế khấu trừ");
  assert.equal(parsed.mapping.net_amount, "Tổng tiền", "phải khớp khít Tổng tiền, né hai cột Tổng tiền (...)");

  assert.equal(parsed.errorRows, 0, JSON.stringify(parsed.rows.flatMap((row) => row.errors)));
  // 3 dòng file → 2 dòng sau gộp: BBQ010 gộp 2 dòng cùng nguồn tiền, CF012 riêng.
  assert.equal(parsed.rows.length, 2);

  const bbq = parsed.rows.find((row) => row.values.product_code === "BBQ010");
  assert.ok(bbq, "phải còn dòng BBQ010 sau khi gộp");
  assert.equal(bbq.values.sale_date.toISOString().slice(0, 10), "2026-08-01");
  assert.equal(bbq.values.product_quantity, 3, "số lượng bán phải cộng dồn để rã định lượng");
  assert.equal(bbq.values.gross_amount, 450000);
  assert.equal(bbq.values.vat_amount, 37800);
  assert.equal(bbq.values.net_amount, 510300, "Tổng tiền cộng dồn — số lên báo cáo Tiền về đủ chưa");
  assert.equal(bbq.values.payment_method, "FDS - Chuyển Khoản Vietinbank");
  assert.equal(bbq.values.unit, "Phần");

  const coffee = parsed.rows.find((row) => row.values.product_code === "CF012");
  assert.equal(coffee.values.payment_method, "FDS - Tiền Mặt Thu Ngân");

  // Hai dòng gộp phải sinh mã tham chiếu khác nhau (mã hàng nằm trong fingerprint),
  // nếu trùng thì commit sẽ chặn cả file.
  const keys = parsed.rows.map((row) => {
    ensureRevenuePosReference(row.values);
    return revenuePosReferenceKey(row.values);
  });
  assert.equal(new Set(keys).size, keys.length);
});

test("file thô đợt trước (Ngày/Nguồn tiền/Tổng doanh thu) vẫn đọc được", async () => {
  const file = fileFromRows("Import doanh thu", [
    ["Ngày", "Cửa hàng", "Hình thức bán", "Nhóm doanh thu", "Nguồn tiền", "Doanh thu", "SVC", "VAT", "Tổng doanh thu"],
    ["01/08/2026", "NME", "Grab", "REV_FOOD", "FDSGRABFOOD", 500000, 25000, 42000, 567000],
    ["01/08/2026", "NME", "Grab", "REV_FOOD", "FDSGRABFOOD", 100000, 5000, 8400, 113400],
  ]);

  const parsed = await parseImportFile(file, template);

  assert.equal(parsed.mapping.sale_date, "Ngày");
  assert.equal(parsed.mapping.payment_method, "Nguồn tiền");
  assert.equal(parsed.mapping.vat_amount, "VAT");
  assert.equal(parsed.mapping.net_amount, "Tổng doanh thu");
  assert.equal(parsed.errorRows, 0, JSON.stringify(parsed.rows.flatMap((row) => row.errors)));
  assert.equal(parsed.rows.length, 1, "không có mã hàng thì gộp về một dòng mỗi nguồn tiền như trước");
  assert.equal(parsed.rows[0].values.net_amount, 680400);
  assert.equal(parsed.rows[0].values.product_code, null);
});
