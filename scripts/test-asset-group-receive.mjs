/**
 * Chốt luật chọn Nhóm tài sản khi nhận hàng từ PO (lib/asset-group-rules.ts).
 *
 * Bản cũ gán cứng "CCDC"/"ASSET" làm mã nhóm — hai mã không có trong danh mục của khách
 * (CCDC_BAR, CCDC_FOH, MACHINENRY_BEP...) — nên hồ sơ tài sản nhận từ PO mang nhóm rác.
 *
 * Chạy: npm run test:asset-group
 */
import test from "node:test";
import assert from "node:assert/strict";
import { assetGroupCandidates, resolveAssetGroupForReceive } from "../lib/asset-group-rules.ts";

const catalog = [
  { code: "CCDC_BAR", name: "Dụng cụ khu vực Bar", group: "CCDC" },
  { code: "CCDC_FOH", name: "Dụng cụ khu vực Sảnh", group: "CCDC" },
  { code: "TOOL_OPS", name: "Đồ dùng dùng chung", group: "TOOL" },
  { code: "MACHINENRY_BEP", name: "Máy móc thiết bị bếp", group: "FIXED_ASSET" },
  { code: "VEHICLES", name: "Phương tiện vận chuyển", group: "FIXED_ASSET" },
];

test("chỉ nhóm đúng phân loại mới được chọn cho loại mặt hàng", () => {
  assert.deepEqual(assetGroupCandidates("TOOL", catalog).map((group) => group.code), ["CCDC_BAR", "CCDC_FOH", "TOOL_OPS"]);
  assert.deepEqual(assetGroupCandidates("ASSET", catalog).map((group) => group.code), ["MACHINENRY_BEP", "VEHICLES"]);
});

test("người nhận hàng chọn nhóm nào thì theo nhóm đó", () => {
  const resolved = resolveAssetGroupForReceive({ itemType: "TOOL", itemCode: "CCDC001", requestedCode: "ccdc_bar", catalog });
  assert.deepEqual(resolved, { ok: true, code: "CCDC_BAR" });
});

test("chọn nhóm sai phân loại thì chặn, không lặng lẽ đổi nhóm khác", () => {
  const resolved = resolveAssetGroupForReceive({ itemType: "TOOL", itemCode: "CCDC001", requestedCode: "VEHICLES", catalog });
  assert.equal(resolved.ok, false);
  assert.match(resolved.error, /không thuộc phân loại Công cụ dụng cụ/);
});

test("danh mục chỉ có đúng một nhóm hợp lệ thì tự lấy, khỏi bắt bấm thừa", () => {
  const single = [{ code: "CCDC_BEP", name: "Công cụ dụng cụ bếp", group: "CCDC" }];
  assert.deepEqual(
    resolveAssetGroupForReceive({ itemType: "TOOL", itemCode: "CCDC001", catalog: single }),
    { ok: true, code: "CCDC_BEP" },
  );
});

test("nhiều nhóm hợp lệ mà chưa chọn thì dừng và nói rõ chọn nhóm nào", () => {
  const resolved = resolveAssetGroupForReceive({ itemType: "TOOL", itemCode: "CCDC001", catalog });
  assert.equal(resolved.ok, false);
  assert.match(resolved.error, /CCDC_BAR, CCDC_FOH, TOOL_OPS/);
});

test("chưa khai nhóm nào thuộc phân loại thì báo đúng việc phải làm", () => {
  const resolved = resolveAssetGroupForReceive({ itemType: "ASSET", itemCode: "TS001", catalog: [] });
  assert.equal(resolved.ok, false);
  assert.match(resolved.error, /Cài đặt > Danh mục > Nhóm tài sản/);
});
