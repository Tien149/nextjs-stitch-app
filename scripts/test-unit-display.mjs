import assert from "node:assert/strict";
import test from "node:test";
import { unitDisplayName } from "@/lib/unit-display";

test("mã ĐVT tách thành tên đọc được", () => {
  assert.equal(unitDisplayName("CAI"), "Cái");
  assert.equal(unitDisplayName("O"), "Ổ");
  assert.equal(unitDisplayName("GOI500GR"), "Gói 500gr");
  assert.equal(unitDisplayName("THUNG24LON330ML"), "Thùng 24 lon 330ml");
  assert.equal(unitDisplayName("CAN10LIT"), "Can 10 lít");
  assert.equal(unitDisplayName("CHAI1500ML."), "Chai 1500ml");
});

test("mã có chữ lạ giữ nguyên, tên khai riêng được ưu tiên", () => {
  assert.equal(unitDisplayName("CHAIGIFFARD700ML"), "CHAIGIFFARD700ML");
  assert.equal(unitDisplayName("BANHHOITUOI"), "BANHHOITUOI");
  assert.equal(unitDisplayName("CAI", "Cai"), "Cái");
  assert.equal(unitDisplayName("CAI", "Cái lớn"), "Cái lớn");
});
