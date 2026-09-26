import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { prisma, prismaRaw } from "@/lib/prisma";
import { assertBranchAccess, periodBounds, requestedBranch } from "@/lib/accounting";
import { buildAllocationSchedules, cleanText, isPeriodLocked, normalizePeriod, toDate, toNumber } from "@/lib/phase3";
import { writeAuditLog } from "@/lib/audit-log";
import { softDeleteRecord, SoftDeleteError } from "@/lib/soft-delete";
import { nextSeqFromCodes } from "@/lib/voucher-code-generator";
import { debtGroupCode, stripDebtLineSuffix } from "@/lib/debt-group";
import { internalPartnerCode } from "@/lib/cost-reallocation";
import { ADVANCE_RECEIVABLE_ACTION, normalizeAllocationMonths, PARTNER_COLLECTION_ACTION } from "@/lib/voucher-rules";
import { advanceReceivableBeneficiaryBranch } from "@/lib/voucher-side-effects";
import { bankSigned, debtBalanceOf, debtRecordGrossSigned, debtRecordSigned, depositSigned, openingBalanceSigned, voucherSigned } from "@/lib/debt-balance";

const debtTypes = ["RECEIVABLE", "PAYABLE"];
const partnerGroups = ["EXTERNAL", "INTERNAL"];

