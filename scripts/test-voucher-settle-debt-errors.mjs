import assert from "node:assert/strict";
import test from "node:test";
import { applyVoucherSideEffects, VoucherSideEffectError } from "../lib/voucher-side-effects.ts";

/**
 * Gạch nợ hỏng vì dữ liệu người dùng nhập (mã công nợ sai, khác cửa hàng, khác đối tác,
 * vượt dư nợ) phải ném VoucherSideEffectError để route trả 400 kèm câu giải thích.
 * Trước đây đây là Error trần nên màn Phiếu thu/chi chỉ hiện "Internal Server Error".
 *
 * Câu chữ cũng được kiểm: mỗi lỗi phải nói ra được người dùng sửa ở ĐÂU, vì kế toán đọc
 * xong "không tìm thấy mã" vẫn không biết phải gõ gì vào ô.
 */
const phieuThu = {
  id: "v1",
  code: "UNT-2608-NME-00912",
  voucherType: "RECEIPT",
  voucherDate: new Date("2026-08-25"),
  partnerCode: "NB-THOA",
  partnerName: "BOD Cô Thoa",
  branchCode: "NME",
  moneySourceCode: "FDS_CHAU",
  categoryCode: "THU_KHAC",
  amount: 60_000_000,
  description: "Cô Thoa chuyển tiền ngày 25.08.2026",
  depositAction: null,
  depositCode: null,
  debtAction: "SETTLE",
  debtReference: "NB-NME",
  allocationMonths: null,
  allocationStartPeriod: null,
};

/**
 * tx giả: chỉ phục vụ nhánh gạch nợ của applyVoucherSideEffects.
 * `debt` là khoản mà mã trên phiếu trỏ tới (null = không có). `open` là các khoản đang mở
 * dùng để dựng câu gợi ý. `partners` là danh mục đối tác, để nhận ra người dùng chép nhầm
 * mã đối tác vào ô mã công nợ.
 */
function fakeTx(debt, { open = [], trashed = null, partners = [] } = {}) {
  const calls = { settlements: [], updates: [] };
  return {
    calls,
    debtSettlement: {
      findFirst: async () => null,
      create: async ({ data }) => calls.settlements.push(data),
    },
    debtRecord: {
      findFirst: async ({ where }) => (where?.deletedAt && where.deletedAt.not !== undefined ? trashed : debt),
      findMany: async ({ where }) => open.filter((item) => (
        item.debtType === where.debtType
        && item.partnerCode === where.partnerCode
        && (where.branchCode?.not ? item.branchCode !== where.branchCode.not : item.branchCode === where.branchCode)
      )),
      update: async (args) => calls.updates.push(args),
    },
    masterDataItem: {
      findFirst: async ({ where }) => partners.find((item) => item.code === where.code) || null,
    },
    // Phiếu một đối tác nên không có dòng phân bổ nào.
    voucherAllocation: { findMany: async () => [] },
  };
}

const congNoNME = {
  id: "d1",
  code: "CNTHU-UNC-2608-NME-00104",
  debtType: "RECEIVABLE",
  partnerCode: "NB-THOA",
  partnerName: "BOD Cô Thoa",
  branchCode: "NME",
  outstandingAmount: 60_000_000,
};

async function loiKhiApDung(tx, voucher = phieuThu) {
  try {
    await applyVoucherSideEffects(tx, voucher, "kt");
    return null;
  } catch (e) {
    return e;
  }
}

test("điền nhầm mã đối tác vào ô mã công nợ: gọi tên đối tác đó ra", async () => {
  const error = await loiKhiApDung(fakeTx(null, {
    partners: [{ code: "NB-NME", name: "Nhà hàng Nam Mê (nội bộ)" }],
  }));
  assert.ok(error instanceof VoucherSideEffectError);
  assert.match(error.message, /\[NB-NME\]/);
  assert.match(error.message, /MÃ ĐỐI TÁC/);
  assert.match(error.message, /Nhà hàng Nam Mê \(nội bộ\)/);
});

test("mã công nợ không tồn tại: chỉ ra dạng mã đúng và nơi lấy mã", async () => {
  const error = await loiKhiApDung(fakeTx(null));
  assert.ok(error instanceof VoucherSideEffectError);
  assert.match(error.message, /\[NB-NME\]/);
  assert.match(error.message, /tab Công nợ/);
  assert.match(error.message, /CNTHU-/);
});

