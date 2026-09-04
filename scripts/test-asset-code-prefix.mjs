/**
 * Chốt luật tiền tố mã tài sản/CCDC (lib/asset-code-generator.ts).
 *
 * Khách đặt mã Nhóm tài sản theo họ — CCDC_BAR, CCDC_FOH, TOOL_OPS — chứ không dùng ba mã cũ
 * CCDC/TOOL/ASSET của bản đầu. Luật cũ so khớp nguyên văn nên nhóm "Dụng cụ khu vực Bar" rơi về
 * TSCD và dụng cụ bị cấp mã TSCDBAR0001 thay vì CCDCBAR0001; mã đã phát sinh công nợ thì không
 * đổi lại được nữa nên chỗ này sai một lần là sai vĩnh viễn.
 *
 * Chạy: npm run test:asset-code
 */
import test from "node:test";
import assert from "node:assert/strict";
import { defaultAssetCodePrefix } from "../lib/asset-code-generator.ts";

test("nhóm CCDC / dụng cụ vận hành cho ra tiền tố CCDC dù mã nhóm đặt theo họ", () => {
  assert.equal(defaultAssetCodePrefix("CCDC_BAR", "CCDC"), "CCDC");
  assert.equal(defaultAssetCodePrefix("CCDC_FOH", "CCDC"), "CCDC");
  assert.equal(defaultAssetCodePrefix("TOOL_OPS", "TOOL"), "CCDC");
  // Nhóm chưa khai phân loại vẫn phải suy được từ chính mã nhóm — đây là ca sinh ra TSCDBAR0001.
  assert.equal(defaultAssetCodePrefix("CCDC_BAR", ""), "CCDC");
  assert.equal(defaultAssetCodePrefix("CCDC_VS", null), "CCDC");
});

test("nhóm tài sản cố định giữ tiền tố TSCD", () => {
  assert.equal(defaultAssetCodePrefix("MACHINENRY_BEP", "FIXED_ASSET"), "TSCD");
  assert.equal(defaultAssetCodePrefix("NOITHAT", "FIXED_ASSET"), "TSCD");
  assert.equal(defaultAssetCodePrefix("VEHICLES", "FIXED_ASSET"), "TSCD");
  assert.equal(defaultAssetCodePrefix("MANAGEMENT", ""), "TSCD");
});

test("mã nhóm cũ của luồng nhận hàng PO vẫn ra đúng tiền tố như trước", () => {
  assert.equal(defaultAssetCodePrefix("CCDC", ""), "CCDC");
  assert.equal(defaultAssetCodePrefix("TOOL", ""), "CCDC");
  assert.equal(defaultAssetCodePrefix("ASSET", ""), "TSCD");
  assert.equal(defaultAssetCodePrefix("", ""), "TSCD");
});
