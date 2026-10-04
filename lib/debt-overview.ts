/**
 * Công nợ đối tác — tổng hợp theo đối tác và sổ chi tiết một đối tác (tách khỏi app/api/debts
 * 04/10/2026 để Báo cáo nguồn tiền dùng chung đúng số dư phải thu / phải trả của màn Công nợ cho
 * cột Dự thu / Dự chi — xem lib/reports.ts getCashSourceReport).
 */
import { skipsDebtTracking } from "@/lib/retail-customer";
import { prisma } from "@/lib/prisma";
import { periodBounds } from "@/lib/accounting";
import { debtGroupCode } from "@/lib/debt-group";
import { isAdvanceSettlementDebt } from "@/lib/employee-advance";
import { internalPartnerCode } from "@/lib/cost-reallocation";
import { ADVANCE_RECEIVABLE_ACTION, PARTNER_COLLECTION_ACTION } from "@/lib/voucher-rules";
import { advanceReceivableBeneficiaryBranch } from "@/lib/voucher-side-effects";
import { bankSigned, debtBalanceOf, debtRecordGrossSigned, debtRecordSigned, depositSigned, openingBalanceSigned, voucherSigned } from "@/lib/debt-balance";

export type DebtRow = {
  partnerCode: string;
  partnerName: string;
  openingAmount: number;
  depositHolding: number;
  bankMatched: number;
  voucherNet: number;
  purchasePayable: number;
  debtReceivable: number;
  debtPayable: number;
  partnerGroup: string;
  /** Đối tác khai "Không theo dõi công nợ" — màn hình nói rõ để không ai đi tìm số đã bị loại. */
  skipDebtTracking: boolean;
  nearestDueDate: Date | null;
  overdueAmount: number;
  dueSoonAmount: number;
  openDebtCount: number;
  debtStatus: string;
  balance: number;
};

export type LedgerRow = {
  /** Chỉ có với dòng đến từ DebtRecord, để màn hình công nợ gọi được PATCH/DELETE. */
  id?: string;
  /** Mã phiếu cha khi khoản này là một dòng của phiếu công nợ nhiều hạng mục. */
  groupCode?: string | null;
  date: Date;
  dueDate?: Date | null;
  source: string;
  code: string;
  description: string;
  amount: number;
  status?: string;
  agingBucket?: string;
  /** Hạng mục P&L của khoản PHẢI TRẢ — trả về để màn Công nợ mở sửa lại được khi user chọn nhầm. */
  pnlItemCode?: string | null;
  /** Nhóm hạng mục P&L của khoản PHẢI THU. */
  pnlGroupCode?: string | null;
  /** Phân bổ theo kỳ của khoản phải trả (lịch PB-<mã>). */
  allocationMonths?: number | null;
  allocationStartPeriod?: string | null;
  sourceType?: string | null;
};

const money = (value: number) => new Intl.NumberFormat("vi-VN").format(Math.round(value));

export function agingBucket(dueDate?: Date | null) {
  if (!dueDate) return "NO_DUE_DATE";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);
  const diffDays = Math.ceil((due.getTime() - today.getTime()) / 86400000);
  if (diffDays < 0) return "OVERDUE";
  if (diffDays <= 7) return "DUE_7";
  return "OPEN";
}

/**
 * Khoảng thời gian người dùng chọn trên màn Công nợ (yêu cầu 08/09/2026: đối chiếu được ở
 * từng thời điểm). Phát sinh TRƯỚC `from` gộp vào Đầu kỳ, SAU `toExclusive` bỏ hẳn; không
 * chọn gì thì mọi phát sinh đều "trong kỳ" như trước.
 */
export type DateRange = { from: Date | null; toExclusive: Date | null; fromDate: string; toDate: string };

export function parseDateRange(fromRaw: string | null, toRaw: string | null): DateRange {
  const isDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);
  const fromDate = (fromRaw || "").trim();
  const toDate = (toRaw || "").trim();
  const from = isDay(fromDate) ? new Date(`${fromDate}T00:00:00`) : null;
  const to = isDay(toDate) ? new Date(`${toDate}T00:00:00`) : null;
  if (to) to.setDate(to.getDate() + 1);
  return { from, toExclusive: to, fromDate: from ? fromDate : "", toDate: to ? toDate : "" };
}

