/**
 * EBITDA = LN vận hành + CP lãi vay + CAPEX (khách chốt 30/09/2026, thay luật 28/09 "LN gộp −
 * nhân sự − CAPEX − OPEX + khấu hao, trước TN/CP khác" — luật cũ làm EBITDA nhỏ hơn LN vận hành
 * khi có thu nhập khác). Lãi vay là số ghi nhớ nằm trong OPEX (hạng mục "CPCĐ - CP Lãi Vay").
 * KQKD đặt dòng EBITDA SAU dòng LN vận hành.
 *
 * Chạy: node --experimental-strip-types --no-warnings --import ./scripts/register-alias.mjs --test scripts/test-ebitda-depreciation.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { finalizePnl, interestCatalogItemCodes, isInterestPnlLine, PNL_STATEMENT_LINES } from "../lib/reports.ts";
import { finalizeBucket } from "../components/reports/planning/planning-types.ts";

const base = { revenue: 1_000, cogs: 300, payroll: 200, otherOpex: 150, otherIncome: 40, otherExpense: 10, capex: 50, interest: 20 };

test("EBITDA = LN vận hành + CP lãi vay + CAPEX", () => {
  for (const pnl of [finalizePnl(base), finalizeBucket(base)]) {
    assert.equal(pnl.grossProfit, 700);
    assert.equal(pnl.netProfit, 700 - 200 - 50 - 150 + 40 - 10);
    assert.equal(pnl.ebitda, pnl.netProfit + 20 + 50);
    assert.ok(pnl.ebitda >= pnl.netProfit);
  }
});

test("có thu nhập khác: EBITDA không còn nhỏ hơn LN vận hành (Nam Mê T8)", () => {
  const pnl = finalizePnl({ ...base, otherIncome: 30_380_467, interest: 0, capex: 0 });
  assert.equal(pnl.ebitda, pnl.netProfit);
});

test("bucket không có lãi vay: EBITDA = LN vận hành + CAPEX", () => {
  const { interest: _omit, ...legacy } = base;
  assert.equal(finalizePnl(legacy).ebitda, 330 + 50);
  assert.equal(finalizeBucket(legacy).ebitda, 330 + 50);
});

test("nhận hạng mục lãi vay theo tên, chỉ ở dòng OPEX / chi phí khác", () => {
  assert.equal(isInterestPnlLine("otherOpex", { name: "CPCĐ - CP Lãi Vay" }), true);
  assert.equal(isInterestPnlLine("otherExpense", { name: "Chi phí lãi vay ngân hàng" }), true);
  assert.equal(isInterestPnlLine("otherOpex", { name: "CPCĐ - CP Khấu Hao" }), false);
  assert.equal(isInterestPnlLine("otherIncome", { name: "Lãi vay" }), false);
  assert.equal(isInterestPnlLine("otherOpex", null), false);
  assert.deepEqual(interestCatalogItemCodes([
    { code: "CPCD_LAYVAY", name: "CPCĐ - CP Lãi Vay", status: "ACTIVE" },
    { code: "CPCD_KHAUHAO", name: "CPCĐ - CP Khấu Hao", status: "ACTIVE" },
  ]), ["CPCD_LAYVAY"]);
});

test("KQKD: EBITDA là dòng cuối, ngay sau LN vận hành; không còn dòng Khấu hao", () => {
  const keys = PNL_STATEMENT_LINES.map((line) => line.key);
  assert.equal(keys.at(-1), "ebitda");
  assert.equal(keys.at(-2), "netProfit");
  assert.equal(keys.includes("depreciation"), false);
});
