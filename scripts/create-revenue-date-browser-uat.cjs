const fs = require("node:fs");
const path = require("node:path");
const XLSX = require("xlsx");

const outputDir = path.resolve(__dirname, "..", "outputs", "revenue-date-browser-uat");
fs.mkdirSync(outputDir, { recursive: true });

const now = new Date();
const suffix = [
  now.getFullYear(),
  String(now.getMonth() + 1).padStart(2, "0"),
  String(now.getDate()).padStart(2, "0"),
  String(now.getHours()).padStart(2, "0"),
  String(now.getMinutes()).padStart(2, "0"),
  String(now.getSeconds()).padStart(2, "0"),
].join("");

function writeWorkbook(fileName, sheetName, headers, rows, widths) {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  sheet["!cols"] = widths.map((wch) => ({ wch }));
  sheet["!autofilter"] = { ref: `A1:${XLSX.utils.encode_col(headers.length - 1)}${rows.length + 1}` };
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  const outputPath = path.join(outputDir, fileName);
  XLSX.writeFile(workbook, outputPath, { compression: true, cellStyles: true });
  return outputPath;
}

const posHeaders = [
  "Ngày bán",
  "Cửa hàng",
  "Kênh bán",
  "Nguồn doanh thu",
  "Phương thức thanh toán",
  "Số bill",
  "Doanh thu gross",
  "Giảm giá",
  "VAT",
  "Phí nền tảng",
  "Doanh thu net",
  "Mã tham chiếu POS",
];

const posRows = [
  ["08/08/2026", "NME", "Tại nhà hàng", "FDSCHKHVIET", "BANK", 1, 1100000, 0, 0, 0, 1100000, `UAT-POS-BANK-${suffix}`],
  ["08/08/2026", "NME", "MOMO", "MOMO", "MOMO", 1, 1000000, 0, 0, 0, 1000000, `UAT-POS-MOMO-${suffix}`],
  ["07/08/2026", "NME", "MOMO", "MOMO", "MOMO", 1, 500000, 0, 0, 0, 500000, `UAT-POS-MOMO-MULTI-${suffix}`],
];

const statementHeaders = [
  "Ngày hạch toán/Accounting date",
  "Mô tả giao dịch/ Transaction description",
  "Số giao dịch/ Transaction number",
  "Số tài khoản đối ứng/ Corresponsive account",
  "Tên tài khoản đối ứng/ Corresponsive name",
  "Nợ/ Debit",
  "Có / Credit",
  "Ngày nguồn tiền",
  "Ngày doanh thu",
  "Loại thu/chi",
  "Nguồn tiền tổng",
  "Cộng nguồn tiền chi tiết",
  "Trừ nguồn tiền chi tiết",
];

const statementRows = [
  ["09/08/2026", "UAT ví có Ngày doanh thu trong cột", `UAT-WALLET-EXPLICIT-${suffix}`, "", "MOMO", 0, 970000, "09/08/2026", "08/08/2026", "THU_BAN_HANG", "FDSCHKHVIET", "FDSCHKHVIET", "MOMO_EDC_FDS"],
  ["09/08/2026", "UAT ví thiếu cột ngày, quyết toán ngay 08.08.26", `UAT-WALLET-INFERRED-${suffix}`, "", "MOMO", 0, 960000, "09/08/2026", "", "THU_BAN_HANG", "FDSCHKHVIET", "FDSCHKHVIET", "MOMO_EDC_FDS"],
  ["09/08/2026", "UAT ví thiếu hoàn toàn Ngày doanh thu", `UAT-WALLET-MISSING-${suffix}`, "", "MOMO", 0, 950000, "09/08/2026", "", "THU_BAN_HANG", "FDSCHKHVIET", "FDSCHKHVIET", "MOMO_EDC_FDS"],
  ["09/08/2026", "UAT chuyển khoản trực tiếp khác ngày giao dịch", `UAT-BANK-DIRECT-${suffix}`, "", "KH UAT", 0, 1100000, "09/08/2026", "08/08/2026", "THU_BAN_HANG", "FDSCHKHVIET", "FDSCHKHVIET", "FDSCHKHVIET"],
  ["09/08/2026", "UAT ví phân bổ doanh thu ngày 07/08", `UAT-WALLET-MULTI-${suffix}`, "", "MOMO", 0, 400000, "09/08/2026", "07/08/2026", "THU_BAN_HANG", "FDSCHKHVIET", "FDSCHKHVIET", "MOMO_EDC_FDS"],
  ["09/08/2026", "UAT ví phân bổ doanh thu ngày 08/08", `UAT-WALLET-MULTI-${suffix}`, "", "MOMO", 0, 500000, "09/08/2026", "08/08/2026", "THU_BAN_HANG", "FDSCHKHVIET", "FDSCHKHVIET", "MOMO_EDC_FDS"],
];

const posPath = writeWorkbook(
  `uat_revenue_date_pos_${suffix}.xlsx`,
  "Doanh thu POS",
  posHeaders,
  posRows,
  [16, 14, 18, 22, 24, 10, 18, 14, 12, 16, 18, 30],
);
const statementPath = writeWorkbook(
  `uat_revenue_date_statement_${suffix}.xlsx`,
  "Import chuyển khoản",
  statementHeaders,
  statementRows,
  [22, 52, 34, 25, 24, 14, 14, 18, 18, 18, 24, 28, 28],
);

console.log(`POS=${posPath}`);
console.log(`STATEMENT=${statementPath}`);