function dateBucket(date: Date, range: DateRange): "BEFORE" | "IN" | "AFTER" {
  if (range.toExclusive && date >= range.toExclusive) return "AFTER";
  if (range.from && date < range.from) return "BEFORE";
  return "IN";
}

/** Ngày nghiệp vụ của số dư đầu kỳ là ngày đầu kỳ khai, không phải lúc bấm lưu. */
const openingBalanceDate = (period: string) => periodBounds(period).start;

function addDebt(rows: Map<string, DebtRow>, code: string, name: string, patch: Partial<DebtRow>) {
  if (!code) return;
  const current =
    rows.get(code) ||
    {
      partnerCode: code,
      partnerName: name || code,
      openingAmount: 0,
      depositHolding: 0,
      bankMatched: 0,
      voucherNet: 0,
      purchasePayable: 0,
      debtReceivable: 0,
      debtPayable: 0,
      partnerGroup: "EXTERNAL",
      skipDebtTracking: false,
      nearestDueDate: null,
      overdueAmount: 0,
      dueSoonAmount: 0,
      openDebtCount: 0,
      debtStatus: "NO_DEBT",
      balance: 0,
    };

  rows.set(code, { ...current, partnerName: name || current.partnerName, ...patch });
}

/**
 * Không có `partnerCode`: bảng tổng hợp theo đối tác (`kind: "summary"`). Có: sổ chi tiết của
 * đối tác đó trong khoảng chọn (`kind: "ledger"`). `branchCode` đã qua kiểm quyền ở nơi gọi.
 */
