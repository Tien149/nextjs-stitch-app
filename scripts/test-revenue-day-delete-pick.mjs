import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRevenueDaySummary,
  pickRevenueRowsOfDay,
  revenueDayLabel,
} from "../lib/revenue-day-summary.ts";

/**
 * Nút "Xoá ngày" trên chi tiết lô import: bấm ở dòng nào thì phải xoá đúng những dòng đã cộng
 * vào dòng đó của bảng "Doanh thu theo ngày" — lệch một ngày là xoá mất doanh thu ngày khác.
 */

/** Dòng như Prisma trả về: saleDate là Date lưu UTC nửa đêm. */
const row = (id, iso, branchCode, inventoryStatus = "NOT_REQUIRED") => ({
  id,
  saleDate: new Date(iso),
  branchCode,
  inventoryStatus,
  grossAmount: 100,
  discountAmount: 0,
  feeAmount: 0,
  vatAmount: 0,
  netAmount: 100,
});

const rows = [
  row("a", "2026-08-01T00:00:00Z", "HCW"),
  row("b", "2026-08-02T00:00:00Z", "HCW"),
  row("c", "2026-08-02T00:00:00Z", "HCW", "POSTED_RA-0001"),
  row("d", "2026-08-02T00:00:00Z", "NME"),
  row("e", "2026-08-03T00:00:00Z", "HCW"),
];

test("xoa 1 ngay 1 cua hang khong cham toi ngay khac hay cua hang khac", () => {
  const picked = pickRevenueRowsOfDay(rows, "2026-08-02", "HCW");
  assert.deepEqual(picked.map((item) => item.id), ["b", "c"]);
});

test("bo trong cua hang la moi cua hang cua ngay do", () => {
  const picked = pickRevenueRowsOfDay(rows, "2026-08-02");
  assert.deepEqual(picked.map((item) => item.id), ["b", "c", "d"]);
});

test("ma cua hang khai thuong/hoa hay thua khoang trang van khop", () => {
  assert.equal(pickRevenueRowsOfDay(rows, "2026-08-02", " hcw ").length, 2);
});

test("dong da ra nguyen lieu nam trong phan chon de con chan lai duoc", () => {
  const picked = pickRevenueRowsOfDay(rows, "2026-08-02", "HCW");
  assert.equal(picked.filter((item) => item.inventoryStatus.startsWith("POSTED")).length, 1);
});

test("ngay khong co trong lo thi khong chon gi, ngay rac cung vay", () => {
  assert.equal(pickRevenueRowsOfDay(rows, "2026-08-09").length, 0);
  assert.equal(pickRevenueRowsOfDay(rows, "").length, 0);
  assert.equal(pickRevenueRowsOfDay(rows, "khong-phai-ngay").length, 0);
});

test("dung dung nhom ngay voi bang Doanh thu theo ngay tren man hinh", () => {
  // Bấm ở dòng nào của bảng thì số dòng bị xoá phải đúng bằng cột "Số dòng" của dòng đó.
  for (const summaryRow of buildRevenueDaySummary(rows).rows) {
    const picked = pickRevenueRowsOfDay(rows, summaryRow.date, summaryRow.branchCode);
    assert.equal(picked.length, summaryRow.rowCount, `${summaryRow.date} ${summaryRow.branchCode}`);
  }
});

test("dong luu nua dem gio may chu (du lieu cu) van thuoc dung ngay", () => {
  // Trước 09/2026 saleDate lưu 00:00 giờ Việt Nam = 17:00 UTC hôm trước.
  const legacy = [row("f", "2026-08-01T17:00:00Z", "HCW")];
  assert.equal(pickRevenueRowsOfDay(legacy, "2026-08-02", "HCW").length, 1);
  assert.equal(pickRevenueRowsOfDay(legacy, "2026-08-01", "HCW").length, 0);
});

test("nhan ngay trong cau thong bao theo kieu Viet Nam", () => {
  assert.equal(revenueDayLabel("2026-08-02"), "02/08/2026");
  assert.equal(revenueDayLabel("khong-ro"), "khong-ro");
});
