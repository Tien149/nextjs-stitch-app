import assert from "node:assert/strict";
import test from "node:test";
import { nextSeqFromCodes, voucherCodePrefix } from "../lib/voucher-code-generator.ts";

const transferDate = new Date("2026-08-04T00:00:00Z");
const prefix = voucherCodePrefix({ voucherType: "CTNB", voucherDate: transferDate, branchCode: "NAM ME" });

test("mã chuyển tiền đúng quy tắc Mã-NămTháng-Cửa hàng-STT", () => {
  assert.equal(prefix, "CTNB-2608-NAM-");
  assert.equal(prefix + String(nextSeqFromCodes([], prefix)).padStart(5, "0"), "CTNB-2608-NAM-00001");
});

test("COUNT toàn bảng cấp trúng mã đang sống — cách cũ sai", () => {
  // Bảng MoneyTransfer có 3 bản ghi: 2 quyết toán ví + 1 chuyển tiền nội bộ.
  // Cách cũ: count() = 3 -> cấp CTNB-...-0004, dù chuỗi CTNB mới chỉ tới 0001.
  const allRows = ["QTVI-2608-NAM-00001", "QTVI-2608-NAM-00002", "CTNB-202608-0001"];
  const oldStyleSeq = allRows.length + 1;
  assert.equal(oldStyleSeq, 4, "COUNT đếm lẫn cả QTVI nên nhảy số vô nghĩa");

  // Sau khi rollback 2 phiếu ví, count tụt còn 1 -> cấp lại 0002... rồi 0001 nếu xoá tiếp.
  const afterRollback = ["CTNB-202608-0001"];
  assert.equal(afterRollback.length + 1, 2);
  const afterMoreRollback = [];
  assert.equal(afterMoreRollback.length + 1, 1, "COUNT tụt về 1 -> cấp lại mã CTNB-...-0001 đang tồn tại => trùng mã");
});

test("max + 1 chỉ tính trong đúng chuỗi mã, không đụng QTVI/NOPT", () => {
  const issued = [
    "QTVI-2608-NAM-00009",
    "NOPT-2608-NAM-00004",
    prefix + "00001",
    prefix + "00002",
  ];
  assert.equal(nextSeqFromCodes(issued, prefix), 3);
});

test("mã đã rollback để lại lỗ trống, không bao giờ cấp lại mã đang sống", () => {
  // Đã cấp 1,2,3; rollback xoá 1 và 2, chỉ còn 3 -> phải cấp 4, không phải 2.
  const stillAlive = [prefix + "00003"];
  assert.equal(nextSeqFromCodes(stillAlive, prefix), 4);
});

test("chuỗi mã tách theo tháng và theo cửa hàng", () => {
  const otherBranch = voucherCodePrefix({ voucherType: "CTNB", voucherDate: transferDate, branchCode: "ASA" });
  const otherMonth = voucherCodePrefix({ voucherType: "CTNB", voucherDate: new Date("2026-09-04T00:00:00Z"), branchCode: "NAM ME" });
  assert.notEqual(otherBranch, prefix);
  assert.notEqual(otherMonth, prefix);
  // Mã của cửa hàng/tháng khác không làm nhảy số của chuỗi này.
  assert.equal(nextSeqFromCodes([otherBranch + "00007", otherMonth + "00009"], prefix), 1);
});

test("mã công nợ đầu kỳ cũng tính max + 1 theo đúng chuỗi ngày chứng từ", () => {
  const debtPrefix = "CN-PT-20260804-";
  const issued = ["CN-PP-20260804-0005", debtPrefix + "0001", debtPrefix + "0002"];
  assert.equal(nextSeqFromCodes(issued, debtPrefix), 3, "phải thu và phải trả là hai chuỗi tách biệt");
});