export async function loadDebtOverview({ branchCode, range, partnerCode }: { branchCode: string; range: DateRange; partnerCode?: string | null }) {
  const branchFilter = branchCode === "ALL" ? {} : { branchCode };
  const [partners, branchItems, openingBalances, deposits, bankRows, ownVouchers, advanceVouchers, purchasePayables, debtRecords, settlementVouchers, allocationVouchers, settlements] = await Promise.all([
    prisma.masterDataItem.findMany({ where: { type: "PARTNER" } }),
    // Danh mục Cửa hàng: dùng để chắc chắn "đối tác sẽ trả lại tiền" của phiếu chi hộ là
    // một nhà hàng thật, không phải đối tác tự đặt mã bắt đầu bằng NB-.
    prisma.masterDataItem.findMany({ where: { type: "BRANCH" }, select: { code: true } }),
    prisma.openingBalance.findMany({ where: { balanceType: { in: ["AR", "AP"] }, ...branchFilter } }),
    prisma.deposit.findMany({ where: branchFilter }),
    prisma.bankStatementTransaction.findMany({ where: { partnerHint: { not: null }, ...(branchCode === "ALL" ? {} : { branchCode }) } }),
    prisma.financialVoucher.findMany({ where: { partnerCode: { not: null }, status: "APPROVED", debtAction: null, ...branchFilter } }),
    // Phiếu chi hộ NHÀ HÀNG KHÁC lập ở cửa hàng đã ứng tiền, nhưng khoản NCC nó trả là nợ
    // của cửa hàng được chi hộ — nên phải lấy theo "đối tác sẽ trả lại tiền", không theo
    // cửa hàng của phiếu. Thiếu vế này thì công nợ NCC bên được chi hộ treo mãi dù tiền
    // đã trả (feedback khách 15/09/2026).
    prisma.financialVoucher.findMany({
      where: {
        voucherType: "PAYMENT",
        status: "APPROVED",
        debtAction: ADVANCE_RECEIVABLE_ACTION,
        partnerCode: { not: null },
        ...(branchCode === "ALL" ? { receivablePartnerCode: { not: null } } : { receivablePartnerCode: internalPartnerCode(branchCode) }),
      },
    }),
    prisma.supplierPayable.findMany({ where: branchCode === "ALL" ? {} : { purchaseOrder: { branchCode } }, include: { purchaseOrder: true } }),
    prisma.debtRecord.findMany({ where: branchFilter }),
    // Phiếu GẠCH NỢ (thu lại công nợ theo mã, thu lại chi hộ theo đối tác): trước đây bị bỏ
    // hẳn khỏi sổ vì khoản nợ đã ghi số CÒN NỢ. Nay sổ ghi gộp — khoản nợ đứng nguyên số phát
    // sinh, phiếu gạch đứng thành dòng riêng — nên phiếu phải có mặt với ĐÚNG số tiền trên
    // phiếu, kể cả phần trả dư không còn khoản nào để gạch (feedback khách 20/09/2026).
    prisma.financialVoucher.findMany({
      where: { status: "APPROVED", debtAction: { in: ["SETTLE", PARTNER_COLLECTION_ACTION] }, ...branchFilter },
    }),
    // Phiếu đại diện (một người nhận, nhiều đối tác) không có partnerCode nên trước đây cũng
    // vắng mặt; từng dòng phân bổ là phát sinh của đúng đối tác trên dòng đó.
    prisma.financialVoucher.findMany({
      where: { status: "APPROVED", partnerCode: null, partnerAllocations: { some: {} }, ...branchFilter },
      include: { partnerAllocations: true },
    }),
    prisma.debtSettlement.findMany({
      where: { debt: branchFilter },
      select: { debtId: true, voucherId: true, amount: true, debt: { select: { code: true, partnerCode: true } } },
    }),
  ]);

  // Đã gạch bao nhiêu trên từng khoản nợ (để ghi khoản nợ theo số phát sinh) và từng phiếu
  // gạch đã áp vào những khoản nào (để ghi rõ trên dòng phiếu, phần dôi ra gọi tên "trả dư").
  const settledByDebt = new Map<string, { amount: number; voucherIds: string[] }>();
  const settledByVoucher = new Map<string, { amount: number; debtCodes: string[]; partnerCodes: string[] }>();
  for (const row of settlements) {
    const byDebt = settledByDebt.get(row.debtId) || { amount: 0, voucherIds: [] };
    byDebt.amount += row.amount;
    if (!byDebt.voucherIds.includes(row.voucherId)) byDebt.voucherIds.push(row.voucherId);
    settledByDebt.set(row.debtId, byDebt);
    const byVoucher = settledByVoucher.get(row.voucherId) || { amount: 0, debtCodes: [], partnerCodes: [] };
    byVoucher.amount += row.amount;
    if (!byVoucher.debtCodes.includes(row.debt.code)) byVoucher.debtCodes.push(row.debt.code);
    if (!byVoucher.partnerCodes.includes(row.debt.partnerCode)) byVoucher.partnerCodes.push(row.debt.partnerCode);
    settledByVoucher.set(row.voucherId, byVoucher);
  }
  const voucherCodeById = new Map([...settlementVouchers, ...ownVouchers, ...allocationVouchers].map((row) => [row.id, row.code]));
  const settledNote = (debtId: string) => {
    const settled = settledByDebt.get(debtId);
    if (!settled || settled.amount <= 0) return "";
    const codes = settled.voucherIds.map((id) => voucherCodeById.get(id) || "phiếu không còn hiệu lực").join(", ");
    return ` · đã gạch ${money(settled.amount)} bằng ${codes}`;
  };
  /**
   * Dòng phát sinh của một phiếu gạch nợ, đứng tên đối tác trên phiếu (thu lại chi hộ theo đối
   * tác bắt buộc có đối tác; gạch theo mã mà bỏ trống đối tác thì lấy đối tác của khoản nợ đã
   * gạch). Số tiền là số trên phiếu: phần áp vào khoản nợ + phần trả dư.
   */
  const settlementLines = settlementVouchers.map((item) => {
    const applied = settledByVoucher.get(item.id);
    const partner = item.partnerCode || applied?.partnerCodes[0] || null;
    const excess = Math.round(item.amount - (applied?.amount || 0));
    const detail = applied && applied.debtCodes.length > 0 ? ` · gạch ${applied.debtCodes.join(", ")}` : "";
    const excessNote = excess > 0
      ? ` · ${item.debtAction === PARTNER_COLLECTION_ACTION ? "thu dư" : "trả dư"} ${money(excess)} (không còn khoản nào để gạch)`
      : "";
    return {
      partnerCode: partner,
      partnerName: item.partnerName,
      date: item.voucherDate,
      code: item.code,
      description: `${item.description}${detail}${excessNote}`,
      amount: voucherSigned(item.voucherType, item.amount),
    };
  }).filter((line): line is typeof line & { partnerCode: string } => Boolean(line.partnerCode));
  const allocationLines = allocationVouchers.flatMap((item) => item.partnerAllocations.map((line) => ({
    partnerCode: line.partnerCode,
    partnerName: line.partnerName,
    date: item.voucherDate,
    code: item.code,
    description: `${item.description}${line.debtReference ? ` · gạch ${line.debtReference}` : ""}${line.note ? ` · ${line.note}` : ""}`,
    amount: voucherSigned(item.voucherType, line.amount),
  })));

  // Chi hộ đối tác BÊN NGOÀI không nằm ở đây: khoản đó là nợ của chính cửa hàng lập phiếu,
  // đã treo phải thu CNTHU rồi, gạch thêm vào NCC nữa là trừ hai lần.
  const knownBranchCodes = branchItems.map((item) => item.code);
  /**
   * Đối tác khai "Không theo dõi công nợ" (khách lẻ, khách vãng lai — cờ skipDebtTracking trên
   * danh mục Đối tác).
   *
   * Bảng này cộng MỌI chứng từ có mã đối tác, không xét loại chứng từ hay khoản mục, nên tiền
   * bán hàng về tài khoản mà có gắn tên đối tác là số phải trả phình lên ảo (khách báo
   * 22/09/2026). Cờ chỉ chặn hai nguồn SUY RA từ chứng từ: phiếu thu/chi thường và dòng sao kê
   * gợi ý đối tác. Khoản nợ đã ghi nhận hẳn hoi — khoản nợ, công nợ NCC, tiền cọc, số dư đầu
   * kỳ, phiếu gạch nợ — vẫn tính đủ, để cờ này không bao giờ trở thành cái công tắc giấu nợ.
   */
  const untrackedDebtPartners = new Set(partners.filter(skipsDebtTracking).map((item) => item.code));
  /** Dòng sao kê gợi ý đúng đối tác không theo dõi công nợ cũng là số ảo như trên. */
  const debtBankRows = bankRows.filter((row) => !row.partnerHint || !untrackedDebtPartners.has(row.partnerHint));
  const vouchers = [
    ...ownVouchers.filter((row) => !row.partnerCode || !untrackedDebtPartners.has(row.partnerCode)),
    ...advanceVouchers.filter((row) => advanceReceivableBeneficiaryBranch(row, knownBranchCodes) !== null),
  ];

  if (partnerCode) {
    const ledger: LedgerRow[] = [];
    for (const item of openingBalances.filter((row) => row.objectCode === partnerCode)) {
      ledger.push({
        date: openingBalanceDate(item.period),
        source: "OPENING_BALANCE",
        code: `${item.period}-${item.balanceType}`,
        description: item.note || "Số dư đầu kỳ",
        amount: openingBalanceSigned(item.balanceType, item.amount),
      });
    }
    for (const item of deposits.filter((row) => row.partnerCode === partnerCode)) {
      ledger.push({
        date: item.receivedDate,
        source: "DEPOSIT",
        code: item.code,
        description: item.purpose,
        amount: depositSigned(item.remainingAmount),
      });
    }
    for (const item of debtBankRows.filter((row) => row.partnerHint === partnerCode)) {
      ledger.push({
        date: item.transactionDate,
        source: "BANK_STATEMENT",
        code: item.transactionCode,
        description: item.description,
        amount: bankSigned(item.creditAmount, item.debitAmount),
      });
    }
    for (const item of vouchers.filter((row) => row.partnerCode === partnerCode)) {
      ledger.push({
        date: item.voucherDate,
        source: "VOUCHER",
        code: item.code,
        // Dòng chi hộ là phiếu của cửa hàng KHÁC đứng ra trả: nói rõ ai trả, nếu không kế
        // toán mở sổ ra thấy một mã phiếu lạ không thuộc cửa hàng đang xem.
        description: item.debtAction === ADVANCE_RECEIVABLE_ACTION
          ? `${item.branchCode} chi hộ theo chứng từ ${item.code}: ${item.description}`
          : item.description,
        amount: voucherSigned(item.voucherType, item.amount),
      });
    }
    for (const line of [...settlementLines, ...allocationLines].filter((row) => row.partnerCode === partnerCode)) {
      ledger.push({ date: line.date, source: "VOUCHER", code: line.code, description: line.description, amount: line.amount });
    }
    for (const item of purchasePayables.filter((row) => row.supplierCode === partnerCode)) {
      ledger.push({
        date: item.recognizedDate,
        source: "PURCHASE_ORDER",
        code: item.purchaseOrder.code,
        description: `Công nợ nhập hàng ${item.purchaseOrder.code}`,
        amount: item.outstandingAmount,
      });
    }
    // Khoản đã gạch hết vẫn đứng trên sổ theo số phát sinh — dòng phiếu gạch bên dưới trừ lại.
    // Bỏ dòng này đi (như trước) thì đối tác trả dư nhìn vào sổ chỉ thấy... không có gì.
    for (const item of debtRecords.filter((row) => row.partnerCode === partnerCode && row.outstandingAmount + (settledByDebt.get(row.id)?.amount || 0) > 0)) {
      ledger.push({
        id: item.id,
        groupCode: debtGroupCode(item.code),
        date: item.documentDate,
        source: item.debtType,
        code: item.code,
        dueDate: item.dueDate,
        description: `${item.description}${item.dueDate ? ` · Hạn ${item.dueDate.toLocaleDateString("vi-VN")}` : ""}${settledNote(item.id)}`,
        amount: debtRecordGrossSigned(item.debtType, item.outstandingAmount, settledByDebt.get(item.id)?.amount || 0),
        status: item.status,
        agingBucket: agingBucket(item.dueDate),
        pnlItemCode: item.pnlItemCode,
        pnlGroupCode: item.pnlGroupCode,
        allocationMonths: item.allocationMonths,
        allocationStartPeriod: item.allocationStartPeriod,
        sourceType: item.sourceType,
      });
    }

    // Phát sinh trước khoảng chọn gộp thành một số Đầu kỳ; sau khoảng chọn bỏ hẳn. Xếp
    // tăng dần theo ngày để cộng dồn "Số dư sau" từng dòng (đối chiếu tại từng thời điểm),
    // rồi trả về giảm dần như cũ; cùng ngày thì xếp theo mã để các dòng của một phiếu
    // nhiều hạng mục đứng liền nhau.
    const openingBalance = ledger
      .filter((row) => dateBucket(row.date, range) === "BEFORE")
      .reduce((sum, row) => sum + row.amount, 0);
    const inRange = ledger
      .filter((row) => dateBucket(row.date, range) === "IN")
      .sort((a, b) => a.date.getTime() - b.date.getTime() || a.code.localeCompare(b.code, "vi", { numeric: true }));
    let running = openingBalance;
    const withRunning = inRange.map((row) => {
      running += row.amount;
      return { ...row, runningBalance: running };
    });
    const movementTotal = withRunning.reduce((sum, row) => sum + row.amount, 0);
    const partner = partners.find((item) => item.code === partnerCode);
    return {
      kind: "ledger" as const,
      partnerCode,
      partnerName: partner?.name || partnerCode,
      // Cho file đối chiếu công nợ gửi đối tác: loại đối tác quyết định tiêu đề Phải thu / Phải trả.
      partnerType: partner?.partnerType || partner?.group || null,
      partnerTaxCode: partner?.taxCode || null,
      partnerAddress: partner?.address || null,
      balance: openingBalance + movementTotal,
      openingBalance,
      movementTotal,
      fromDate: range.fromDate,
      toDate: range.toDate,
      rows: withRunning.reverse(),
    };
  }

  const rows = new Map<string, DebtRow>();
  for (const partner of partners) {
    addDebt(rows, partner.code, partner.name, {
      partnerGroup: partner.partnerGroup || "EXTERNAL",
      skipDebtTracking: skipsDebtTracking(partner),
    });
  }

  // Phát sinh trước khoảng chọn không đứng ở cột riêng mà gộp vào Đầu kỳ, với đúng dấu nó
  // cộng vào Số dư (cùng dấu với dòng ledger). Phát sinh sau khoảng chọn bỏ hẳn.
  const carryForward = (code: string, name: string, amount: number) => {
    const current = rows.get(code);
    addDebt(rows, code, name, { openingAmount: (current?.openingAmount || 0) + amount });
  };

  for (const item of openingBalances) {
    if (!item.objectCode) continue;
    if (dateBucket(openingBalanceDate(item.period), range) === "AFTER") continue;
    carryForward(item.objectCode, item.objectName || item.objectCode, openingBalanceSigned(item.balanceType, item.amount));
  }

  for (const item of deposits) {
    const bucket = dateBucket(item.receivedDate, range);
    if (bucket === "AFTER") continue;
    if (bucket === "BEFORE") {
      carryForward(item.partnerCode, item.partnerName, depositSigned(item.remainingAmount));
      continue;
    }
    const current = rows.get(item.partnerCode);
    addDebt(rows, item.partnerCode, item.partnerName, {
      depositHolding: (current?.depositHolding || 0) + item.remainingAmount,
    });
  }

  for (const item of debtBankRows) {
    if (!item.partnerHint) continue;
    const bucket = dateBucket(item.transactionDate, range);
    if (bucket === "AFTER") continue;
    if (bucket === "BEFORE") {
      carryForward(item.partnerHint, item.partnerHint, bankSigned(item.creditAmount, item.debitAmount));
      continue;
    }
    const current = rows.get(item.partnerHint);
    addDebt(rows, item.partnerHint, item.partnerHint, {
      bankMatched: (current?.bankMatched || 0) + item.creditAmount - item.debitAmount,
    });
  }

  for (const item of vouchers) {
    if (!item.partnerCode) continue;
    const bucket = dateBucket(item.voucherDate, range);
    if (bucket === "AFTER") continue;
    const signedAmount = voucherSigned(item.voucherType, item.amount);
    if (bucket === "BEFORE") {
      carryForward(item.partnerCode, item.partnerName, signedAmount);
      continue;
    }
    const current = rows.get(item.partnerCode);
    addDebt(rows, item.partnerCode, item.partnerName, {
      voucherNet: (current?.voucherNet || 0) + signedAmount,
    });
  }

  for (const line of [...settlementLines, ...allocationLines]) {
    const bucket = dateBucket(line.date, range);
    if (bucket === "AFTER") continue;
    if (bucket === "BEFORE") {
      carryForward(line.partnerCode, line.partnerName, line.amount);
      continue;
    }
    const current = rows.get(line.partnerCode);
    addDebt(rows, line.partnerCode, line.partnerName, {
      voucherNet: (current?.voucherNet || 0) + line.amount,
    });
  }

  for (const item of purchasePayables) {
    const bucket = dateBucket(item.recognizedDate, range);
    if (bucket === "AFTER") continue;
    if (bucket === "BEFORE") {
      carryForward(item.supplierCode, item.supplierName, item.outstandingAmount);
      continue;
    }
    const current = rows.get(item.supplierCode);
    addDebt(rows, item.supplierCode, item.supplierName, {
      purchasePayable: (current?.purchasePayable || 0) + item.outstandingAmount,
    });
  }

  for (const item of debtRecords) {
    const dateSlot = dateBucket(item.documentDate, range);
    if (dateSlot === "AFTER") continue;
    const current = rows.get(item.partnerCode);
    const bucket = agingBucket(item.dueDate);
    const currentDue = current?.nearestDueDate || null;
    const nextDue = item.outstandingAmount > 0 && item.dueDate && (!currentDue || item.dueDate < currentDue) ? item.dueDate : currentDue;
    // Hoàn ứng đã cấn vào tạm ứng ngay khi lập — không phải khoản còn chờ trả.
    const hasOpenDebt = item.outstandingAmount > 0 && item.status !== "SETTLED" && !isAdvanceSettlementDebt(item.sourceType);
    // Khoản mở trước khoảng chọn vẫn tính hạn/quá hạn (vẫn đang nợ), chỉ số tiền dồn về Đầu kỳ.
    const inRange = dateSlot === "IN";
    // Cột CN phải thu / phải trả là số PHÁT SINH (còn nợ + đã gạch); phiếu gạch nợ đứng ở cột
    // Phiếu thu/chi. Hạn, quá hạn và số khoản mở vẫn tính trên số còn nợ.
    const grossAmount = item.outstandingAmount + (settledByDebt.get(item.id)?.amount || 0);
    addDebt(rows, item.partnerCode, item.partnerName, {
      partnerGroup: item.partnerGroup,
      openingAmount: (current?.openingAmount || 0) + (inRange ? 0 : debtRecordSigned(item.debtType, grossAmount)),
      debtReceivable: (current?.debtReceivable || 0) + (inRange && item.debtType === "RECEIVABLE" ? grossAmount : 0),
      debtPayable: (current?.debtPayable || 0) + (inRange && item.debtType === "PAYABLE" ? grossAmount : 0),
      nearestDueDate: nextDue,
      overdueAmount: (current?.overdueAmount || 0) + (bucket === "OVERDUE" ? item.outstandingAmount : 0),
      dueSoonAmount: (current?.dueSoonAmount || 0) + (bucket === "DUE_7" ? item.outstandingAmount : 0),
      openDebtCount: (current?.openDebtCount || 0) + (hasOpenDebt ? 1 : 0),
      debtStatus: bucket === "OVERDUE" && item.outstandingAmount > 0 ? "OVERDUE" : current?.debtStatus === "OVERDUE" ? "OVERDUE" : bucket === "DUE_7" && item.outstandingAmount > 0 ? "DUE_7" : hasOpenDebt ? "OPEN" : current?.debtStatus || "NO_DEBT",
    });
  }

  const result = Array.from(rows.values())
    .map((row) => ({
      ...row,
      balance: debtBalanceOf(row),
    }))
    .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));

  return { kind: "summary" as const, rows: result };
}