type DebtRow = {
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

type LedgerRow = {
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

function agingBucket(dueDate?: Date | null) {
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
type DateRange = { from: Date | null; toExclusive: Date | null; fromDate: string; toDate: string };

function parseDateRange(fromRaw: string | null, toRaw: string | null): DateRange {
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

export async function GET(request: Request) {
  try {
    const auth = requireMenuAccess(request, "/debts");
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const partnerCode = searchParams.get("partnerCode")?.trim();
    const branchCode = requestedBranch(auth.session, searchParams.get("branchCode")?.trim() || "ALL");
    const branchFilter = branchCode === "ALL" ? {} : { branchCode };
    const range = parseDateRange(searchParams.get("fromDate"), searchParams.get("toDate"));

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
    const untrackedDebtPartners = new Set(partners.filter((item) => item.skipDebtTracking).map((item) => item.code));
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
      return NextResponse.json({
        partnerCode,
        partnerName: partner?.name || partnerCode,
        balance: openingBalance + movementTotal,
        openingBalance,
        movementTotal,
        fromDate: range.fromDate,
        toDate: range.toDate,
        rows: withRunning.reverse(),
      });
    }

    const rows = new Map<string, DebtRow>();
    for (const partner of partners) {
      addDebt(rows, partner.code, partner.name, {
        partnerGroup: partner.partnerGroup || "EXTERNAL",
        skipDebtTracking: partner.skipDebtTracking,
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
      const hasOpenDebt = item.outstandingAmount > 0 && item.status !== "SETTLED";
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

    return NextResponse.json(result);
  } catch (error) {
    console.error("Error fetching debts:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

/**
 * Một dòng chi tiết của phiếu công nợ: một số tiền + một mã phân loại P&L.
 * Phải trả khai tới HẠNG MỤC chi phí (`pnlItemCode`); phải thu chỉ khai tới NHÓM hạng mục
 * (`pnlGroupCode`) vì khoản thu về không thuộc một hạng mục chi phí nào.
 */
type DebtLineInput = { pnlItemCode: string | null; pnlGroupCode: string | null; amount: number; note: string };

/**
 * Nhận `lines` (nhiều dòng) hoặc bộ `originalAmount` + `pnlItemCode` cũ (một dòng) — client cũ
 * và import vẫn gọi theo kiểu một dòng nên giữ tương thích.
 */
function parseDebtLines(body: Record<string, unknown>): DebtLineInput[] {
  if (Array.isArray(body.lines)) {
    return body.lines.map((line) => {
      const raw = (typeof line === "object" && line !== null ? line : {}) as Record<string, unknown>;
      return {
        pnlItemCode: cleanText(raw.pnlItemCode).toUpperCase() || null,
        pnlGroupCode: cleanText(raw.pnlGroupCode).toUpperCase() || null,
        amount: toNumber(raw.amount),
        note: cleanText(raw.note),
      };
    });
  }
  return [{
    pnlItemCode: cleanText(body.pnlItemCode).toUpperCase() || null,
    pnlGroupCode: cleanText(body.pnlGroupCode).toUpperCase() || null,
    amount: toNumber(body.originalAmount),
    note: "",
  }];
}

/**
 * Tạo tay công nợ ngay trên màn Công nợ — khách khai các khoản phải trả NCC đã phát sinh
 * chi phí nhưng chưa thanh toán, kèm hạng mục P&L để biết chi phí thuộc đâu. Khoản PHẢI THU
 * khai tới nhóm hạng mục P&L thay vì hạng mục (khoản thu về không thuộc hạng mục chi phí nào).
 * Cũng dùng cho công nợ nội bộ (nhà hàng B phải trả nhà hàng A khoản chi hộ).
 *
 * Một phiếu có thể nhiều dòng (trích trước cuối tháng: cùng NCC, nhiều hạng mục P&L). Mỗi dòng
 * là một DebtRecord riêng để sổ nợ gạch và báo cáo P&L tách đúng hạng mục; các dòng dùng chung
 * mã phiếu cha `CNPT-YYYYMM-0007` và mang mã `CNPT-YYYYMM-0007/1`, `/2`... Phiếu một dòng giữ
 * mã phẳng như trước.
 */
export async function POST(request: Request) {
  try {
    const auth = requireMenuAction(request, "/debts", "create");
    if (!auth.ok) return auth.response;
    const body = await request.json();

    const debtType = cleanText(body.debtType).toUpperCase() || "PAYABLE";
    const partnerGroup = cleanText(body.partnerGroup).toUpperCase() || "EXTERNAL";
    const partnerCode = cleanText(body.partnerCode).toUpperCase();
    const branchCode = cleanText(body.branchCode).toUpperCase();
    const description = cleanText(body.description);
    const documentDate = toDate(body.documentDate, new Date());
    const dueDate = cleanText(body.dueDate) ? toDate(body.dueDate) : null;
    const categoryCode = cleanText(body.categoryCode).toUpperCase() || null;
    const lines = parseDebtLines(body);
    // Phân bổ theo kỳ: khoản phải trả là chi phí dùng cho nhiều kỳ (thuê mặt bằng trả sau cả
    // năm, bảo trì theo hợp đồng...). Chi phí không vào P&L một lần ở ngày chứng từ mà chia đều
    // theo lịch PB-<mã công nợ>, cùng cơ chế với phiếu chi trả trước.
    const allocationMonths = debtType === "PAYABLE" ? normalizeAllocationMonths(body.allocationMonths) : 0;
    const allocationStartPeriod = allocationMonths > 0 ? normalizePeriod(body.allocationStartPeriod) : "";

    if (!debtTypes.includes(debtType)) return NextResponse.json({ error: "Loại công nợ chỉ nhận RECEIVABLE hoặc PAYABLE" }, { status: 400 });
    if (!partnerGroups.includes(partnerGroup)) return NextResponse.json({ error: "Nhóm đối tác chỉ nhận EXTERNAL hoặc INTERNAL" }, { status: 400 });
    if (!partnerCode || !branchCode || !description) {
      return NextResponse.json({ error: "Thiếu đối tác, cửa hàng hoặc diễn giải" }, { status: 400 });
    }
    if (lines.length === 0) return NextResponse.json({ error: "Phiếu công nợ cần ít nhất một dòng hạng mục" }, { status: 400 });
    if (lines.length > 50) return NextResponse.json({ error: "Một phiếu công nợ tối đa 50 dòng" }, { status: 400 });
    const badLine = lines.findIndex((line) => !(line.amount > 0));
    if (badLine >= 0) {
      return NextResponse.json({ error: lines.length === 1 ? "Số tiền công nợ phải lớn hơn 0" : `Dòng ${badLine + 1}: số tiền phải lớn hơn 0` }, { status: 400 });
    }
    if (dueDate && dueDate < documentDate) return NextResponse.json({ error: "Hạn thanh toán không được trước ngày chứng từ" }, { status: 400 });
    if (allocationMonths > 0 && !allocationStartPeriod) {
      return NextResponse.json({ error: "Công nợ phân bổ theo kỳ phải khai kỳ bắt đầu phân bổ (YYYY-MM)" }, { status: 400 });
    }
    if (allocationMonths > 120) return NextResponse.json({ error: "Số kỳ phân bổ tối đa 120" }, { status: 400 });

    try {
      assertBranchAccess(auth.session, branchCode);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Không có quyền chi nhánh" }, { status: 403 });
    }
    if (await isPeriodLocked(documentDate, branchCode)) {
      return NextResponse.json({ error: "Kỳ kế toán đã khóa, không thể ghi công nợ vào kỳ này" }, { status: 400 });
    }

    const partner = await prisma.masterDataItem.findFirst({
      where: { type: "PARTNER", code: partnerCode, status: "ACTIVE", deletedAt: null },
      select: { code: true, name: true },
    });
    if (!partner) return NextResponse.json({ error: `Đối tác [${partnerCode}] không tồn tại hoặc đã ngừng hoạt động` }, { status: 400 });
    // Phải thu chỉ khai tới nhóm hạng mục, phải trả chỉ khai tới hạng mục: bỏ mã của tầng
    // không dùng để đổi loại công nợ trên popup không để lại mã cũ của tầng kia.
    const isReceivable = debtType === "RECEIVABLE";
    const classifiedLines = lines.map((line) => ({
      ...line,
      pnlItemCode: isReceivable ? null : line.pnlItemCode,
      pnlGroupCode: isReceivable ? line.pnlGroupCode : null,
    }));
    const pnlCodes = Array.from(new Set(
      classifiedLines
        .map((line) => (isReceivable ? line.pnlGroupCode : line.pnlItemCode))
        .filter((code): code is string => Boolean(code)),
    ));
    if (pnlCodes.length > 0) {
      const pnlType = isReceivable ? "PNL_GROUP" : "PNL_ITEM";
      const pnlLabel = isReceivable ? "Nhóm hạng mục P&L" : "Hạng mục P&L";
      const pnlRecords = await prisma.masterDataItem.findMany({
        where: { type: pnlType, code: { in: pnlCodes }, status: "ACTIVE", deletedAt: null },
        select: { code: true, group: true },
      });
      const known = new Set(pnlRecords.map((item) => item.code));
      const missing = pnlCodes.find((code) => !known.has(code));
      if (missing) return NextResponse.json({ error: `${pnlLabel} [${missing}] không tồn tại hoặc đã ngừng hoạt động` }, { status: 400 });
      // Tiền mua tài sản đi đường khấu hao ở màn Tài sản, không phân bổ qua 242.
      const capex = allocationMonths > 0 && pnlRecords.find((item) => (item.group || "").toUpperCase() === "CAPEX");
      if (capex) return NextResponse.json({ error: `Hạng mục [${capex.code}] thuộc CAPEX — tài sản khấu hao ở màn Tài sản, không phân bổ trên công nợ.` }, { status: 400 });
    }

    // Mã tuần tự theo loại + tháng chứng từ, lấy MAX + 1 chứ không COUNT: công nợ bị xoá cứng
    // ở vài luồng (xoá phiếu phân bổ, rollback import) nên COUNT tụt và cấp trúng mã đang sống.
    // Vẫn giữ retry cho trường hợp hai người tạo cùng lúc lấy trúng một số. Phiếu nhiều dòng
    // cấp MỘT số phiếu rồi gắn "/1", "/2"... và ghi cả cụm trong một transaction.
    const prefix = `${debtType === "PAYABLE" ? "CNPT" : "CNTHU"}-${documentDate.toISOString().slice(0, 7).replace("-", "")}-`;
    const multiLine = lines.length > 1;
    let created: Awaited<ReturnType<typeof prisma.debtRecord.create>>[] | null = null;
    let groupCode = "";
    for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
      // `deletedAt: undefined` tắt bộ lọc "còn sống" của client (lib/prisma.ts) để MAX tính cả mã
      // đang nằm trong Thùng rác: mã unique vẫn bị chiếm, cấp lại sẽ đâm P2002 và phục hồi từ
      // Thùng rác cũng không được.
      const issuedCodes = await prisma.debtRecord.findMany({
        where: { code: { startsWith: prefix }, deletedAt: undefined },
        select: { code: true },
      });
      const issued = issuedCodes.map((row) => stripDebtLineSuffix(row.code));
      groupCode = prefix + String(nextSeqFromCodes(issued, prefix) + attempt).padStart(4, "0");
      try {
        created = await prisma.$transaction(async (tx) => {
          const records = [];
          for (const [index, line] of classifiedLines.entries()) {
            const record = await tx.debtRecord.create({
              data: {
                code: multiLine ? `${groupCode}/${index + 1}` : groupCode,
                debtType,
                partnerGroup,
                partnerCode: partner.code,
                partnerName: partner.name,
                branchCode,
                documentDate,
                dueDate,
                categoryCode,
                pnlItemCode: line.pnlItemCode,
                pnlGroupCode: line.pnlGroupCode,
                originalAmount: line.amount,
                outstandingAmount: line.amount,
                // Diễn giải dòng = diễn giải chung + hạng mục/ghi chú riêng để nhìn trên sổ nợ
                // và trên phiếu chi vẫn biết dòng này là khoản gì.
                description: multiLine ? [description, [line.pnlItemCode || line.pnlGroupCode, line.note].filter(Boolean).join(" ")].filter(Boolean).join(" · ") : description,
                sourceType: "MANUAL",
                allocationMonths: allocationMonths || null,
                allocationStartPeriod: allocationStartPeriod || null,
                // Khai tay = chi phí phát sinh trong kỳ, ghi sổ ngay (số dư đầu kỳ đi đường
                // import và mặc định không ghi chi phí — xem lib/accounting.ts). Khoản có lịch
                // phân bổ thì chi phí đi theo lịch; bật cờ nữa là tính chi phí hai lần.
                recognizeExpense: debtType === "PAYABLE" && allocationMonths === 0,
                status: "OPEN",
              },
            });
            records.push(record);
            if (allocationMonths > 0) {
              // Mỗi dòng hạng mục một lịch riêng để từng kỳ phân bổ đứng đúng dòng P&L.
              await tx.accrual.create({
                data: {
                  code: `PB-${record.code}`,
                  name: record.description,
                  branchCode,
                  categoryCode: categoryCode || "OPEX",
                  pnlItemCode: record.pnlItemCode,
                  totalAmount: record.originalAmount,
                  actualAmount: record.originalAmount,
                  startPeriod: allocationStartPeriod,
                  numberOfPeriods: allocationMonths,
                  note: `Tạo từ công nợ ${record.code}`,
                  // Vế Có của bút toán phân bổ hàng kỳ là 242: lúc ghi sổ công nợ đã treo
                  // Nợ 242 / Có 331 (lib/accounting.ts), mỗi kỳ rút dần 242 vào chi phí.
                  sourceType: "DEBT",
                  sourceId: record.id,
                  createdBy: auth.session.name,
                  schedules: { create: buildAllocationSchedules(allocationStartPeriod, record.originalAmount, allocationMonths) },
                },
              });
            }
          }
          return records;
        });
      } catch (error) {
        const isUnique = typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
        if (!isUnique) throw error;
      }
    }
    if (!created) return NextResponse.json({ error: "Không cấp được mã công nợ, vui lòng thử lại" }, { status: 409 });

    const totalAmount = lines.reduce((sum, line) => sum + line.amount, 0);
    for (const record of created) {
      await writeAuditLog({
        session: auth.session,
        module: "DEBTS",
        action: "CREATE",
        entityType: "DebtRecord",
        entityId: record.id,
        entityCode: record.code,
        branchCode,
        metadata: {
          debtType,
          partnerCode: partner.code,
          originalAmount: record.originalAmount,
          pnlItemCode: record.pnlItemCode,
          pnlGroupCode: record.pnlGroupCode,
          ...(multiLine ? { groupCode, lineCount: created.length, groupTotal: totalAmount } : {}),
        },
      });
    }
    // Client cũ đọc `code` của bản ghi trả về; phiếu nhiều dòng trả mã phiếu cha kèm các dòng.
    return NextResponse.json({ ...created[0], code: groupCode, lineCount: created.length, totalAmount, lines: created }, { status: 201 });
  } catch (error) {
    console.error("Error creating debt record:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const action = cleanText(body.action) || "UPDATE";
    const auth = requireMenuAction(request, "/debts", "edit");
    if (!auth.ok) return auth.response;

    const id = cleanText(body.id);
    if (!id) return NextResponse.json({ error: "Thiếu ID công nợ" }, { status: 400 });
    if (action !== "UPDATE") {
      return NextResponse.json({ error: "Thao tác không hỗ trợ" }, { status: 400 });
    }

    const current = await prisma.debtRecord.findUnique({ where: { id } });
    if (!current) return NextResponse.json({ error: "Không tìm thấy khoản công nợ" }, { status: 404 });

    try {
      assertBranchAccess(auth.session, current.branchCode);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Không có quyền chi nhánh" }, { status: 403 });
    }

    // Công nợ do phiếu phân bổ chi phí sinh ra đi kèm bút toán P&L ở hai nhà hàng. Sửa riêng
    // khoản này sẽ làm công nợ lệch bút toán — phải sửa/xoá chính phiếu phân bổ.
    if (current.sourceType === "COST_REALLOCATION") {
      return NextResponse.json(
        { error: "Công nợ nội bộ này do phiếu phân bổ chi phí sinh ra. Hãy xoá phiếu ở màn Phân bổ chi phí để hoàn tác đồng bộ cả bút toán." },
        { status: 400 },
      );
    }
    // Tương tự với phiếu điều tiền liên nhà hàng: công nợ nội bộ là mặt sau của chính phiếu.
    if (current.sourceType === "MONEY_TRANSFER") {
      return NextResponse.json(
        { error: "Công nợ nội bộ này do phiếu điều tiền liên nhà hàng sinh ra. Hãy xử lý ở màn Vận hành tài chính để bút toán và công nợ đi cùng nhau." },
        { status: 400 },
      );
    }

    // Đã thanh toán một phần hay tất toán thì số liệu do phiếu thu/chi quyết định.
    const settlementCount = await prisma.debtSettlement.count({ where: { debtId: id } });
    if (settlementCount > 0 || current.outstandingAmount !== current.originalAmount) {
      return NextResponse.json(
        { error: "Khoản công nợ đã có phát sinh thanh toán, không thể sửa. Hãy điều chỉnh bằng phiếu thu/chi." },
        { status: 400 },
      );
    }
    if (current.status !== "OPEN") {
      return NextResponse.json({ error: "Khoản công nợ đã tất toán/đóng, không thể sửa" }, { status: 400 });
    }

    const debtType = body.debtType === undefined ? current.debtType : cleanText(body.debtType);
    const partnerGroup = body.partnerGroup === undefined ? current.partnerGroup : cleanText(body.partnerGroup);
    const partnerCode = body.partnerCode === undefined ? current.partnerCode : cleanText(body.partnerCode);
    const partnerName = body.partnerName === undefined ? current.partnerName : cleanText(body.partnerName);
    const branchCode = body.branchCode === undefined ? current.branchCode : cleanText(body.branchCode);
    const description = body.description === undefined ? current.description : cleanText(body.description);
    const categoryCode = body.categoryCode === undefined ? current.categoryCode : cleanText(body.categoryCode) || null;
    // Hai tầng phân loại đi theo loại công nợ: phải trả khai HẠNG MỤC chi phí, phải thu khai
    // NHÓM hạng mục. Chuẩn hoá ngay ở đây để đổi loại công nợ không để sót mã của tầng cũ.
    const isReceivableDebt = debtType === "RECEIVABLE";
    const rawPnlItemCode = body.pnlItemCode === undefined ? current.pnlItemCode : cleanText(body.pnlItemCode).toUpperCase() || null;
    const rawPnlGroupCode = body.pnlGroupCode === undefined ? current.pnlGroupCode : cleanText(body.pnlGroupCode).toUpperCase() || null;
    const pnlItemCode = isReceivableDebt ? null : rawPnlItemCode;
    const pnlGroupCode = isReceivableDebt ? rawPnlGroupCode : null;
    const originalAmount = body.originalAmount === undefined ? current.originalAmount : toNumber(body.originalAmount);
    const documentDate = body.documentDate === undefined ? current.documentDate : toDate(body.documentDate, current.documentDate);
    const dueDate = body.dueDate === undefined ? current.dueDate : body.dueDate ? toDate(body.dueDate, current.documentDate) : null;

    if (!debtTypes.includes(debtType)) {
      return NextResponse.json({ error: "Loại công nợ không hợp lệ" }, { status: 400 });
    }
    if (!partnerGroups.includes(partnerGroup)) {
      return NextResponse.json({ error: "Nhóm đối tượng công nợ không hợp lệ" }, { status: 400 });
    }
    if (!partnerCode || !partnerName || !branchCode || !description || originalAmount <= 0) {
      return NextResponse.json({ error: "Thiếu đối tác, chi nhánh, diễn giải hoặc số tiền không hợp lệ" }, { status: 400 });
    }
    if (dueDate && dueDate < documentDate) {
      return NextResponse.json({ error: "Hạn thanh toán không được trước ngày chứng từ" }, { status: 400 });
    }
    // Cùng luật với lúc tạo phiếu: không cho sửa sang một mã đã ngừng hoạt động, vì hạng mục
    // Ngừng không lên bảng P&L nữa và khoản công nợ sẽ rơi khỏi báo cáo mà không ai biết.
    const pnlCode = isReceivableDebt ? pnlGroupCode : pnlItemCode;
    if (pnlCode && pnlCode !== (isReceivableDebt ? current.pnlGroupCode : current.pnlItemCode)) {
      const pnlLabel = isReceivableDebt ? "Nhóm hạng mục P&L" : "Hạng mục P&L";
      const pnlRecord = await prisma.masterDataItem.findFirst({
        where: { type: isReceivableDebt ? "PNL_GROUP" : "PNL_ITEM", code: pnlCode, status: "ACTIVE", deletedAt: null },
        select: { code: true },
      });
      if (!pnlRecord) return NextResponse.json({ error: `${pnlLabel} [${pnlCode}] không tồn tại hoặc đã ngừng hoạt động` }, { status: 400 });
    }

    try {
      assertBranchAccess(auth.session, branchCode);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Không có quyền chi nhánh" }, { status: 403 });
    }

    const [currentPeriodLocked, nextPeriodLocked] = await Promise.all([
      isPeriodLocked(current.documentDate, current.branchCode),
      isPeriodLocked(documentDate, branchCode),
    ]);
    if (currentPeriodLocked || nextPeriodLocked) {
      return NextResponse.json({ error: "Kỳ kế toán đã khóa, không thể sửa công nợ" }, { status: 400 });
    }

    // Khoản có lịch phân bổ: lịch đi theo số tiền, cửa hàng và hạng mục của khoản nợ. Chưa
    // ghi nhận kỳ nào thì dựng lại lịch; đã ghi nhận thì chỉ cho sửa những trường không đụng
    // tới số phân bổ.
    // Khoản import có lịch riêng sinh lúc nhập file (không mang sourceType DEBT) — không đụng.
    const isPayable = debtType === "PAYABLE";
    const manageAllocation = current.sourceType === "MANUAL";
    const allocationMonths = !manageAllocation ? current.allocationMonths || 0 : !isPayable ? 0 : body.allocationMonths === undefined
      ? (current.allocationMonths || 0) > 1 ? current.allocationMonths || 0 : 0
      : normalizeAllocationMonths(body.allocationMonths);
    const allocationStartPeriod = !manageAllocation ? current.allocationStartPeriod || "" : allocationMonths > 0
      ? normalizePeriod(body.allocationStartPeriod === undefined ? current.allocationStartPeriod : body.allocationStartPeriod)
      : "";
    if (manageAllocation && allocationMonths > 0 && !allocationStartPeriod) {
      return NextResponse.json({ error: "Công nợ phân bổ theo kỳ phải khai kỳ bắt đầu phân bổ (YYYY-MM)" }, { status: 400 });
    }
    if (manageAllocation && allocationMonths > 120) return NextResponse.json({ error: "Số kỳ phân bổ tối đa 120" }, { status: 400 });
    if (manageAllocation && allocationMonths > 0 && pnlItemCode) {
      const item = await prisma.masterDataItem.findFirst({ where: { type: "PNL_ITEM", code: pnlItemCode }, select: { group: true } });
      if ((item?.group || "").toUpperCase() === "CAPEX") {
        return NextResponse.json({ error: `Hạng mục [${pnlItemCode}] thuộc CAPEX — tài sản khấu hao ở màn Tài sản, không phân bổ trên công nợ.` }, { status: 400 });
      }
    }
    const existingAccrual = manageAllocation ? await findDebtAccrual(current) : null;
    const allocationChanged = manageAllocation && Boolean(existingAccrual) !== (allocationMonths > 0) || (existingAccrual && (
      existingAccrual.numberOfPeriods !== allocationMonths
      || existingAccrual.startPeriod !== allocationStartPeriod
      || existingAccrual.totalAmount !== originalAmount
      || existingAccrual.branchCode !== branchCode
      || (existingAccrual.pnlItemCode || null) !== (pnlItemCode || null)
      || (existingAccrual.categoryCode || null) !== (categoryCode || "OPEX")
    ));
    const postedPeriods = existingAccrual?.schedules.filter((row) => row.status !== "PLANNED").length || 0;
    if (allocationChanged && postedPeriods > 0) {
      return NextResponse.json(
        { error: `Lịch phân bổ ${existingAccrual?.code} đã ghi nhận ${postedPeriods} kỳ, không đổi được số tiền, cửa hàng, hạng mục hay số kỳ. Hãy bỏ ghi nhận các kỳ đó ở tab Trích trước & Phân bổ trước.` },
        { status: 400 },
      );
    }

    const debt = await prisma.$transaction(async (tx) => {
      const updated = await tx.debtRecord.update({
        where: { id },
        data: {
          debtType,
          partnerGroup,
          partnerCode,
          partnerName,
          branchCode,
          documentDate,
          dueDate,
          categoryCode,
          pnlItemCode,
          pnlGroupCode,
          originalAmount,
          // Chưa phát sinh thanh toán nên dư nợ luôn bằng số tiền gốc.
          outstandingAmount: originalAmount,
          description,
          allocationMonths: allocationMonths || null,
          allocationStartPeriod: allocationStartPeriod || null,
          // Khai tay: ghi chi phí ngay, trừ khi đi theo lịch phân bổ. Khoản import giữ cờ cũ.
          ...(manageAllocation ? { recognizeExpense: isPayable && allocationMonths === 0 } : {}),
        },
      });
      if (allocationChanged) {
        // Lịch chưa ghi nhận kỳ nào (đã chặn ở trên): bỏ các kỳ cũ rồi dựng lại. `delete` trên
        // client này là xoá mềm và mã PB- vẫn bị giữ, nên dựng lại bằng upsert theo mã — upsert
        // cũng tự khôi phục lịch đã xoá mềm khi bật phân bổ lại.
        const code = `PB-${updated.code}`;
        const stale = await tx.accrual.findFirst({ where: { code, deletedAt: undefined }, select: { id: true } });
        if (stale) await tx.accrualSchedule.deleteMany({ where: { accrualId: stale.id } });
        if (allocationMonths > 0) {
          const fields = {
            name: updated.description,
            branchCode: updated.branchCode,
            categoryCode: updated.categoryCode || "OPEX",
            pnlItemCode: updated.pnlItemCode,
            totalAmount: updated.originalAmount,
            actualAmount: updated.originalAmount,
            startPeriod: allocationStartPeriod,
            numberOfPeriods: allocationMonths,
            status: "ACTIVE",
            sourceType: "DEBT",
            sourceId: updated.id,
          };
          const accrual = await tx.accrual.upsert({
            where: { code },
            create: { code, ...fields, note: `Tạo từ công nợ ${updated.code}`, createdBy: auth.session.name },
            update: fields,
          });
          await tx.accrualSchedule.createMany({
            data: buildAllocationSchedules(allocationStartPeriod, updated.originalAmount, allocationMonths).map((row) => ({ ...row, accrualId: accrual.id })),
          });
        } else if (stale) {
          await tx.accrual.delete({ where: { id: stale.id } });
        }
      } else if (existingAccrual && existingAccrual.name !== updated.description) {
        await tx.accrual.update({ where: { id: existingAccrual.id }, data: { name: updated.description } });
      }
      return updated;
    });

    // Đổi loại công nợ hoặc nhóm P&L của khoản phải thu thì bút toán thu nhập khác cũ (131/711)
    // có thể không còn đúng — gỡ đi, lần Đồng bộ ghi sổ kế tiếp ghi lại theo phân loại mới.
    // Xoá CỨNG (prismaRaw): bút toán xoá mềm vẫn giữ khoá unique sourceType + sourceId, lần ghi
    // sổ sau không thấy nó (bị lọc) nên tạo mới và vỡ ràng buộc.
    if (current.debtType !== debtType || (current.pnlGroupCode || null) !== (pnlGroupCode || null)) {
      await prismaRaw.journalEntry.deleteMany({ where: { sourceType: "DEBT_RECEIVABLE", sourceId: debt.id } });
    }

    await writeAuditLog({
      session: auth.session,
      module: "DEBTS",
      action: "UPDATE",
      entityType: "DebtRecord",
      entityId: debt.id,
      entityCode: debt.code,
      branchCode: debt.branchCode,
      metadata: {
        before: { debtType: current.debtType, partnerGroup: current.partnerGroup, partnerCode: current.partnerCode, partnerName: current.partnerName, branchCode: current.branchCode, documentDate: current.documentDate, dueDate: current.dueDate, categoryCode: current.categoryCode, pnlItemCode: current.pnlItemCode, pnlGroupCode: current.pnlGroupCode, originalAmount: current.originalAmount, description: current.description },
        after: { debtType, partnerGroup, partnerCode, partnerName, branchCode, documentDate, dueDate, categoryCode, pnlItemCode, pnlGroupCode, originalAmount, description, allocationMonths: allocationMonths || null, allocationStartPeriod: allocationStartPeriod || null },
      },
    });

    return NextResponse.json(debt);
  } catch (error) {
    console.error("Error updating debt record:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

/** Lịch phân bổ PB-<mã công nợ> sinh kèm khoản phải trả khai tay có phân bổ theo kỳ. */
async function findDebtAccrual(debt: { id: string; code: string }) {
  return prisma.accrual.findFirst({
    where: { code: `PB-${debt.code}`, sourceType: "DEBT", sourceId: debt.id },
    include: { schedules: { select: { status: true } } },
  });
}

/** Lý do không xoá được một khoản công nợ tại màn Công nợ, hoặc null nếu xoá được. */
async function debtDeleteBlocker(current: { id: string; code: string; sourceType: string; status: string; originalAmount: number; outstandingAmount: number; documentDate: Date; branchCode: string }) {
  // Xoá riêng công nợ của phiếu phân bổ sẽ để lại bút toán P&L mồ côi ở hai nhà hàng.
  if (current.sourceType === "COST_REALLOCATION") {
    return "Công nợ nội bộ này do phiếu phân bổ chi phí sinh ra. Hãy xoá phiếu ở màn Phân bổ chi phí để hoàn tác đồng bộ cả bút toán.";
  }
  if (current.sourceType === "MONEY_TRANSFER") {
    return "Công nợ nội bộ này do phiếu điều tiền liên nhà hàng sinh ra. Hãy xử lý ở màn Vận hành tài chính để bút toán và công nợ đi cùng nhau.";
  }
  // Xoá riêng khoản nợ thì bút toán Nợ 211/242 – Có 331 của tài sản vẫn nằm trên sổ.
  if (current.sourceType === "ASSET") {
    return "Công nợ này do tài sản/CCDC sinh ra. Hãy xoá tài sản ở màn Tài sản, hoặc sửa tài sản sang \"Đã thanh toán\", để công nợ và bút toán đi cùng nhau.";
  }
  // Còn phiếu thu/chi đã đối trừ vào khoản này thì phải giữ lại để không mất dấu thanh toán.
  const settlementCount = await prisma.debtSettlement.count({ where: { debtId: current.id } });
  if (settlementCount > 0) return "Khoản công nợ đã được thanh toán bằng phiếu thu/chi, không thể xóa.";
  if (current.outstandingAmount !== current.originalAmount || current.status !== "OPEN") {
    return "Khoản công nợ đã phát sinh thanh toán hoặc đã tất toán, không thể xóa.";
  }
  if (await isPeriodLocked(current.documentDate, current.branchCode)) return "Kỳ kế toán đã khóa, không thể xóa công nợ";
  const accrual = await findDebtAccrual(current);
  const posted = accrual?.schedules.filter((row) => row.status !== "PLANNED").length || 0;
  if (posted > 0) return `Lịch phân bổ ${accrual?.code} đã ghi nhận ${posted} kỳ. Hãy bỏ ghi nhận các kỳ đó ở tab Trích trước & Phân bổ trước khi xoá công nợ.`;
  return null;
}

export async function DELETE(request: Request) {
  try {
    const auth = requireMenuAction(request, "/debts", "delete");
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const id = cleanText(searchParams.get("id"));
    const groupCode = cleanText(searchParams.get("groupCode")).toUpperCase();
    const reason = cleanText(searchParams.get("reason")) || null;
    if (!id && !groupCode) return NextResponse.json({ error: "Thiếu ID công nợ" }, { status: 400 });

    // Xoá cả phiếu nhiều hạng mục = xoá mọi dòng `<mã phiếu>/n`; một dòng vướng thì không xoá dòng nào.
    const targets = id
      ? [await prisma.debtRecord.findUnique({ where: { id } })].filter((row): row is NonNullable<typeof row> => Boolean(row))
      : await prisma.debtRecord.findMany({ where: { code: { startsWith: `${groupCode}/` } }, orderBy: { code: "asc" } });
    if (targets.length === 0) return NextResponse.json({ error: id ? "Không tìm thấy khoản công nợ" : `Không tìm thấy dòng nào của phiếu ${groupCode}` }, { status: 404 });

    for (const current of targets) {
      try {
        assertBranchAccess(auth.session, current.branchCode);
      } catch (e) {
        return NextResponse.json({ error: e instanceof Error ? e.message : "Không có quyền chi nhánh" }, { status: 403 });
      }
      const blocker = await debtDeleteBlocker(current);
      if (blocker) return NextResponse.json({ error: targets.length > 1 ? `${current.code}: ${blocker}` : blocker }, { status: 400 });
    }

    for (const current of targets) {
      await softDeleteRecord({ model: "DebtRecord", id: current.id, session: auth.session, reason });
      // Khoản phải trả khai tay đã ghi nhận chi phí (Nợ hạng mục / Có 331) khi đồng bộ ghi sổ.
      // Xoá khoản nợ mà để bút toán lại thì chi phí vẫn nằm trên P&L, không cách nào gỡ.
      // Phải thu nhóm Thu nhập khác cũng đã ghi Nợ 131 / Có 711 — gỡ theo, nếu không thu nhập
      // còn nằm trên P&L sau khi khoản nợ đã xoá.
      await prisma.journalEntry.deleteMany({ where: { sourceType: { in: ["DEBT_PAYABLE", "DEBT_RECEIVABLE"] }, sourceId: current.id } });
      // Lịch phân bổ PB-<mã> (chưa ghi nhận kỳ nào — đã chặn ở trên) xoá mềm theo khoản nợ qua
      // cascade của Thùng rác (lib/soft-delete.ts), khôi phục cũng đi cùng nhau.
    }
    return NextResponse.json({ ok: true, deleted: targets.map((row) => row.code) });
  } catch (error) {
    if (error instanceof SoftDeleteError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Error deleting debt record:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
