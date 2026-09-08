import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { assertBranchAccess, periodBounds, requestedBranch } from "@/lib/accounting";
import { cleanText, isPeriodLocked, toDate, toNumber } from "@/lib/phase3";
import { writeAuditLog } from "@/lib/audit-log";
import { softDeleteRecord, SoftDeleteError } from "@/lib/soft-delete";
import { nextSeqFromCodes } from "@/lib/voucher-code-generator";
import { debtGroupCode, stripDebtLineSuffix } from "@/lib/debt-group";
import { bankSigned, debtBalanceOf, debtRecordSigned, depositSigned, openingBalanceSigned, voucherSigned } from "@/lib/debt-balance";

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
};

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

    const [partners, openingBalances, deposits, bankRows, vouchers, purchasePayables, debtRecords] = await Promise.all([
      prisma.masterDataItem.findMany({ where: { type: "PARTNER" } }),
      prisma.openingBalance.findMany({ where: { balanceType: { in: ["AR", "AP"] }, ...branchFilter } }),
      prisma.deposit.findMany({ where: branchFilter }),
      prisma.bankStatementTransaction.findMany({ where: { partnerHint: { not: null }, ...(branchCode === "ALL" ? {} : { branchCode }) } }),
      prisma.financialVoucher.findMany({ where: { partnerCode: { not: null }, status: "APPROVED", debtAction: null, ...branchFilter } }),
      prisma.supplierPayable.findMany({ where: branchCode === "ALL" ? {} : { purchaseOrder: { branchCode } }, include: { purchaseOrder: true } }),
      prisma.debtRecord.findMany({ where: branchFilter }),
    ]);

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
      for (const item of bankRows.filter((row) => row.partnerHint === partnerCode)) {
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
          description: item.description,
          amount: voucherSigned(item.voucherType, item.amount),
        });
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
      for (const item of debtRecords.filter((row) => row.partnerCode === partnerCode && row.outstandingAmount > 0)) {
        ledger.push({
          id: item.id,
          groupCode: debtGroupCode(item.code),
          date: item.documentDate,
          source: item.debtType,
          code: item.code,
          dueDate: item.dueDate,
          description: `${item.description}${item.dueDate ? ` · Hạn ${item.dueDate.toLocaleDateString("vi-VN")}` : ""}`,
          amount: debtRecordSigned(item.debtType, item.outstandingAmount),
          status: item.status,
          agingBucket: agingBucket(item.dueDate),
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
    for (const partner of partners) addDebt(rows, partner.code, partner.name, { partnerGroup: partner.partnerGroup || "EXTERNAL" });

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

    for (const item of bankRows) {
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
      addDebt(rows, item.partnerCode, item.partnerName, {
        partnerGroup: item.partnerGroup,
        openingAmount: (current?.openingAmount || 0) + (inRange ? 0 : debtRecordSigned(item.debtType, item.outstandingAmount)),
        debtReceivable: (current?.debtReceivable || 0) + (inRange && item.debtType === "RECEIVABLE" ? item.outstandingAmount : 0),
        debtPayable: (current?.debtPayable || 0) + (inRange && item.debtType === "PAYABLE" ? item.outstandingAmount : 0),
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

/** Một dòng chi tiết của phiếu công nợ: một hạng mục P&L, một số tiền. */
type DebtLineInput = { pnlItemCode: string | null; amount: number; note: string };

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
        amount: toNumber(raw.amount),
        note: cleanText(raw.note),
      };
    });
  }
  return [{ pnlItemCode: cleanText(body.pnlItemCode).toUpperCase() || null, amount: toNumber(body.originalAmount), note: "" }];
}

/**
 * Tạo tay công nợ ngay trên màn Công nợ — khách khai các khoản phải trả NCC đã phát sinh
 * chi phí nhưng chưa thanh toán, kèm hạng mục P&L để biết chi phí thuộc đâu. Cũng dùng cho
 * công nợ nội bộ (nhà hàng B phải trả nhà hàng A khoản chi hộ).
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
    const pnlItemCodes = Array.from(new Set(lines.map((line) => line.pnlItemCode).filter((code): code is string => Boolean(code))));
    if (pnlItemCodes.length > 0) {
      const pnlItems = await prisma.masterDataItem.findMany({
        where: { type: "PNL_ITEM", code: { in: pnlItemCodes }, status: "ACTIVE", deletedAt: null },
        select: { code: true },
      });
      const known = new Set(pnlItems.map((item) => item.code));
      const missing = pnlItemCodes.find((code) => !known.has(code));
      if (missing) return NextResponse.json({ error: `Hạng mục P&L [${missing}] không tồn tại hoặc đã ngừng hoạt động` }, { status: 400 });
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
        created = await prisma.$transaction(
          lines.map((line, index) =>
            prisma.debtRecord.create({
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
                originalAmount: line.amount,
                outstandingAmount: line.amount,
                // Diễn giải dòng = diễn giải chung + hạng mục/ghi chú riêng để nhìn trên sổ nợ
                // và trên phiếu chi vẫn biết dòng này là khoản gì.
                description: multiLine ? [description, [line.pnlItemCode, line.note].filter(Boolean).join(" ")].filter(Boolean).join(" · ") : description,
                sourceType: "MANUAL",
                status: "OPEN",
              },
            }),
          ),
        );
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

    const debt = await prisma.debtRecord.update({
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
        originalAmount,
        // Chưa phát sinh thanh toán nên dư nợ luôn bằng số tiền gốc.
        outstandingAmount: originalAmount,
        description,
      },
    });

    await writeAuditLog({
      session: auth.session,
      module: "DEBTS",
      action: "UPDATE",
      entityType: "DebtRecord",
      entityId: debt.id,
      entityCode: debt.code,
      branchCode: debt.branchCode,
      metadata: {
        before: { debtType: current.debtType, partnerGroup: current.partnerGroup, partnerCode: current.partnerCode, partnerName: current.partnerName, branchCode: current.branchCode, documentDate: current.documentDate, dueDate: current.dueDate, categoryCode: current.categoryCode, originalAmount: current.originalAmount, description: current.description },
        after: { debtType, partnerGroup, partnerCode, partnerName, branchCode, documentDate, dueDate, categoryCode, originalAmount, description },
      },
    });

    return NextResponse.json(debt);
  } catch (error) {
    console.error("Error updating debt record:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

/** Lý do không xoá được một khoản công nợ tại màn Công nợ, hoặc null nếu xoá được. */
async function debtDeleteBlocker(current: { id: string; sourceType: string; status: string; originalAmount: number; outstandingAmount: number; documentDate: Date; branchCode: string }) {
  // Xoá riêng công nợ của phiếu phân bổ sẽ để lại bút toán P&L mồ côi ở hai nhà hàng.
  if (current.sourceType === "COST_REALLOCATION") {
    return "Công nợ nội bộ này do phiếu phân bổ chi phí sinh ra. Hãy xoá phiếu ở màn Phân bổ chi phí để hoàn tác đồng bộ cả bút toán.";
  }
  if (current.sourceType === "MONEY_TRANSFER") {
    return "Công nợ nội bộ này do phiếu điều tiền liên nhà hàng sinh ra. Hãy xử lý ở màn Vận hành tài chính để bút toán và công nợ đi cùng nhau.";
  }
  // Còn phiếu thu/chi đã đối trừ vào khoản này thì phải giữ lại để không mất dấu thanh toán.
  const settlementCount = await prisma.debtSettlement.count({ where: { debtId: current.id } });
  if (settlementCount > 0) return "Khoản công nợ đã được thanh toán bằng phiếu thu/chi, không thể xóa.";
  if (current.outstandingAmount !== current.originalAmount || current.status !== "OPEN") {
    return "Khoản công nợ đã phát sinh thanh toán hoặc đã tất toán, không thể xóa.";
  }
  if (await isPeriodLocked(current.documentDate, current.branchCode)) return "Kỳ kế toán đã khóa, không thể xóa công nợ";
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
