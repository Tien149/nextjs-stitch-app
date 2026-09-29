import { cogsPurchaseAccount, inventoryCogsActive } from "@/lib/inventory-cogs";
import {
  branchCodeFromInternalPartner,
  INTERNAL_PAYABLE_ACCOUNT,
  INTERNAL_RECEIVABLE_ACCOUNT,
  internalPartnerCode,
} from "@/lib/cost-reallocation";
import { isOtherIncomeCategory } from "@/lib/pnl-ordering";
import {
  ADVANCE_RECEIVABLE_ACTION,
  BANK_STATEMENT_SPLIT_SOURCE_SCOPE,
  isCollectOnBehalfCategory,
  normalizeCategoryGroup,
  PARTNER_COLLECTION_ACTION,
  PREPAID_ALLOCATION_ACTION,
} from "@/lib/voucher-rules";

/**
 * Định khoản cho phiếu thu/chi.
 *
 * Tiền vào không đồng nghĩa với doanh thu, tiền ra không đồng nghĩa với chi phí.
 * Trước đây mọi phiếu thu đều ghi Có 511 và mọi phiếu chi đều ghi Nợ 6428, khiến báo cáo
 * P&L bị thổi lên bằng chính các khoản chỉ là dịch chuyển dòng tiền (nhận cọc, trả nợ,
 * mua tài sản). Bảng dưới đây tách hai việc đó ra.
 */

export type VoucherForPosting = {
  voucherType: string;
  amount: number;
  moneySourceCode: string;
  partnerCode: string | null;
  /** Chi hộ: đối tác sẽ hoàn lại tiền — vế Nợ 131 mang mã này, không mang mã người nhận tiền. */
  receivablePartnerCode?: string | null;
  categoryCode: string | null;
  pnlItemCode: string | null;
  depositAction: string | null;
  debtAction: string | null;
  /** Nguồn gốc chứng từ; phiếu tách từ dòng sao kê có luật định khoản riêng. */
  sourceScope?: string | null;
  /** Ngày chứng từ — từ kỳ giá vốn theo kho (lib/inventory-cogs.ts) chi nhóm Giá vốn ghi Nợ 152. */
  voucherDate?: Date | string | null;
};

/**
 * Tín hiệu định khoản phiếu THU mà nhóm khoản mục đã chuẩn hoá không diễn đạt được.
 * `isRevenueSourceCategory`: khoản mục thu/chi khai THẬT nhóm "Nguồn doanh thu" trong danh mục,
 * phân biệt với nhóm "Thu khác" (RECEIPT) vốn bị normalizeCategoryGroup gộp chung.
 */
export type ReceiptPostingOptions = { isRevenueSourceCategory?: boolean };

export type JournalLineInput = {
  accountCode: string;
  debit?: number;
  credit?: number;
  partnerCode?: string | null;
  categoryCode?: string | null;
  pnlItemCode?: string | null;
};

export function cashAccountFor(moneySourceCode: string) {
  return moneySourceCode.toUpperCase().includes("CASH") ? "1111" : "1121";
}

/**
 * Tài khoản đối ứng của phiếu THU, kèm lý do để hiển thị/kiểm thử.
 *
 * `pnlItemGroup` là nhóm lớn của Hạng mục P&L kế toán chọn trên phiếu. Chọn hạng mục thuộc
 * nhóm Thu nhập khác là khai rõ "khoản này là thu nhập khác" (lãi ngân hàng, thanh lý tài sản,
 * bồi thường...), nên nó thắng cái fallback "có đối tác thì treo 131" bên dưới — nếu không,
 * khoản thu nhập khác có ghi tên đối tác sẽ nằm im ở phải thu và không bao giờ lên dòng
 * "7. Thu nhập khác" của P&L.
 */
