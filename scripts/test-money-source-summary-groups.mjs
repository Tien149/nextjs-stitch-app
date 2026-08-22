import assert from "node:assert/strict";
import test from "node:test";
import { parseMoneySourceCodes, summaryMoneySourceGroups } from "../lib/money-sources.ts";

const sources = [
  { code: "VTB_CK_HN", name: "FDS - Vietinbank", group: "BANK", branch: "HN", summarySourceName: "FDS - Vietinbank" },
  { code: "VTB_POS_HN", name: "FDS - Máy POS Vietinbank", group: "BANK", branch: "HN", summarySourceName: "FDS - Vietinbank" },
  { code: "TCB_HN", name: "Techcombank Nam Mê", group: "BANK", branch: "HN", summarySourceName: "Techcombank" },
  { code: "VTB_HCM", name: "ASA - Vietinbank", group: "BANK", branch: "HCM", summarySourceName: "FDS - Vietinbank" },
  { code: "TM_HN", name: "Tiền mặt Nam Mê", group: "CASH", branch: "HN", summarySourceName: null },
];

test("gom các nguồn cùng Nguồn tiền tổng trong cùng cửa hàng thành một lựa chọn", () => {
  const groups = summaryMoneySourceGroups(sources);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].codes, ["VTB_CK_HN", "VTB_POS_HN"]);
  assert.equal(groups[0].value, "VTB_CK_HN,VTB_POS_HN");
  assert.equal(groups[0].name, "FDS - Vietinbank");
});

test("không gộp chéo cửa hàng và bỏ nhóm chỉ có một thành viên", () => {
  const groups = summaryMoneySourceGroups(sources);
  // VTB_HCM cùng tên tổng nhưng khác cửa hàng; Techcombank chỉ một nguồn.
  assert.equal(groups.some((group) => group.codes.includes("VTB_HCM")), false);
  assert.equal(groups.some((group) => group.name === "Techcombank"), false);
});

test("tên tổng so không phân biệt hoa thường nhưng giữ cách viết đầu tiên", () => {
  const groups = summaryMoneySourceGroups([
    { code: "A", name: "A", group: "BANK", branch: "HN", summarySourceName: "Vietinbank" },
    { code: "B", name: "B", group: "BANK", branch: "HN", summarySourceName: "VIETINBANK" },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, "Vietinbank");
});

test("parseMoneySourceCodes tách giá trị nhóm tổng và hiểu rỗng/ALL là không lọc", () => {
  assert.deepEqual(parseMoneySourceCodes("VTB_CK_HN,VTB_POS_HN"), ["VTB_CK_HN", "VTB_POS_HN"]);
  assert.deepEqual(parseMoneySourceCodes(" TCB_HN "), ["TCB_HN"]);
  assert.deepEqual(parseMoneySourceCodes("A,,A , B"), ["A", "B"]);
  assert.deepEqual(parseMoneySourceCodes(""), []);
  assert.deepEqual(parseMoneySourceCodes("ALL"), []);
  assert.deepEqual(parseMoneySourceCodes(null), []);
});
