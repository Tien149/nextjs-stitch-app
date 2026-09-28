/**
 * EBITDA = LN gộp − nhân sự − CAPEX − OPEX + khấu hao, TRƯỚC thu nhập/chi phí khác (khách chốt
 * 28/09/2026). Khấu hao là số ghi nhớ nằm trong OPEX: EBITDA cộng lại, dòng "8. Khấu hao" trừ ra
 * lại, nên Lợi nhuận vận hành (netProfit) không đổi. Dashboard P&L và KQKD cùng đọc trường ebitda.
 *
 * Chạy: node --experimental-strip-types --no-warnings --import ./scripts/register-alias.mjs --test scripts/test-ebitda-depreciation.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DEPRECIATION_PNL_ACCOUNT, finalizePnl, PNL_STATEMENT_LINES } from "../lib/reports.ts";
import { finalizeBucket } from "../components/reports/planning/planning-types.ts";

const base = { revenue: 1_000, cogs: 300, payroll: 200, otherOpex: 150, otherIncome: 40, otherExpense: 10, capex: 50, depreciation: 30 };

test("EBITDA cộng lại khấu hao, không tính thu nhập/chi phí khác", () => {
  for (const pnl of [finalizePnl(base), finalizeBucket(base)]) {
    assert.equal(pnl.grossProfit, 700);
    assert.equal(pnl.operatingProfit, 700 - 200 - 50 - 150);
    assert.equal(pnl.ebitda, 700 - 200 - 50 - 150 + 30);
    // LN vận hành = EBITDA − khấu hao + TN khác − CP khác, vẫn như trước khi có dòng khấu hao.
    assert.equal(pnl.netProfit, pnl.ebitda - 30 + 40 - 10);
    assert.equal(pnl.netProfit, 330);
  }
});

test("bucket không có khấu hao: EBITDA = lợi nhuận hoạt động", () => {
  const { depreciation: _omit, ...legacy } = base;
  assert.equal(finalizePnl(legacy).ebitda, 300);
  assert.equal(finalizeBucket(legacy).ebitda, 300);
});

test("KQKD: dòng 8 Khấu hao đứng ngay sau 7 EBITDA, trước Thu nhập khác", () => {
  const keys = PNL_STATEMENT_LINES.map((line) => line.key);
  assert.equal(keys.indexOf("depreciation"), keys.indexOf("ebitda") + 1);
  assert.equal(keys.indexOf("otherIncome"), keys.indexOf("depreciation") + 1);
  assert.equal(keys.at(-1), "netProfit");
  assert.equal(DEPRECIATION_PNL_ACCOUNT.reportGroup, "DEPRECIATION");
});