export function receiptCounterAccount(
  voucher: VoucherForPosting,
  categoryGroup: string | null,
  pnlItemGroup: string | null = null,
  options: ReceiptPostingOptions = {},
  knownBranchCodes?: Iterable<string> | null,
) {
  if (voucher.depositAction === "COLLECT" || voucher.depositAction === "SUPPLEMENT") {
    return { account: "3387", reason: "Nhận tiền cọc — khách ứng trước, chưa phải doanh thu" };
  }
  if (voucher.depositAction === "REVENUE") {
    return { account: "511", reason: "Chuyển tiền cọc thành doanh thu" };
  }
  if (voucher.debtAction === "SETTLE") {
    return { account: "131", reason: "Thu hồi công nợ phải thu — không phát sinh doanh thu mới" };
  }
  // Thu lại tiền chi hộ theo đối tác: cùng bản chất với gạch nợ, chỉ khác là hệ thống tự tìm
  // khoản nợ. Đối tác là nhà hàng trong nhà thì khoản chi hộ trước đó đã treo 1368, nên thu về
  // phải ghi Có đúng 1368 để hai vế triệt tiêu — để 131 là phải thu nội bộ treo mãi.
  if (voucher.debtAction === PARTNER_COLLECTION_ACTION) {
    if (branchCodeFromInternalPartner(voucher.partnerCode, knownBranchCodes)) {
      return { account: INTERNAL_RECEIVABLE_ACCOUNT, reason: "Thu lại tiền chi hộ nhà hàng khác — giảm phải thu nội bộ, không phải doanh thu" };
    }
    return { account: "131", reason: "Thu lại tiền chi hộ của đối tác — giảm phải thu, không phải doanh thu" };
  }
  // THU HỘ: tiền về tài khoản nhưng là của người khác, phải trả lại. Mọi khoản mục nhóm "Thu"
  // bên dưới đều rơi vào Có 511, nên không chặn ở đây thì tiền thu hộ vừa bị gỡ khỏi "Tiền đã
  // vô" lại quay vào sổ thành doanh thu. Nhận diện theo khoản mục (phiếu thu lập tay cũng
  // đúng) và theo phiếu tách từ dòng sao kê (khách chưa có mã Thu hộ vẫn an toàn).
  if (isCollectOnBehalfCategory(voucher.categoryCode) || voucher.sourceScope === BANK_STATEMENT_SPLIT_SOURCE_SCOPE) {
    return voucher.partnerCode
      ? { account: "131", reason: "Thu hộ — treo công nợ của đối tác sẽ nhận lại tiền, không phải doanh thu" }
      // Không biết thu hộ cho ai thì vẫn không được ghi doanh thu: treo phải trả khác cho tới
      // khi kế toán bổ sung đối tác.
      : { account: "3388", reason: "Thu hộ chưa khai đối tác — treo phải trả khác, không phải doanh thu" };
  }
  // Khoản mục thu/chi là tầng chốt: khai nhóm doanh thu thì đó là doanh thu bán hàng, dù ai đó
  // lỡ gắn thêm hạng mục P&L thu nhập khác. Để hạng mục thắng ở đây thì một khoản doanh thu
  // rơi xuống dòng 7 và biến mất khỏi doanh thu thuần — sai lệch nặng hơn nhiều so với việc bỏ
  // qua một hạng mục khai nhầm.
  //
  // Chỉ tin khoản mục khai THẬT nhóm doanh thu (`isRevenueSourceCategory`). Biến `categoryGroup`
  // đi qua normalizeCategoryGroup, nơi gộp luôn nhóm "Thu khác" (RECEIPT) về REVENUE_SOURCE —
  // dùng nó ở đây thì MỌI phiếu thu đều ghi Có 511 và không khoản nào lên được dòng Thu nhập
  // khác, kể cả khi kế toán đã chọn đúng hạng mục.
  //
  // Nơi gọi không truyền cờ thì mặc định quay về đúng hành vi cũ (nhóm đã chuẩn hoá), để phiếu
  // ghi sổ qua đường khác không đổi tài khoản chỉ vì thêm tham số.
  const isRevenueSourceCategory = options.isRevenueSourceCategory ?? (categoryGroup === "REVENUE_SOURCE");
  if (isRevenueSourceCategory) {
    return { account: "511", reason: "Doanh thu bán hàng" };
  }
  if (pnlItemGroup === "OTHER_INCOME") {
    return { account: "711", reason: "Thu nhập khác theo hạng mục P&L đã chọn" };
  }
  // Khoản mục thu luôn là thu nhập khác (lãi ngân hàng) phải thắng nhánh "có đối tác thì treo
  // 131" bên dưới: phiếu lãi ngân hàng gần như luôn ghi tên ngân hàng ở ô đối tác, để rơi
  // xuống 131 thì tiền nằm im ở công nợ phải thu và dòng "7. Thu nhập khác" mãi bằng 0.
  if (isOtherIncomeCategory(voucher.categoryCode)) {
    return { account: "711", reason: "Thu nhập khác theo khoản mục thu đã chọn" };
  }
  // Nhóm "Thu khác" được normalizeCategoryGroup gộp về REVENUE_SOURCE từ trước: phiếu thu khác
  // không khai hạng mục vẫn ghi Có 511 y như cũ, không đụng tới dữ liệu lịch sử.
  if (categoryGroup === "REVENUE_SOURCE") {
    return { account: "511", reason: "Doanh thu bán hàng" };
  }
  if (voucher.partnerCode) {
    return { account: "131", reason: "Thu của đối tác, chưa gán khoản mục doanh thu" };
  }
  return { account: "711", reason: "Thu nhập khác" };
}

