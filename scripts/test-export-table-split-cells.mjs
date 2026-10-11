/**
 * Xuất Excel theo bảng: ô khai data-export-cells tách ra nhiều cột (Danh sách Tài sản & CCDC,
 * khách xin 11/10/2026). Bảng giả chỉ gồm ô có data-export-cells nên không cần DOM thật.
 *
 * Chạy: node --experimental-strip-types --no-warnings --import ./scripts/register-alias.mjs --test scripts/test-export-table-split-cells.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { extractTableGrid } from "../lib/export-table-excel.ts";

const cell = (values) => ({ dataset: { exportCells: JSON.stringify(values) }, rowSpan: 1, colSpan: 1 });
const row = (...cells) => ({ dataset: {}, cells });

test("ô gộp tách thành nhiều cột, tiêu đề tách theo đúng thứ tự; cột rỗng toàn bộ bị bỏ", () => {
  const table = {
    rows: [
      row(cell(["Mã", "Đợt", "Tên"]), cell(["Nhóm", "Số lượng"])),
      row(cell(["CCDCKIT0006", "2/2", "Bình Xịt Nước"]), cell(["Dụng Cụ Khu Vực Bếp", "2"])),
      row(cell(["CCDCKIT0085", "", "Bếp Gas 6 Họng"]), cell(["Dụng Cụ Khu Vực Bếp", "1"])),
    ],
  };
  assert.deepEqual(extractTableGrid(table), [
    ["Mã", "Đợt", "Tên", "Nhóm", "Số lượng"],
    ["CCDCKIT0006", "2/2", "Bình Xịt Nước", "Dụng Cụ Khu Vực Bếp", "2"],
    ["CCDCKIT0085", "", "Bếp Gas 6 Họng", "Dụng Cụ Khu Vực Bếp", "1"],
  ]);
});
