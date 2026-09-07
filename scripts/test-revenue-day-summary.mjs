import test from "node:test";
import assert from "node:assert/strict";
import { buildRevenueDaySummary, revenueDayKey } from "../lib/revenue-day-summary.ts";

/** Một dòng import doanh thu POS đủ 7 trường mà bảng "Doanh thu theo ngày" cần. */
function row(saleDate, branchCode, amounts = {}) {
  return {
    saleDate,
    branchCode,
    grossAmount: 0,
    discountAmount: 0,
    feeAmount: 0,
    vatAmount: 0,
    netAmount: 0,
    ...amounts,
  };
}

test("ngày nghiệp vụ đọc được cả dữ liệu lưu UTC nửa đêm lẫn nửa đêm giờ Việt Nam", () => {
  assert.equal(revenueDayKey("2026-08-01T00:00:00.000Z"), "2026-08-01");
  assert.equal(revenueDayKey("2026-07-31T17:00:00.000Z"), "2026-08-01");
  assert.equal(revenueDayKey(new Date("2026-08-01T00:00:00.000Z")), "2026-08-01");
  // Chuỗi date-only đã là ngày nghiệp vụ, không được quy đổi múi giờ thêm lần nữa.
  assert.equal(revenueDayKey("2026-08-01"), "2026-08-01");
  assert.equal(revenueDayKey(""), "");
  assert.equal(revenueDayKey("khong phai ngay"), "");
  assert.equal(revenueDayKey(null), "");
});

test("gộp theo ngày bán và cửa hàng, xếp theo ngày tăng dần", () => {
  const { rows } = buildRevenueDaySummary([
    row("2026-08-02T00:00:00.000Z", "ASA", { grossAmount: 100, netAmount: 100 }),
    row("2026-08-01T00:00:00.000Z", "NAMME", { grossAmount: 300, netAmount: 300 }),
    row("2026-08-01T00:00:00.000Z", "ASA", { grossAmount: 200, netAmount: 200 }),
    row("2026-08-01T00:00:00.000Z", "ASA", { grossAmount: 50, netAmount: 50 }),
  ]);

  assert.deepEqual(
    rows.map((entry) => [entry.date, entry.branchCode, entry.rowCount, entry.net]),
    [
      ["2026-08-01", "ASA", 2, 250],
      ["2026-08-01", "NAMME", 1, 300],
      ["2026-08-02", "ASA", 1, 100],
    ],
  );
});

test("tách tiền y hệt bút toán doanh thu POS: hàng bán, SVC, thuế, chênh lệch", () => {
  const { rows, totals } = buildRevenueDaySummary([
    row("2026-08-01", "ASA", {
      grossAmount: 1000,
      discountAmount: 100,
      feeAmount: 50,
      vatAmount: 40,
      netAmount: 1000,
    }),
  ]);

  const [day] = rows;
  assert.equal(day.salesRevenue, 900, "hàng bán = Doanh thu − Giảm giá");
  assert.equal(day.discount, 100);
  assert.equal(day.svc, 50);
  assert.equal(day.vat, 40);
  assert.equal(day.adjust, 10, "phần Tổng tiền chưa giải thích được");
  assert.equal(day.salesRevenue + day.svc + day.vat + day.adjust, day.net, "bốn khoản cộng lại đúng Tổng tiền");
  assert.equal(totals.net, 1000);
});

test("file tổng hợp cũ chỉ có Tổng tiền thì toàn bộ là doanh thu hàng bán", () => {
  const { rows } = buildRevenueDaySummary([row("2026-08-01", "ASA", { netAmount: 750 })]);

  const [day] = rows;
  assert.equal(day.salesRevenue, 750);
  assert.equal(day.adjust, 0);
  assert.equal(day.net, 750);
});

test("cột Tổng tiền cộng lại đúng bằng tổng Tổng tiền của mọi dòng — số khớp dòng Doanh thu trên P&L", () => {
  const source = [
    row("2026-08-01T00:00:00.000Z", "ASA", { grossAmount: 643100, feeAmount: 32155, netAmount: 675255 }),
    row("2026-08-01T00:00:00.000Z", "ASA", { grossAmount: 70000, feeAmount: 3500, netAmount: 73500 }),
    row("2026-08-02T00:00:00.000Z", "NAMME", { grossAmount: 930000, discountAmount: 30000, feeAmount: 46500, vatAmount: 1000, netAmount: 947500 }),
  ];
  const { rows, totals } = buildRevenueDaySummary(source);

  const expected = source.reduce((sum, entry) => sum + entry.netAmount, 0);
  assert.equal(totals.net, expected);
  assert.equal(rows.reduce((sum, entry) => sum + entry.net, 0), expected);
  assert.equal(totals.rowCount, source.length);
});

test("đọc được số dạng chuỗi có dấu phân cách nghìn, dòng hỏng không làm vỡ bảng", () => {
  const { rows, totals } = buildRevenueDaySummary([
    row("2026-08-01", "ASA", { grossAmount: "1.234.000", netAmount: "1.234.000" }),
    row("", "", { netAmount: "khong phai so" }),
  ]);

  assert.equal(totals.net, 1234000);
  // Dòng không đọc được ngày vẫn được đếm, nhưng đứng cuối bảng để không chen vào dãy ngày.
  assert.equal(rows.length, 2);
  assert.equal(rows[rows.length - 1].date, "");
  assert.equal(rows[rows.length - 1].branchCode, "—");
});