/**
 * Tài khoản đối ứng của phiếu CHI, kèm lý do.
 *
 * `knownBranchCodes` là danh mục cửa hàng có thật — cần để biết "đối tác sẽ trả lại tiền" của
 * phiếu chi hộ là một nhà hàng trong nhà (1368) hay chỉ là đối tác có mã bắt đầu bằng NB- (131).
 */
export function paymentCounterAccount(
  voucher: VoucherForPosting,
  categoryGroup: string | null,
  knownBranchCodes?: Iterable<string> | null,
) {
  if (voucher.depositAction === "REFUND") {
    return { account: "3387", reason: "Hoàn tiền cọc — giảm khoản khách ứng trước, không phải chi phí" };
  }
  if (voucher.debtAction === "SETTLE") {
    return { account: "331", reason: "Trả nợ nhà cung cấp — không phải chi phí phát sinh mới" };
  }
  if (voucher.debtAction === ADVANCE_RECEIVABLE_ACTION) {
    // Chi hộ một nhà hàng khác là công nợ NỘI BỘ: để ở 131 thì toàn công ty thấy một khoản
    // phải thu bên ngoài không bao giờ triệt tiêu, trong khi 1368 khớp thẳng với 3368 mà nhà
    // hàng thụ hưởng ghi ở bút toán đối ứng.
    if (branchCodeFromInternalPartner(voucher.receivablePartnerCode, knownBranchCodes)) {
      return { account: INTERNAL_RECEIVABLE_ACCOUNT, reason: "Chi hộ nhà hàng khác — treo phải thu nội bộ, không phải chi phí" };
    }
    return { account: "131", reason: "Chi hộ — treo phải thu của đối tác sẽ hoàn lại, không phải chi phí" };
  }
  // Chi trả trước: tiền ra một cục nhưng chi phí thuộc về nhiều kỳ sau. Vào chi phí ngay ở đây
  // thì lịch phân bổ sinh từ chính phiếu này sẽ ghi chi phí lần thứ hai.
  if (voucher.debtAction === PREPAID_ALLOCATION_ACTION) {
    return { account: "242", reason: "Chi trả trước — treo chi phí trả trước, vào P&L dần theo lịch phân bổ" };
  }
  if (categoryGroup === "CAPEX") {
    return { account: "211", reason: "Chi đầu tư tài sản — ghi tăng tài sản, không vào P&L" };
  }
  if (categoryGroup === "COGS") {
    // Từ kỳ giá vốn theo kho: tiền mua nguyên liệu / bao bì là hàng NHẬP KHO, giá vốn lên P&L
    // lúc hàng rời kho (lib/inventory-cogs.ts). Vẫn ghi 632 thì giá vốn bị tính hai lần.
    if (voucher.voucherDate && inventoryCogsActive(voucher.voucherDate)) {
      return { account: "152", reason: "Mua nguyên liệu / bao bì — ghi tăng tồn kho, giá vốn tính khi xuất kho" };
    }
    return { account: "632", reason: "Giá vốn hàng bán" };
  }
  // Chi phí khác (811) không phải chi phí vận hành: phạt, bồi thường, lỗ thanh lý tài sản...
  // Đứng ở dòng "8. Chi phí khác" dưới lợi nhuận hoạt động, không làm hỏng tỷ lệ OPEX/doanh thu.
  if (categoryGroup === "OTHER_EXPENSE") {
    return { account: "811", reason: "Chi phí khác" };
  }
  return { account: "6428", reason: "Chi phí vận hành" };
}

