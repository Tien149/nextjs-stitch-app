/**
 * Thuế suất GTGT đầu vào trên phiếu nhập mua (khách bổ sung 21/09/2026).
 *
 * Công thức khách chốt:
 *   Thành tiền trước thuế = Số lượng x Đơn giá
 *   Thành tiền sau thuế   = Thành tiền trước thuế x (1 + thuế suất)
 *   ... và thành tiền làm tròn tới đồng.
 *
 * Chạy: npm run test:inventory-vat
 */
import assert from "node:assert/strict";
import test from "node:test";
import { amountAfterTax, parseVatRate, resolveVatAmount, VAT_RATE_CODES, vatAmountOf, vatRateLabel } from "../lib/inventory-vat.ts";

test("đủ 5 lựa chọn khách yêu cầu, đúng thứ tự", () => {
  assert.deepEqual(VAT_RATE_CODES, ["KKKNT", "0%", "5%", "8%", "10%"]);
});

test("đọc được mọi kiểu gõ thuế suất", () => {
  assert.deepEqual(parseVatRate("10%"), { ok: true, rate: 0.1 });
  assert.deepEqual(parseVatRate("10"), { ok: true, rate: 0.1 });
  assert.deepEqual(parseVatRate("8%"), { ok: true, rate: 0.08 });
  // Excel để ô dạng phần trăm thì giá trị thật xuống còn 0.08.
  assert.deepEqual(parseVatRate(0.08), { ok: true, rate: 0.08 });
  assert.deepEqual(parseVatRate("0,05"), { ok: true, rate: 0.05 });
  assert.deepEqual(parseVatRate("0%"), { ok: true, rate: 0 });
});

test("KKKNT khác ô trống về chữ nhưng cùng là không có thuế", () => {
  assert.deepEqual(parseVatRate("KKKNT"), { ok: true, rate: null });
  assert.deepEqual(parseVatRate("kkknt"), { ok: true, rate: null });
  assert.deepEqual(parseVatRate(""), { ok: true, rate: null });
  assert.deepEqual(parseVatRate(null), { ok: true, rate: null });
});

test("thuế suất lạ bị chặn chứ không nhận bừa thành 0%", () => {
  // Nhận bừa là số công nợ phải trả NCC thiếu đúng phần thuế mà không ai thấy.
  for (const value of ["7%", "12%", "abc", "-5%", "100%"]) {
    assert.equal(parseVatRate(value).ok, false, `${value} phai bi chan`);
  }
});

test("tiền thuế làm tròn tới đồng", () => {
  // 41.100 x 2 = 82.200; 8% = 6.576 chẵn.
  assert.equal(vatAmountOf(82200, 0.08), 6576);
  // 26.400 x 2 = 52.800; 5% = 2.640.
  assert.equal(vatAmountOf(52800, 0.05), 2640);
  // Số lẻ phải tròn, không để 1.234,56 đ chui vào sổ.
  assert.equal(vatAmountOf(12345.6, 0.1), 1235);
  assert.equal(Number.isInteger(vatAmountOf(999999, 0.08)), true);
});

test("KKKNT và 0% đều ra 0 đồng thuế", () => {
  assert.equal(vatAmountOf(82200, null), 0);
  assert.equal(vatAmountOf(82200, 0), 0);
});

test("thành tiền sau thuế đúng công thức khách chốt", () => {
  const beforeTax = 2 * 41100;
  assert.equal(beforeTax, 82200);
  assert.equal(amountAfterTax(beforeTax, vatAmountOf(beforeTax, 0.08)), 88776);
  assert.equal(amountAfterTax(beforeTax, vatAmountOf(beforeTax, null)), 82200);
});

test("ô trống và KKKNT là một — mở lại phiếu không mất lựa chọn đã khai", () => {
  // Dòng khai KKKNT lưu xuống `null`; mở lại phiếu phải hiện đúng "KKKNT" chứ không rơi về
  // một mục "không khai" thứ sáu nằm ngoài danh sách khách liệt kê.
  const stored = parseVatRate("KKKNT");
  assert.deepEqual(stored, { ok: true, rate: null });
  assert.equal(vatRateLabel(stored.rate), "KKKNT");
  assert.ok(VAT_RATE_CODES.includes(vatRateLabel(parseVatRate("").rate)));
});

