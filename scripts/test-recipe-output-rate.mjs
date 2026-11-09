/**
 * Hệ số mẻ định lượng (khách hỏi 09/11/2026): BTP Sốt Pesto khai mẻ "650GR" mà bỏ trống hệ số
 * thì cost 1 GR = cost cả mẻ — món dùng 50 GR lên 18,4 triệu.
 *
 * Chạy: node --experimental-strip-types --no-warnings --import ./scripts/register-alias.mjs --test scripts/test-recipe-output-rate.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { inferOutputConversionRate, outputConversionRateProblem, resolveOutputConversionRate } from "../lib/recipe-output-rate.ts";

test("mẻ dạng <số><ĐVT tồn> tự ra hệ số", () => {
  assert.equal(inferOutputConversionRate("650GR", "GR"), 650);
  assert.equal(inferOutputConversionRate("10 phần", "PHAN"), 10);
  assert.equal(inferOutputConversionRate("1,5KG", "KG"), 1.5);
  assert.equal(inferOutputConversionRate("KG", "GR"), null);
  assert.equal(inferOutputConversionRate("GR", "GR"), null);
  assert.equal(inferOutputConversionRate("CUON01", "CUON01"), null);
});

test("hệ số khai tay luôn thắng, trống thì suy, không suy được thì 1", () => {
  assert.equal(resolveOutputConversionRate(1000, "650GR", "GR"), 1000);
  assert.equal(resolveOutputConversionRate(0, "650GR", "GR"), 650);
  assert.equal(resolveOutputConversionRate(null, "PHAN", "PHAN"), 1);
});

test("mẻ khác ĐVT tồn mà hệ số 1 thì báo lỗi", () => {
  assert.match(outputConversionRateProblem("650GR", "GR", 1), /hệ số 650/);
  assert.match(outputConversionRateProblem("KG", "GR", 1), /1 mẻ = bao nhiêu GR/);
  assert.equal(outputConversionRateProblem("650GR", "GR", 650), null);
  assert.equal(outputConversionRateProblem("PHAN", "Phần", 1), null);
  assert.equal(outputConversionRateProblem("KG", "GR", 1000), null);
  assert.equal(outputConversionRateProblem("PHAN", "MON", 1), null);
});
