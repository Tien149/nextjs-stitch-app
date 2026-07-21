import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";

const appRoot = process.cwd();
const publicTemplateDir = path.join(appRoot, "public", "templates");
const referenceTemplateDir = path.join(appRoot, "..", "documents", "reference", "import_templates");

fs.mkdirSync(publicTemplateDir, { recursive: true });
fs.mkdirSync(referenceTemplateDir, { recursive: true });

function saveWorkbook(fileName, rows) {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, "Du lieu mau");

  const publicPath = path.join(publicTemplateDir, fileName);
  const referencePath = path.join(referenceTemplateDir, fileName);
  XLSX.writeFile(workbook, publicPath, { compression: true });
  fs.copyFileSync(publicPath, referencePath);
}

saveWorkbook("mau_sao_ke_ngan_hang.xlsx", [
  ["Ngay giao dich", "Tai khoan", "So tham chieu", "Dien giai", "Ghi no", "Ghi co", "So du", "Chi nhanh", "Goi y doi tac"],
  ["2026-07-01", "VCB_HCM", "VCB2607010001", "POS HCM ngay 01/07 - doanh thu the tai quay", "", 12850000, 2512850000, "HCM", "POS_HCM"],
  ["2026-07-01", "VCB_HCM", "VCB2607010002", "KH_ABC thanh toan cong no dat tiec thang 06", "", 50000000, 2562850000, "HCM", "KH_ABC"],
  ["2026-07-02", "VCB_HCM", "VCB2607020001", "Thanh toan NCC nguyen lieu va bao bi", 18500000, "", 2544350000, "HCM", "NCC_FOOD"],
  ["2026-07-02", "VCB_HCM", "VCB2607020002", "Phi dich vu ngan hang thang 07", 55000, "", 2544295000, "HCM", "VCB"],
  ["2026-07-03", "VCB_HCM", "VCB2607030001", "Vi dien tu doi soat doanh thu delivery", "", 7650000, 2551945000, "HCM", "WALLET_POS"],
]);

saveWorkbook("mau_doanh_thu_pos.xlsx", [
  [
    "Ngay ban",
    "Chi nhanh",
    "Kenh ban",
    "Nguon doanh thu",
    "Phuong thuc thanh toan",
    "So bill",
    "Doanh thu gross",
    "Giam gia",
    "VAT",
    "Phi nen tang",
    "Doanh thu net",
    "Ma tham chieu POS",
  ],
  ["2026-07-01", "HCM", "Dine-in", "REV_FOOD", "Cash", 86, 38500000, 1200000, 2980000, 0, 37300000, "IPOS-HCM-20260701-CASH"],
  ["2026-07-01", "HCM", "Dine-in", "REV_FOOD", "Bank", 72, 42800000, 1600000, 3296000, 0, 41200000, "IPOS-HCM-20260701-BANK"],
  ["2026-07-01", "HCM", "GrabFood", "REV_FOOD", "Wallet", 38, 18600000, 900000, 1416000, 4650000, 13050000, "IPOS-HCM-20260701-GRAB"],
  ["2026-07-02", "HN", "Dine-in", "REV_FOOD", "POS", 64, 31200000, 800000, 2432000, 0, 30400000, "IPOS-HN-20260702-POS"],
  ["2026-07-02", "HN", "ShopeeFood", "REV_FOOD", "Wallet", 29, 14200000, 450000, 1100000, 3550000, 10200000, "IPOS-HN-20260702-SHOPEE"],
]);

saveWorkbook("mau_so_du_dau_ky.xlsx", [
  ["Ky", "Chi nhanh", "Loai so du", "Ma doi tuong", "Ten doi tuong", "Nguon tien", "Kho", "Phong ban", "So luong", "Don gia", "So ky phan bo", "Ky bat dau phan bo", "So tien", "Ghi chu"],
  ["2026-07", "HCM", "BANK", "", "", "VCB_HCM", "", "", "", "", "", "", 2500000000, "So du ngan hang dau ky"],
  ["2026-07", "HCM", "CASH", "", "", "TM_HCM", "", "", "", "", "", "", 120000000, "Quy tien mat dau ky"],
  ["2026-07", "HCM", "AR", "KH_ABC", "Cong ty TNHH ABC", "", "", "", "", "", "", "", 50000000, "Phai thu dau ky"],
  ["2026-07", "HCM", "AP", "NCC_FOOD", "NCC Nguyen lieu", "", "", "", "", "", "", "", 18500000, "Phai tra dau ky"],
  ["2026-07", "HCM", "DEPOSIT", "KH_ABC", "Cong ty TNHH ABC", "VCB_HCM", "", "", "", "", "", "", 7000000, "Tien coc dang giu"],
  ["2026-07", "HCM", "INVENTORY", "NL001", "Nguyen lieu mau", "", "KHO_HCM", "", 50, 32000, "", "", 1600000, "Ton kho dau ky"],
  ["2026-07", "HCM", "ASSET", "TS001", "Thiet bi dau ky", "", "", "STORE", 1, 18000000, "", "", 18000000, "Tai san/CCDC dau ky"],
  ["2026-07", "HCM", "PREPAID_EXPENSE", "PB001", "Chi phi phan bo dau ky", "OPEX_RENT", "", "", "", "", 12, "2026-07", 120000000, "Chi phi phan bo dau ky"],
]);

const readme = `# Import Templates Giai Doan 2

Thu muc nay chua file Excel mau dung de test import khi khach hang chua cung cap file that.

## File

- mau_sao_ke_ngan_hang.xlsx: sao ke ngan hang co cot ngay, tai khoan, so tham chieu, dien giai, ghi no, ghi co, so du.
- mau_doanh_thu_pos.xlsx: doanh thu POS theo ngay, chi nhanh, kenh ban, phuong thuc thanh toan, gross/discount/VAT/fee/net.
- mau_so_du_dau_ky.xlsx: so du dau ky dung doi chieu voi man nhap tay Giai doan 1.

## Nguyen tac

- Data trong file la gia lap, khong chua du lieu that cua khach hang.
- Code import khong hard-code truc tiep ten cot trong route. Mapping nam trong lib/import-templates.ts.
- Neu sau nay khach doi ten cot, uu tien sua alias/mapping truoc khi sua logic nghiep vu.
`;

fs.writeFileSync(path.join(referenceTemplateDir, "README_IMPORT_TEMPLATES.md"), readme, "utf8");