test("mã sai nhưng đối tác có khoản đang mở: đọc thẳng mã đúng ra cho người nhập", async () => {
  const error = await loiKhiApDung(fakeTx(null, { open: [congNoNME] }));
  assert.match(error.message, /CNTHU-UNC-2608-NME-00104/);
  assert.match(error.message, /60\.000\.000/);
});

test("khoản nợ nằm ở cửa hàng khác: nói tên cửa hàng phải chuyển sang", async () => {
  const error = await loiKhiApDung(fakeTx(null, {
    open: [{ ...congNoNME, branchCode: "ASA" }],
  }));
  assert.match(error.message, /CNTHU-UNC-2608-NME-00104 ở ASA/);
  assert.match(error.message, /Cửa hàng/);
});

test("đối tác chưa có khoản phải thu nào: nhắc phiếu chi hộ phải được duyệt", async () => {
  const error = await loiKhiApDung(fakeTx(null));
  assert.match(error.message, /DUYỆT/);
});

test("khoản nợ đang nằm trong Thùng rác", async () => {
  const error = await loiKhiApDung(fakeTx(null, { trashed: { code: "CNTHU-UNC-2608-NME-00104" } }));
  assert.ok(error instanceof VoucherSideEffectError);
  assert.match(error.message, /Thùng rác/);
  assert.match(error.message, /khôi phục/);
});

test("công nợ của cửa hàng khác: nói tên cả hai cửa hàng", async () => {
  const error = await loiKhiApDung(fakeTx({ ...congNoNME, branchCode: "ASA" }));
  assert.ok(error instanceof VoucherSideEffectError);
  assert.match(error.message, /ASA/);
  assert.match(error.message, /NME/);
});

test("phiếu thu gạch nhầm khoản phải trả", async () => {
  const error = await loiKhiApDung(fakeTx({ ...congNoNME, debtType: "PAYABLE" }));
  assert.ok(error instanceof VoucherSideEffectError);
  assert.match(error.message, /PHẢI TRẢ/);
  assert.match(error.message, /phiếu CHI/);
});

test("công nợ đứng tên đối tác khác: nêu cả tên để sửa ô đối tác", async () => {
  const error = await loiKhiApDung(fakeTx({ ...congNoNME, partnerCode: "NB-BINH", partnerName: "BOD Chị Bình" }));
  assert.ok(error instanceof VoucherSideEffectError);
  assert.match(error.message, /NB-BINH/);
  assert.match(error.message, /BOD Chị Bình/);
  assert.match(error.message, /NB-THOA/);
});

test("khoản nợ đã tất toán thì chặn hẳn, không báo 'vượt dư nợ 0 đ'", async () => {
  const error = await loiKhiApDung(fakeTx({ ...congNoNME, outstandingAmount: 0 }));
  assert.ok(error instanceof VoucherSideEffectError);
  assert.match(error.message, /đã tất toán/);
});

test("số tiền vượt dư nợ: nêu số thu, dư nợ còn lại và phần dôi ra", async () => {
  const error = await loiKhiApDung(fakeTx({ ...congNoNME, outstandingAmount: 10_000_000 }));
  assert.ok(error instanceof VoucherSideEffectError);
  assert.match(error.message, /60\.000\.000/);
  assert.match(error.message, /10\.000\.000/);
  assert.match(error.message, /50\.000\.000/);
});

test("khớp đủ điều kiện thì gạch nợ chạy bình thường", async () => {
  const tx = fakeTx(congNoNME);
  assert.equal(await loiKhiApDung(tx), null);
  assert.equal(tx.calls.settlements.length, 1);
  assert.equal(tx.calls.settlements[0].amount, 60_000_000);
  assert.equal(tx.calls.updates[0].data.outstandingAmount, 0);
  assert.equal(tx.calls.updates[0].data.status, "SETTLED");
});

test("thiếu mã công nợ: chỉ chỗ bấm chọn thay vì bắt gõ tay", async () => {
  const error = await loiKhiApDung(fakeTx(null), { ...phieuThu, debtReference: "" });
  assert.ok(error instanceof VoucherSideEffectError);
  assert.match(error.message, /Mã công nợ cần gạch/);
});
