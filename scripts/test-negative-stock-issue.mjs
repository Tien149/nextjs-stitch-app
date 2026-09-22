/**
 * Xuất âm: phiếu XUAT_* phải chạy được cả khi kho chưa có tồn (khách chốt 22/09/2026).
 *
 * Phần khó không phải chỗ cho tồn xuống âm, mà là giá vốn sau đó: nhập bù vào một kho đang âm
 * phải lấy đúng giá lô nhập, không bình quân với phần âm (phần âm không mang giá trị).
 *
 * Chạy: npm run test:negative-stock
 */
import assert from "node:assert/strict";
import test from "node:test";
import { computeBalanceChange } from "../lib/inventory-stock.ts";

test("xuất quá tồn thì tồn xuống âm đúng bằng phần thiếu", () => {
  const change = computeBalanceChange({ currentQuantity: 0, currentAverage: 0, quantity: 12, unitCost: 0, direction: "OUT" });
  assert.equal(change.newQuantity, -12);
  assert.equal(change.negativeQuantity, 12);
  // Kho chưa có giá nào -> phiếu xuất ghi 0 đồng. Đây là chỗ báo cáo giá vốn còn thiếu,
  // nên màn hình phải nhắc người dùng khai tồn/giá (xem app/api/inventory EXPLODE_PRODUCTION).
  assert.equal(change.unitCost, 0);
  assert.equal(change.totalCost, 0);
});

test("kho đã có giá bình quân thì xuất âm vẫn ăn đúng giá đó", () => {
  const change = computeBalanceChange({ currentQuantity: 2, currentAverage: 30000, quantity: 5, unitCost: 0, direction: "OUT" });
  assert.equal(change.newQuantity, -3);
  assert.equal(change.negativeQuantity, 3);
  assert.equal(change.unitCost, 30000);
  assert.equal(change.totalCost, 150000);
  // Xuất không được đụng vào giá bình quân của kho.
  assert.equal(change.averageCost, 30000);
});

test("xuất trong tồn thì không có gì âm", () => {
  const change = computeBalanceChange({ currentQuantity: 10, currentAverage: 20000, quantity: 4, unitCost: 0, direction: "OUT" });
  assert.equal(change.newQuantity, 6);
  assert.equal(change.negativeQuantity, 0);
});

test("nhập bù vào kho đang âm lấy đúng giá lô nhập, không thổi giá vốn lên gấp đôi", () => {
  // Tồn -50 (giá 0) + nhập 100 @30.000: bình quân kiểu cũ ra (0 + 3.000.000)/50 = 60.000.
  const change = computeBalanceChange({ currentQuantity: -50, currentAverage: 0, quantity: 100, unitCost: 30000, direction: "IN" });
  assert.equal(change.newQuantity, 50);
  assert.equal(change.averageCost, 30000);
});

test("nhập bù vừa đủ hết phần âm thì tồn về 0", () => {
  const change = computeBalanceChange({ currentQuantity: -10, currentAverage: 0, quantity: 10, unitCost: 25000, direction: "IN" });
  assert.equal(change.newQuantity, 0);
  assert.equal(change.negativeQuantity, 0);
});

test("nhập vào kho đang dương vẫn bình quân gia quyền như cũ", () => {
  // 10 @20.000 + 10 @30.000 = 20 @25.000.
  const change = computeBalanceChange({ currentQuantity: 10, currentAverage: 20000, quantity: 10, unitCost: 30000, direction: "IN" });
  assert.equal(change.newQuantity, 20);
  assert.equal(change.averageCost, 25000);
});

test("nhập đơn giá 0 (hàng tặng) không kéo giá vốn của kho xuống", () => {
  const change = computeBalanceChange({ currentQuantity: 10, currentAverage: 20000, quantity: 10, unitCost: 0, direction: "IN" });
  assert.equal(change.averageCost, 20000);
  assert.equal(change.totalCost, 200000);
});