export function voucherJournalLines(
  voucher: VoucherForPosting,
  categoryGroup: string | null,
  pnlItemGroup: string | null = null,
  knownBranchCodes?: Iterable<string> | null,
  receiptOptions: ReceiptPostingOptions = {},
) {
  const cashAccount = cashAccountFor(voucher.moneySourceCode);
  if (voucher.voucherType === "RECEIPT") {
    const { account, reason } = receiptCounterAccount(voucher, categoryGroup, pnlItemGroup, receiptOptions, knownBranchCodes);
    return {
      reason,
      lines: [
        { accountCode: cashAccount, debit: voucher.amount },
        { accountCode: account, credit: voucher.amount, partnerCode: voucher.partnerCode, categoryCode: voucher.categoryCode, pnlItemCode: voucher.pnlItemCode },
      ] as JournalLineInput[],
    };
  }
  // Khi kế toán chọn Hạng mục P&L riêng, nhóm của hạng mục đó quyết định dòng P&L.
  // Nếu để trống, giữ cách hạch toán cũ theo Khoản mục thu/chi để dữ liệu lịch sử không đổi.
  const { account, reason } = paymentCounterAccount(voucher, pnlItemGroup || categoryGroup, knownBranchCodes);
  // Chi hộ: khoản nợ thuộc về đối tác sẽ hoàn tiền, và phiếu không có mặt trên P&L nên
  // hạng mục P&L (nếu ai đó lỡ khai) không được đi kèm dòng 131.
  const isAdvanceReceivable = voucher.debtAction === ADVANCE_RECEIVABLE_ACTION;
  // Chi trả trước cũng chưa có mặt trên P&L ở kỳ này: hạng mục P&L của phiếu là hạng mục mà
  // LỊCH PHÂN BỔ sẽ mang, không phải của dòng 242, nên không đi kèm bút toán này.
  const isPrepaidAllocation = voucher.debtAction === PREPAID_ALLOCATION_ACTION;
  return {
    reason,
    lines: [
      {
        accountCode: account,
        debit: voucher.amount,
        partnerCode: isAdvanceReceivable ? (voucher.receivablePartnerCode || voucher.partnerCode) : voucher.partnerCode,
        categoryCode: voucher.categoryCode,
        // 152 là tồn kho, không phải dòng P&L: bỏ hạng mục để không bị gom nhầm lên báo cáo.
        pnlItemCode: isAdvanceReceivable || isPrepaidAllocation || account === "152" ? null : voucher.pnlItemCode,
      },
      { accountCode: cashAccount, credit: voucher.amount },
    ] as JournalLineInput[],
  };
}

/**
 * Nhóm lớn (OPEX / COGS / CAPEX / OTHER_INCOME...) của từng hạng mục P&L, tra theo mã.
 *
 * Hạng mục khai trên màn Danh mục thường CHỈ chọn nhóm cha (`subGroup` trỏ tới PNL_GROUP),
 * còn ô `group` của chính nó để trống — nên đọc nhóm của hạng mục, không có thì nhóm cha.
 * Phiếu có thể mang thẳng mã NHÓM (nhóm chưa có hạng mục con) nên mã nhóm cũng tra được.
 * Dùng chung cho Đồng bộ ghi sổ và cho P&L đọc thẳng chứng từ (lib/reports.ts).
 */
