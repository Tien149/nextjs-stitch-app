import assert from "node:assert/strict";
import test from "node:test";
import {
  costReallocationTotal,
  expenseAccountForPnlGroup,
  internalPartnerCode,
  journalIsBalanced,
  planCostReallocationJournals,
  reallocationOverspendMessage,
  validateCostReallocation,
} from "../lib/cost-reallocation.ts";

const baseInput = {
  fromBranchCode: "NME",
  pnlItemCode: "CPBD_GAS",
  lines: [
    { toBranchCode: "ASA", amount: 3_000_000 },
    { toBranchCode: "HCM", amount: 2_000_000 },
  ],
};

test("tổng phiếu luôn bằng tổng các dòng phân bổ", () => {
  assert.equal(costReallocationTotal(baseInput.lines), 5_000_000);
});

test("phân bổ hợp lệ thì không có lỗi", () => {
  assert.deepEqual(validateCostReallocation(baseInput), []);
});

test("không cho phân bổ về chính nhà hàng đã trả", () => {
  const errors = validateCostReallocation({ ...baseInput, lines: [{ toBranchCode: "NME", amount: 1_000 }] });
  assert.ok(errors.some((message) => message.includes("phải khác nhà hàng đã trả")));
});

test("bắt trùng nhà hàng trên hai dòng", () => {
  const errors = validateCostReallocation({
    ...baseInput,
    lines: [{ toBranchCode: "ASA", amount: 1_000 }, { toBranchCode: "ASA", amount: 2_000 }],
  });
  assert.ok(errors.some((message) => message.includes("bị khai trùng")));
});

test("số tiền phải lớn hơn 0 và bắt buộc có hạng mục P&L", () => {
  const errors = validateCostReallocation({ fromBranchCode: "NME", pnlItemCode: "", lines: [{ toBranchCode: "ASA", amount: 0 }] });
  assert.ok(errors.some((message) => message.includes("Hạng mục P&L")));
  assert.ok(errors.some((message) => message.includes("lớn hơn 0")));
});

test("chi phí giảm ở nhà hàng đã trả, tăng đúng phần ở nhà hàng nhận", () => {
  const journals = planCostReallocationJournals(baseInput, "OPEX");
  assert.equal(journals.length, 3);

  const [fromJournal, asaJournal, hcmJournal] = journals;
  assert.equal(fromJournal.branchCode, "NME");
  // Ghi Có tài khoản chi phí = giảm chi phí trên P&L của nhà hàng đã trả.
  const fromExpense = fromJournal.lines.find((line) => line.accountCode === "6428");
  assert.equal(fromExpense.credit, 5_000_000);
  assert.equal(fromExpense.pnlItemCode, "CPBD_GAS");
  assert.equal(fromJournal.lines.find((line) => line.accountCode === "1368").debit, 5_000_000);

  assert.equal(asaJournal.branchCode, "ASA");
  assert.equal(asaJournal.lines.find((line) => line.accountCode === "6428").debit, 3_000_000);
  assert.equal(hcmJournal.lines.find((line) => line.accountCode === "6428").debit, 2_000_000);

  // Tổng chi phí toàn công ty không đổi: -5tr ở NME, +3tr ASA, +2tr HCM.
  const netExpense = journals
    .flatMap((journal) => journal.lines)
    .filter((line) => line.accountCode === "6428")
    .reduce((sum, line) => sum + line.debit - line.credit, 0);
  assert.equal(netExpense, 0);
});

test("mọi bút toán đều cân", () => {
  for (const journal of planCostReallocationJournals(baseInput, "OPEX")) {
    assert.ok(journalIsBalanced(journal), `Bút toán ${journal.branchCode} không cân`);
  }
});

test("hạng mục giá vốn đi vào tài khoản 632", () => {
  assert.equal(expenseAccountForPnlGroup("COGS"), "632");
  assert.equal(expenseAccountForPnlGroup("OPEX"), "6428");
  assert.equal(expenseAccountForPnlGroup(null), "6428");
  const journals = planCostReallocationJournals(baseInput, "COGS");
  assert.ok(journals[0].lines.some((line) => line.accountCode === "632" && line.credit === 5_000_000));
});

test("công nợ nội bộ gắn đúng đối tác đại diện nhà hàng", () => {
  assert.equal(internalPartnerCode("nme"), "NB-NME");
  const journals = planCostReallocationJournals(baseInput, "OPEX");
  assert.equal(journals[1].lines.find((line) => line.accountCode === "3368").partnerCode, "NB-NME");
});

/**
 * Câu báo lỗi phải NÓI THẲNG TIỀN ĐANG Ở ĐÂU (khách 21/09/2026).
 *
 * Câu cũ chỉ liệt kê ba ô cần kiểm lại nên kế toán phải tự mò, và kết luận là phần mềm chặn
 * nhầm rồi xin bỏ chặn. Bỏ chặn thì kỳ đó ôm chi phí âm ở MỘT hạng mục, cộng lên nhóm vẫn
 * dương nên không nổi lên dòng tổng — sổ lệch mà không ai thấy.
 */