/**
 * Dự thu / dự chi theo Công nợ đối tác cho Báo cáo nguồn tiền (khách duyệt 04/10/2026).
 *
 * Lấy đúng SỐ DƯ từng đối tác của màn Công nợ tới hết kỳ báo cáo — đã trừ phiếu thu/chi, sao kê,
 * số dư đầu kỳ — chứ không cộng "còn nợ" của từng khoản: phần lớn phiếu chi NCC là phiếu chi
 * thường không gạch đúng mã khoản nợ, cộng theo khoản sẽ thổi dự chi lên gấp nhiều lần.
 * - Số dư phải trả (dương) → dự chi; phải thu (âm) → dự thu.
 * - Bỏ tiền cọc khách đang giữ: cọc thành doanh thu chứ không chi ra.
 * - Bỏ đối tác nội bộ (giữa các nhà hàng): đó là điều tiền nội bộ, không phải thu/chi.
 * - Phải thu của nhân viên (tạm ứng) không tính dự thu: thường quyết toán bằng hoàn ứng, không có tiền về.
 * Công nợ không gắn nguồn tiền nên đứng một dòng riêng mỗi nhà hàng, không đoán vào tài khoản nào.
 */
export async function debtCashProjection(branchCode: string, toExclusive: Date) {
  const [branches, partners] = await Promise.all([
    branchCode === "ALL"
      ? prisma.masterDataItem.findMany({ where: { type: "BRANCH", status: "ACTIVE" }, select: { code: true } })
      : Promise.resolve([{ code: branchCode }]),
    prisma.masterDataItem.findMany({ where: { type: "PARTNER" }, select: { code: true, partnerType: true } }),
  ]);
  const partnerTypeOf = new Map(partners.map((partner) => [partner.code, (partner.partnerType || "").toUpperCase()]));
  const result: Array<{ branchCode: string; payable: number; receivable: number; payableCount: number; receivableCount: number }> = [];
  for (const branch of branches) {
    const overview = await loadDebtOverview({ branchCode: branch.code, range: { from: null, toExclusive, fromDate: "", toDate: "" } });
    if (overview.kind !== "summary") continue;
    const projection = { branchCode: branch.code, payable: 0, receivable: 0, payableCount: 0, receivableCount: 0 };
    for (const row of overview.rows) {
      if (row.partnerGroup === "INTERNAL" || /^NB-/i.test(row.partnerCode)) continue;
      const balance = row.balance - row.depositHolding;
      if (balance > 0.5) {
        projection.payable += balance;
        projection.payableCount += 1;
      } else if (balance < -0.5 && partnerTypeOf.get(row.partnerCode) !== "EMPLOYEE") {
        projection.receivable += -balance;
        projection.receivableCount += 1;
      }
    }
    if (projection.payable > 0 || projection.receivable > 0) result.push(projection);
  }
  return result;
}