export function pnlItemGroupLookup(
  pnlItems: Array<{ code: string; group: string | null; subGroup: string | null }>,
  pnlGroups: Array<{ code: string; group: string | null }>,
) {
  const pnlGroupGroupByCode = new Map(pnlGroups.map((group) => [group.code, group.group]));
  const byCode = new Map(pnlItems.map((item) => [
    item.code,
    normalizeCategoryGroup(item.group || (item.subGroup ? pnlGroupGroupByCode.get(item.subGroup) ?? null : null)),
  ]));
  for (const group of pnlGroups) {
    if (!byCode.has(group.code)) byCode.set(group.code, normalizeCategoryGroup(group.group));
  }
  return byCode;
}

/**
 * Vế NỢ của công nợ phải trả khai tay (Công nợ Đối tác): nhóm của hạng mục quyết định khoản nợ
 * là giá vốn, chi phí vận hành hay tiền mua tài sản. Khoản phân bổ theo kỳ treo 242 (lịch
 * PB-<mã công nợ> rút dần vào chi phí), 242 / 152 không phải dòng P&L nên bỏ hạng mục.
 */
export function payableDebtDebitLine(
  row: { recognizeExpense: boolean; allocationMonths: number | null; documentDate: Date; originalAmount: number; partnerCode: string | null; categoryCode: string | null; pnlItemCode: string | null },
  debtGroup: string | null,
): JournalLineInput {
  const isAllocated = !row.recognizeExpense && (row.allocationMonths || 0) > 1;
  const debitAccount = isAllocated ? "242" : debtGroup === "CAPEX" ? "211" : debtGroup === "COGS" ? cogsPurchaseAccount(row.documentDate) : "6428";
  return isAllocated || debitAccount === "152"
    ? { accountCode: debitAccount, debit: row.originalAmount, partnerCode: row.partnerCode }
    : { accountCode: debitAccount, debit: row.originalAmount, partnerCode: row.partnerCode, categoryCode: row.categoryCode, pnlItemCode: row.pnlItemCode };
}

/**
 * Bút toán ĐỐI ỨNG của phiếu chi hộ nhà hàng khác, ghi ở sổ của nhà hàng được chi hộ.
 *
 * Nam Mê trả tiền cho NCC thay Asa thì bên Nam Mê chỉ có "tiền ra, treo phải thu nội bộ".
 * Nếu dừng ở đó, khoản NCC mà Asa đang nợ vẫn nằm nguyên trên sổ Asa dù tiền đã trả — đúng
 * lỗi khách báo. Vế còn lại của nghiệp vụ nằm ở sổ Asa: GIẢM phải trả NCC, chuyển sang PHẢI
 * TRẢ NỘI BỘ Nam Mê. Hai tài khoản 1368/3368 triệt tiêu nhau khi xem toàn công ty.
 *
 * Trả null khi phiếu không phải chi hộ nội bộ (chi hộ đối tác bên ngoài giữ nguyên như cũ).
 */
export function advanceReceivableCounterpartJournal(voucher: {
  voucherType: string;
  amount: number;
  branchCode: string;
  partnerCode: string | null;
  receivablePartnerCode?: string | null;
  debtAction: string | null;
}, knownBranchCodes?: Iterable<string> | null) {
  if (voucher.voucherType !== "PAYMENT" || voucher.debtAction !== ADVANCE_RECEIVABLE_ACTION) return null;
  const beneficiaryBranch = branchCodeFromInternalPartner(voucher.receivablePartnerCode, knownBranchCodes);
  const payerBranch = (voucher.branchCode || "").trim().toUpperCase();
  if (!beneficiaryBranch || !payerBranch || beneficiaryBranch === payerBranch) return null;
  if (!(voucher.amount > 0)) return null;
  return {
    branchCode: beneficiaryBranch,
    lines: [
      { accountCode: "331", debit: voucher.amount, partnerCode: voucher.partnerCode },
      { accountCode: INTERNAL_PAYABLE_ACCOUNT, credit: voucher.amount, partnerCode: internalPartnerCode(payerBranch) },
    ] as JournalLineInput[],
  };
}