test("chỉ thẳng phiếu chi chưa vào sổ, kèm mã phiếu và cách xử", () => {
  const message = reallocationOverspendMessage({
    period: "2026-09",
    fromBranchCode: "NME",
    pnlItemName: "CPNLD Lương Bảo Trì & Sửa Chữa",
    postedAmount: 0,
    total: 2_500_000,
    whereabouts: {
      otherPeriods: [],
      otherBranches: [],
      notPostedVouchers: [{ code: "PC-2609-NME-00012", amount: 2_500_000, status: "APPROVED" }],
      notPostedTotal: 2_500_000,
    },
  });
  assert.ok(message.includes("PC-2609-NME-00012"), "phải in mã phiếu chi để người dùng mở đúng phiếu");
  assert.ok(message.includes("CHƯA VÀO SỔ"));
  assert.ok(message.includes("Đồng bộ ghi sổ"), "phải nói cách xử, không chỉ nói triệu chứng");
});

test("chỉ thẳng kỳ khác đang giữ chi phí", () => {
  const message = reallocationOverspendMessage({
    period: "2026-09",
    fromBranchCode: "NME",
    pnlItemName: "CP Điện nước",
    postedAmount: 0,
    total: 1_000_000,
    whereabouts: {
      otherPeriods: [{ period: "2026-08", amount: 4_000_000 }],
      otherBranches: [],
      notPostedVouchers: [],
      notPostedTotal: 0,
    },
  });
  assert.ok(message.includes("2026-08"), "phải chỉ ra kỳ đang giữ chi phí");
  assert.ok(message.includes("4.000.000 đ"));
  assert.ok(message.includes("Ngày chứng từ"));
});

test("chỉ thẳng nhà hàng khác đang giữ chi phí", () => {
  const message = reallocationOverspendMessage({
    period: "2026-09",
    fromBranchCode: "NME",
    pnlItemName: "CP Gas",
    postedAmount: 0,
    total: 1_000_000,
    whereabouts: {
      otherPeriods: [],
      otherBranches: [{ branchCode: "ASA", amount: 7_000_000 }],
      notPostedVouchers: [],
      notPostedTotal: 0,
    },
  });
  assert.ok(message.includes("ASA"));
  assert.ok(message.includes("Nhà hàng đã trả"));
});

test("không tìm được tiền ở đâu thì vẫn giữ câu hướng dẫn cũ", () => {
  const message = reallocationOverspendMessage({
    period: "2026-09",
    fromBranchCode: "NME",
    pnlItemName: "CP Khác",
    postedAmount: 0,
    total: 1_000_000,
    whereabouts: { otherPeriods: [], otherBranches: [], notPostedVouchers: [], notPostedTotal: 0 },
  });
  assert.ok(message.includes("Ngày chứng từ"));
  assert.ok(message.includes("hạng mục P&L"));
});

test("phiếu hợp lệ thì không báo gì dù có tiền nằm chỗ khác", () => {
  const message = reallocationOverspendMessage({
    period: "2026-09",
    fromBranchCode: "NME",
    pnlItemName: "CP Gas",
    postedAmount: 5_000_000,
    total: 1_000_000,
    whereabouts: {
      otherPeriods: [{ period: "2026-08", amount: 9_000_000 }],
      otherBranches: [],
      notPostedVouchers: [],
      notPostedTotal: 0,
    },
  });
  assert.equal(message, null);
});

test("phân bổ ở kỳ không có chi phí gốc bị chặn và chỉ ra ba ô hay khai sai", () => {
  const message = reallocationOverspendMessage({
    period: "2026-09",
    fromBranchCode: "NME",
    pnlItemName: "CPNLD Lương Bảo Trì & Sửa Chữa",
    postedAmount: 0,
    total: 2_500_000,
  });
  assert.ok(message.includes("chưa có đồng chi phí nào"));
  assert.ok(message.includes("2026-09"));
  assert.ok(message.includes("Ngày chứng từ"));
});

test("phân bổ quá phần chi phí còn lại bị chặn, kèm số còn lại", () => {
  const message = reallocationOverspendMessage({
    period: "2026-08",
    fromBranchCode: "NME",
    pnlItemName: "CPNLD Lương Bảo Trì & Sửa Chữa",
    postedAmount: 1_200_000,
    total: 2_500_000,
  });
  assert.ok(message.includes("chỉ còn 1.200.000 đ"));
});

test("phân bổ đúng kỳ, trong phần chi phí đang có thì cho qua", () => {
  const ok = { period: "2026-08", fromBranchCode: "NME", pnlItemName: "Lương BTSC", postedAmount: 6_700_000 };
  assert.equal(reallocationOverspendMessage({ ...ok, total: 2_500_000 }), null);
  // Phân bổ trọn vẹn cả khoản chi phí vẫn hợp lệ: nhà hàng trả hộ 100% cho nhà hàng khác.
  assert.equal(reallocationOverspendMessage({ ...ok, total: 6_700_000 }), null);
});
