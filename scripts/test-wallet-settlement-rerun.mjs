import test from "node:test";
import assert from "node:assert/strict";
import { planWalletSettlementRerun } from "../lib/wallet-settlement-rerun.ts";

/**
 * Chạy lại quyết toán ví sau khi doanh thu ngày đó được nạp lại.
 * Luật gốc: SỐ THỰC NHẬN không đổi (tiền thật đã về theo sao kê), chỉ phí co giãn theo gross.
 */

const voucher = (code, amount, feeAmount, grabExpenseAmount = 0) => ({
  id: `id-${code}`, code, amount, feeAmount, grabExpenseAmount,
});

test("ca that QTVI-2608-NME-00022: nap lai doanh thu thap hon thi phi ve 0", () => {
  // Phiếu chạy 18/08 theo doanh thu 1.811.556; ngày 05/09 file 02/08 nạp lại còn 1.782.837,
  // đúng bằng tiền về ngân hàng nên phí phải bằng 0 thay vì 28.719 đang ghi.
  const result = planWalletSettlementRerun({
    vouchers: [voucher("QTVI-2608-NME-00022", 1_782_837, 28_719)],
    currentRevenue: 1_782_837,
  });
  assert.equal(result.ok, true);
  assert.equal(result.plan.nextFee, 0);
  assert.equal(result.plan.changes[0].feeBefore, 28_719);
  assert.equal(result.plan.changes[0].feeAfter, 0);
  assert.equal(result.plan.changed, true);
  // Tiền thật về ngân hàng tuyệt đối không đổi.
  assert.equal(result.plan.totalAmount, 1_782_837);
});

test("nap lai y het so cu thi khong co gi de chay lai", () => {
  const result = planWalletSettlementRerun({
    vouchers: [voucher("QTVI-01", 1_000_000, 50_000)],
    currentRevenue: 1_050_000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.plan.changed, false);
});

test("mot ngay vi tra nhieu dot: chia phi theo ty trong tien ve, tong khop tuyet doi", () => {
  // Grab trả 2 đợt trong ngày; doanh thu ví ngày đó 10.000.000, tiền về 9.000.000.
  const result = planWalletSettlementRerun({
    vouchers: [voucher("QTVI-01", 6_000_000, 100_000), voucher("QTVI-02", 3_000_000, 50_000)],
    currentRevenue: 10_000_000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.plan.totalAmount, 9_000_000);
  assert.equal(result.plan.nextFee, 1_000_000);
  const sum = result.plan.changes.reduce((total, row) => total + row.feeAfter, 0);
  assert.equal(sum, result.plan.nextFee);
  assert.deepEqual(result.plan.changes.map((row) => row.feeAfter), [666_667, 333_333]);
});

test("phan le don vao phieu cuoi de tong khong lech mot dong", () => {
  const result = planWalletSettlementRerun({
    vouchers: [voucher("A", 1, 0), voucher("B", 1, 0), voucher("C", 1, 0)],
    currentRevenue: 4,
  });
  assert.equal(result.ok, true);
  assert.equal(result.plan.changes.reduce((total, row) => total + row.feeAfter, 0), 1);
});

test("hoa hong Grab giu nguyen, chi phan phi quet the co gian", () => {
  // Phí 200k trong đó 150k là hoa hồng Grab lấy từ sao kê — nạp lại doanh thu chỉ được đụng
  // vào phần quẹt thẻ.
  const result = planWalletSettlementRerun({
    vouchers: [voucher("QTVI-01", 5_000_000, 200_000, 150_000)],
    currentRevenue: 5_300_000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.plan.grabTotal, 150_000);
  assert.equal(result.plan.changes[0].feeAfter, 300_000);
});

test("phi moi nho hon hoa hong Grab thi tu choi, bat sua tay", () => {
  const result = planWalletSettlementRerun({
    vouchers: [voucher("QTVI-01", 5_000_000, 200_000, 150_000)],
    currentRevenue: 5_100_000,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /hoa hồng Grab/);
});

test("doanh thu nho hon tien da ve ngan hang thi tu choi, khong ghi phi am", () => {
  const result = planWalletSettlementRerun({
    vouchers: [voucher("QTVI-01", 5_000_000, 100_000)],
    currentRevenue: 4_000_000,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /nhỏ hơn số tiền đã về ngân hàng/);
});

test("ngay chua co doanh thu (vua xoa, chua nap lai) thi bao nap file truoc", () => {
  const result = planWalletSettlementRerun({
    vouchers: [voucher("QTVI-01", 5_000_000, 100_000)],
    currentRevenue: 0,
    walletLabel: "Ví Momo HCM",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /Ví Momo HCM/);
  assert.match(result.reason, /Nạp lại file doanh thu/);
});

test("khong co phieu nao thi tu choi go gang", () => {
  assert.equal(planWalletSettlementRerun({ vouchers: [], currentRevenue: 100 }).ok, false);
});
