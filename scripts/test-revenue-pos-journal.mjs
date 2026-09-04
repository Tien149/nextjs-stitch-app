/**
 * Bút toán doanh thu POS lên P&L (spec 04/09/2026): nhóm doanh thu của món = Doanh thu − Giảm
 * giá, Doanh thu SVC = cột SVC, Doanh thu thuế GTGT = cột Thuế, tiền về = Tổng tiền.
 *
 * Chạy: npm run test:pos-journal
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  REVENUE_ADJUST_CATEGORY_CODE,
  REVENUE_SVC_CATEGORY_CODE,
  REVENUE_VAT_CATEGORY_CODE,
  isRevenueComponentCategory,
  revenuePosJournalLines,
} from "../lib/revenue-pos-journal.ts";
import { revenueKindFromText } from "../lib/revenue-source.ts";

const base = { paymentMethod: "CASH_NME", revenueSource: "REV_FOOD", departmentCode: "KIT" };
const sumCredit = (lines) => lines.reduce((sum, line) => sum + (line.credit || 0), 0);
const creditOf = (lines, categoryCode) => lines.find((line) => line.credit !== undefined && line.categoryCode === categoryCode)?.credit;

test("tách Doanh thu − Giảm giá / SVC / Thuế thành ba dòng Có 511, Nợ tiền = Tổng tiền", () => {
  const lines = revenuePosJournalLines({ ...base, grossAmount: 500000, discountAmount: 50000, feeAmount: 22500, vatAmount: 37800, netAmount: 510300 });
  assert.deepEqual(lines[0], { accountCode: "1111", debit: 510300 });
  assert.equal(creditOf(lines, "REV_FOOD"), 450000, "nhóm doanh thu của món chỉ còn Doanh thu − Giảm giá");
  assert.equal(creditOf(lines, REVENUE_SVC_CATEGORY_CODE), 22500);
  assert.equal(creditOf(lines, REVENUE_VAT_CATEGORY_CODE), 37800);
  assert.equal(creditOf(lines, REVENUE_ADJUST_CATEGORY_CODE), undefined, "khớp khít thì không có dòng điều chỉnh");
  assert.equal(sumCredit(lines), 510300, "bút toán phải cân");
  assert.ok(lines.slice(1).every((line) => line.accountCode === "511" && line.departmentCode === "KIT"), "bộ phận đi theo mọi dòng doanh thu");
});

test("tổng tiền lệch (hoa hồng, phí ship) thì phần chênh vào dòng điều chỉnh, không trộn vào bếp/bar", () => {
  const lines = revenuePosJournalLines({ ...base, paymentMethod: "FDSGRABFOOD", grossAmount: 100000, discountAmount: 0, feeAmount: 0, vatAmount: 8000, netAmount: 90000 });
  assert.equal(lines[0].accountCode, "1121");
  assert.equal(creditOf(lines, "REV_FOOD"), 100000);
  assert.equal(creditOf(lines, REVENUE_VAT_CATEGORY_CODE), 8000);
  assert.equal(creditOf(lines, REVENUE_ADJUST_CATEGORY_CODE), -18000);
  assert.equal(creditOf(lines, REVENUE_SVC_CATEGORY_CODE), undefined, "SVC bằng 0 thì không sinh dòng rác");
  assert.equal(sumCredit(lines), 90000);
});

test("dòng cũ chỉ có Tổng tiền (không Doanh thu/SVC/Thuế) giữ nguyên cách cũ: cả số lên nhóm doanh thu", () => {
  const lines = revenuePosJournalLines({ ...base, paymentMethod: "CASH", grossAmount: 0, discountAmount: 0, feeAmount: 0, vatAmount: 0, netAmount: 324000 });
  assert.deepEqual(lines, [
    { accountCode: "1111", debit: 324000 },
    { accountCode: "511", credit: 324000, categoryCode: "REV_FOOD", departmentCode: "KIT" },
  ]);
});

test("nhận diện dòng Có mang SVC / thuế / điều chỉnh để chuẩn hoá nhóm doanh thu không ghi đè", () => {
  assert.equal(isRevenueComponentCategory("REV_SVC"), true);
  assert.equal(isRevenueComponentCategory("rev_vat"), true);
  assert.equal(isRevenueComponentCategory("REV_ADJUST"), true);
  assert.equal(isRevenueComponentCategory("REV_FOOD"), false);
  assert.equal(isRevenueComponentCategory(null), false);
});

test("chữ 'Dịch vụ' / 'Phụ thu' trong file quy về loại SERVICE, không nhầm với ăn/uống", () => {
  assert.equal(revenueKindFromText("DỊCH VỤ"), "SERVICE");
  assert.equal(revenueKindFromText("Phụ thu dịch vụ không gian"), "SERVICE");
  assert.equal(revenueKindFromText("Service charge"), "SERVICE");
  assert.equal(revenueKindFromText("Dịch vụ ăn uống"), null, "dính cả ăn lẫn uống là danh mục gộp");
  assert.equal(revenueKindFromText("ĐỒ ĂN"), "FOOD");
  assert.equal(revenueKindFromText("Doanh thu SVC"), null, "SVC không phải nhóm dịch vụ của món");
});
