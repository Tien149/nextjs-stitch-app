/**
 * Mẫu đặt hàng (khách yêu cầu 03/10/2026): ngày áp dụng / kết thúc (trống = không giới hạn) và
 * import Excel nhiều mẫu một lần.
 *
 * Chạy: node --experimental-strip-types --no-warnings --import ./scripts/register-alias.mjs --test scripts/test-purchase-template.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildTemplateImport, templateDayToDate, templateWindowStatus } from "../lib/purchase-template.ts";

test("hiệu lực: trống là không giới hạn, hai đầu tính", () => {
  assert.equal(templateWindowStatus({}, "2026-10-03"), "ACTIVE");
  const window = { effectiveFrom: templateDayToDate("2026-10-05"), effectiveTo: templateDayToDate("2026-10-31") };
  assert.equal(templateWindowStatus(window, "2026-10-04"), "UPCOMING");
  assert.equal(templateWindowStatus(window, "2026-10-05"), "ACTIVE");
  assert.equal(templateWindowStatus(window, "2026-10-31"), "ACTIVE");
  assert.equal(templateWindowStatus(window, "2026-11-01"), "EXPIRED");
  assert.equal(templateWindowStatus({ effectiveTo: templateDayToDate("2026-10-01") }, "2026-10-03"), "EXPIRED");
});

const lookup = {
  items: new Map([
    ["BIA", { id: "a", code: "BIA", name: "Bia", unit: "lon", status: "ACTIVE", itemType: "RAW_MATERIAL", unitConversions: [{ unitCode: "THUNG" }] }],
    ["RAU", { id: "b", code: "RAU", name: "Rau", unit: "kg", status: "ACTIVE", itemType: "RAW_MATERIAL", unitConversions: [] }],
    ["MON", { id: "c", code: "MON", name: "Món", unit: "phần", status: "ACTIVE", itemType: "FINISHED", unitConversions: [] }],
  ]),
  branches: new Set(["HCM"]),
  departments: new Set(["BEP"]),
  templates: new Map([["MAU-0001", "Mẫu cũ"]]),
};

test("gom theo Tên mẫu + Cửa hàng, thông tin cấp mẫu ghi ở một dòng là đủ", () => {
  const { groups, errors } = buildTemplateImport([
    { "Tên mẫu": "Bếp", "Cửa hàng": "hcm", "Bộ phận": "BEP", "Ngày áp dụng": "01/10/2026", "Mã hàng": "bia", "ĐVT": "thung" },
    { "Tên mẫu": "Bếp", "Mã hàng": "RAU", "ĐVT": "KG", "Ghi chú": "rau sạch" },
    { "Mã mẫu": "mau-0001", "Mã hàng": "RAU" },
  ], lookup);
  assert.deepEqual(errors, []);
  assert.equal(groups.length, 2);
  const bep = groups.find((group) => group.name === "Bếp");
  assert.deepEqual([bep.branchCode, bep.departmentCode, bep.from, bep.to, bep.lines.map((line) => line.unitCode)], ["HCM", "BEP", "2026-10-01", null, ["THUNG", "KG"]]);
  assert.equal(bep.lines[1].note, "rau sạch");
  const old = groups.find((group) => group.code === "MAU-0001");
  assert.deepEqual([old.name, old.lines.length], ["Mẫu cũ", 1]);
});

test("báo lỗi đúng dòng", () => {
  const { errors } = buildTemplateImport([
    { "Tên mẫu": "Bar", "Mã hàng": "XXX" },
    { "Tên mẫu": "Bar", "Mã hàng": "MON" },
    { "Tên mẫu": "Bar", "Mã hàng": "BIA", "ĐVT": "KG" },
    { "Mã mẫu": "MAU-9999", "Mã hàng": "BIA" },
    { "Tên mẫu": "Bar", "Mã hàng": "BIA", "Ngày áp dụng": "05/10/2026", "Ngày kết thúc": "01/10/2026" },
    { "Tên mẫu": "Bar", "Mã hàng": "RAU" },
    { "Tên mẫu": "Bar", "Mã hàng": "RAU" },
  ], lookup);
  assert.deepEqual(errors.map((error) => error.row), [2, 3, 4, 5, 6, 8]);
});