test("nhãn thuế suất hiển thị lại đúng mã đã lưu", () => {
  assert.equal(vatRateLabel(null), "KKKNT");
  assert.equal(vatRateLabel(undefined), "KKKNT");
  assert.equal(vatRateLabel(0), "0%");
  assert.equal(vatRateLabel(0.05), "5%");
  assert.equal(vatRateLabel(0.08), "8%");
  assert.equal(vatRateLabel(0.1), "10%");
  // Nhãn phải quay ngược được về đúng mã trong danh sách, nếu không ô chọn lúc sửa phiếu trống trơn.
  for (const rate of [0, 0.05, 0.08, 0.1]) {
    assert.ok(VAT_RATE_CODES.includes(vatRateLabel(rate)), `${vatRateLabel(rate)} phai nam trong danh sach`);
  }
});

test("tổng thành tiền của phiếu nhiều dòng cộng khớp từng đồng", () => {
  // Tròn ở TỪNG DÒNG nên kế toán cộng tay các dòng phải ra đúng tổng phiếu.
  const lines = [
    { quantity: 2, unitCost: 41100, rate: 0.08 },
    { quantity: 2, unitCost: 26400, rate: 0.05 },
    { quantity: 3, unitCost: 13333.33, rate: null },
  ];
  const computed = lines.map((line) => {
    const beforeTax = Math.round(line.quantity * line.unitCost);
    const vat = vatAmountOf(beforeTax, line.rate);
    return { beforeTax, vat, afterTax: amountAfterTax(beforeTax, vat) };
  });
  const totalAfterTax = computed.reduce((sum, line) => sum + line.afterTax, 0);
  assert.equal(totalAfterTax, computed.reduce((sum, line) => sum + line.beforeTax + line.vat, 0));
  assert.ok(Number.isInteger(totalAfterTax));
});

/**
 * Khai tiền thuế theo hoá đơn (khách 22/09/2026): hoá đơn NCC lệch 1 đ so với số tự tính, mà
 * công nợ phải trả lấy số sau thuế nên phải khai đè được.
 */
test("không khai thì giữ nguyên số tự tính", () => {
  const result = resolveVatAmount({ amountBeforeTax: 1569091, rate: 0.1, declared: null });
  assert.deepEqual(result, { ok: true, vatAmount: 156909, overridden: false });
});

test("khai đúng số hoá đơn lệch 1 đ thì lấy số hoá đơn", () => {
  const result = resolveVatAmount({ amountBeforeTax: 1569091, rate: 0.1, declared: 156910 });
  assert.deepEqual(result, { ok: true, vatAmount: 156910, overridden: true });
});

test("khai trùng số tự tính thì không coi là khai đè", () => {
  const result = resolveVatAmount({ amountBeforeTax: 1569091, rate: 0.1, declared: 156909 });
  assert.equal(result.ok, true);
  assert.equal(result.overridden, false);
});

test("tiền thuế âm bị chặn", () => {
  const result = resolveVatAmount({ amountBeforeTax: 1000000, rate: 0.1, declared: -5 });
  assert.deepEqual(result, { ok: false, reason: "NEGATIVE", computed: 100000 });
});

test("dòng KKKNT / 0% mà khai tiền thuế thì bắt chọn thuế suất trước", () => {
  assert.deepEqual(resolveVatAmount({ amountBeforeTax: 1000000, rate: null, declared: 100000 }), { ok: false, reason: "NO_RATE", computed: 0 });
  assert.deepEqual(resolveVatAmount({ amountBeforeTax: 1000000, rate: 0, declared: 100000 }), { ok: false, reason: "NO_RATE", computed: 0 });
});

test("gõ nhầm thành tiền vào ô tiền thuế thì bị chặn", () => {
  // 1.569.091 gõ vào ô thuế của dòng thuế 156.909 — lệch gấp 10 lần, chặn ngay.
  const result = resolveVatAmount({ amountBeforeTax: 1569091, rate: 0.1, declared: 1569091 });
  assert.deepEqual(result, { ok: false, reason: "TOO_FAR", computed: 156909 });
});

test("biên độ nới theo số thuế: hoá đơn lớn lệch vài trăm đồng vẫn nhận", () => {
  // Thuế 10 triệu -> biên độ 1% = 100.000 đ; lệch 300 đ là chuyện làm tròn bình thường.
  const result = resolveVatAmount({ amountBeforeTax: 100000000, rate: 0.1, declared: 10000300 });
  assert.equal(result.ok, true);
  assert.equal(result.vatAmount, 10000300);
  // Nhưng lệch 200.000 đ thì không còn là làm tròn nữa.
  assert.equal(resolveVatAmount({ amountBeforeTax: 100000000, rate: 0.1, declared: 10200000 }).ok, false);
});
