/**
 * Bảng Nhập - Xuất - Tồn (lib/stock-summary.ts): trị giá cộng ĐI TỚI theo chứng từ (khách 27/10/2026)
 * — tháng chưa có phát sinh ra 0 dù kho đang tồn âm và giá bình quân hiện tại khác giá các phiếu xuất;
 * số dư đầu kỳ đã khai là gốc trị giá; số lượng vẫn lùi từ tồn hiện tại.
 *
 * Thuần, không cần DB. Chạy: npm run test:stock-summary
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildStockSummary } from "../lib/stock-summary.ts";

// Mốc kỳ: phiếu trước kỳ / trong kỳ / sau kỳ. Hàm chỉ nhận các tổng đã cộng sẵn theo mốc.
const row = (transactionType, side, { before = [0, 0], inPeriod = [0, 0], after = [0, 0] }) => ({
  itemId: "I", warehouseCode: "K", transactionType, side,
  quantity: inPeriod[0], value: inPeriod[1],
  afterFromQuantity: inPeriod[0] + after[0], afterFromValue: inPeriod[1] + after[1],
  afterToQuantity: after[0], afterToValue: after[1],
  totalQuantity: before[0] + inPeriod[0] + after[0], totalValue: before[1] + inPeriod[1] + after[1],
});

test("tháng trước mọi phát sinh: đầu kỳ = 0 dù kho tồn âm, giá BQ khác giá phiếu (Phô Mai Cam ASA)", () => {
  // Nhập 1.000 g × 300 = 300.000; xuất 3.272,4 g ghi 531.040 → sổ phiếu −2.272,4 g / −231.040 đ; giá BQ hiện 400.
  const movements = [
    row("NHAP_MUA", "FROM", { after: [1000, 300000] }),
    row("XUAT_CHE_BIEN", "FROM", { after: [3272.4, 531040] }),
  ];
  const [summary] = buildStockSummary([{ itemId: "I", warehouseCode: "K", quantity: -2272.4, averageCost: 400 }], movements);
  assert.equal(summary.openingQuantity, 0);
  assert.equal(summary.openingValue, 0, "trước đây lùi từ −908.960 ra −677.920");
  assert.equal(summary.closingValue, 0);
});

test("kỳ có phát sinh: đầu kỳ + nhập − xuất = cuối kỳ theo trị giá chứng từ", () => {
  const movements = [
    row("NHAP_MUA", "FROM", { before: [10, 100000], inPeriod: [5, 60000], after: [2, 25000] }),
    row("XUAT_BAN", "FROM", { before: [4, 40000], inPeriod: [6, 66000] }),
  ];
  const [summary] = buildStockSummary([{ itemId: "I", warehouseCode: "K", quantity: 7, averageCost: 99999 }], movements);
  assert.equal(summary.openingQuantity, 6);
  assert.equal(summary.openingValue, 60000);
  assert.equal(summary.closingQuantity, 5);
  assert.equal(summary.closingValue, 54000);
  assert.equal(summary.openingValue + summary.inboundValue - summary.outboundValue, summary.closingValue);
});

test("số dư đầu kỳ đã khai là gốc trị giá; phần số lượng không phiếu nào giải thích lấy giá BQ", () => {
  const movements = [row("XUAT_BAN", "FROM", { inPeriod: [3, 36000] })];
  const openings = [{ itemId: "I", warehouseCode: "K", quantity: 10, value: 120000 }];
  const [withOpening] = buildStockSummary([{ itemId: "I", warehouseCode: "K", quantity: 7, averageCost: 12000 }], movements, openings);
  assert.equal(withOpening.openingQuantity, 10);
  assert.equal(withOpening.openingValue, 120000);
  assert.equal(withOpening.closingValue, 84000);
  // Tồn cũ 2 đơn vị không có phiếu/đầu kỳ nào (dữ liệu cũ) → coi như có từ trước, giá BQ 15.000.
  const [ghost] = buildStockSummary([{ itemId: "I", warehouseCode: "K", quantity: 9, averageCost: 15000 }], movements, openings);
  assert.equal(ghost.openingQuantity, 12);
  assert.equal(ghost.openingValue, 150000);
});
