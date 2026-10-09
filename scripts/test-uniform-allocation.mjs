/**
 * Phân bổ đồng phục khi xuất dùng (khách chốt 09/10/2026) — phần tính thuần của
 * lib/uniform-allocation: trị giá đem phân bổ và dựng lại lịch khi trị giá phiếu đổi.
 *
 * Chạy: node --experimental-strip-types --no-warnings --import ./scripts/register-alias.mjs --test scripts/test-uniform-allocation.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { allocatableIssueAmount, isAllocatableIssueType, replanIssueAllocation } from "../lib/uniform-allocation.ts";

test("chỉ dòng đồng phục đem phân bổ; chỉ phiếu Xuất khác", () => {
  assert.equal(allocatableIssueAmount([{ totalCost: 600000, itemType: "UNIFORM" }, { totalCost: 50000, itemType: "PACKAGING" }]), 600000);
  assert.equal(isAllocatableIssueType("XUAT_KHAC"), true);
  assert.equal(isAllocatableIssueType("XUAT_HUY"), false);
});

test("chưa ghi nhận kỳ nào: chia đều từ tháng xuất, kỳ cuối gánh phần lẻ", () => {
  assert.deepEqual(replanIssueAllocation({ total: 1000000, startPeriod: "2026-10", periods: 3, schedules: [] }), [
    { period: "2026-10", amount: 333333 },
    { period: "2026-11", amount: 333333 },
    { period: "2026-12", amount: 333334 },
  ]);
});

test("đã ghi nhận 1 kỳ mà trị giá phiếu đổi: giữ kỳ đã ghi, phần còn lại chia cho các kỳ chưa ghi", () => {
  const schedules = [
    { period: "2026-10", amount: 300000, status: "POSTED" },
    { period: "2026-11", amount: 300000, status: "PLANNED" },
    { period: "2026-12", amount: 300000, status: "PLANNED" },
  ];
  assert.deepEqual(replanIssueAllocation({ total: 1200000, startPeriod: "2026-10", periods: 3, schedules }), [
    { period: "2026-11", amount: 450000 },
    { period: "2026-12", amount: 450000 },
  ]);
});

test("trị giá mới nhỏ hơn số đã ghi nhận thì chặn", () => {
  const schedules = [{ period: "2026-10", amount: 500000, status: "POSTED" }, { period: "2026-11", amount: 500000, status: "PLANNED" }];
  assert.throws(() => replanIssueAllocation({ total: 400000, startPeriod: "2026-10", periods: 2, schedules }), /lớn hơn trị giá đồng phục mới/);
});
