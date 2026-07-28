import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { assertBranchAccess, requestedBranch } from "@/lib/accounting";
import { cleanText, isPeriodLocked, toDate, toNumber } from "@/lib/phase3";
import { writeAuditLog } from "@/lib/audit-log";
import { softDeleteRecord, SoftDeleteError } from "@/lib/soft-delete";

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
          date: item.createdAt,
          source: "OPENING_BALANCE",
          code: `${item.period}-${item.balanceType}`,
          description: item.note || "Số dư đầu kỳ",
          amount: item.amount,
        });
      }
      for (const item of deposits.filter((row) => row.partnerCode === partnerCode)) {
        ledger.push({
          date: item.receivedDate,
          source: "DEPOSIT",
          code: item.code,
          description: item.purpose,
          amount: -item.remainingAmount,
        });
      }
      for (const item of bankRows.filter((row) => row.partnerHint === partnerCode)) {
        ledger.push({
          date: item.transactionDate,
          source: "BANK_STATEMENT",
          code: item.transactionCode,
          description: item.description,
          amount: -(item.creditAmount - item.debitAmount),
        });
      }
      for (const item of vouchers.filter((row) => row.partnerCode === partnerCode)) {
        ledger.push({
          date: item.voucherDate,
          source: "VOUCHER",
          code: item.code,
          description: item.description,
          amount: item.voucherType === "RECEIPT" ? -item.amount : item.amount,
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
          date: item.documentDate,
          source: item.debtType,
          code: item.code,
          dueDate: item.dueDate,
          description: `${item.description}${item.dueDate ? ` · Hạn ${item.dueDate.toLocaleDateString("vi-VN")}` : ""}`,
          amount: item.debtType === "RECEIVABLE" ? item.outstandingAmount : -item.outstandingAmount,
          status: item.status,
          agingBucket: agingBucket(item.dueDate),
        });
      }

      const sortedLedger = ledger.sort((a, b) => b.date.getTime() - a.date.getTime());
      const balance = sortedLedger.reduce((sum, row) => sum + row.amount, 0);
      const partner = partners.find((item) => item.code === partnerCode);
      return NextResponse.json({
        partnerCode,
        partnerName: partner?.name || partnerCode,
        balance,
        rows: sortedLedger,
      });
    }

    const rows = new Map<string, DebtRow>();
    for (const partner of partners) addDebt(rows, partner.code, partner.name, { partnerGroup: partner.partnerGroup || "EXTERNAL" });

    for (const item of openingBalances) {
      if (!item.objectCode) continue;
      const current = rows.get(item.objectCode);
      addDebt(rows, item.objectCode, item.objectName || item.objectCode, {
        openingAmount: (current?.openingAmount || 0) + item.amount,
      });
    }

    for (const item of deposits) {
      const current = rows.get(item.partnerCode);
      addDebt(rows, item.partnerCode, item.partnerName, {
        depositHolding: (current?.depositHolding || 0) + item.remainingAmount,
      });
    }

    for (const item of bankRows) {
      if (!item.partnerHint) continue;
      const current = rows.get(item.partnerHint);
      addDebt(rows, item.partnerHint, item.partnerHint, {
        bankMatched: (current?.bankMatched || 0) + item.creditAmount - item.debitAmount,
      });
    }

    for (const item of vouchers) {
      if (!item.partnerCode) continue;
      const current = rows.get(item.partnerCode);
      const signedAmount = item.voucherType === "RECEIPT" ? item.amount : -item.amount;
      addDebt(rows, item.partnerCode, item.partnerName, {
        voucherNet: (current?.voucherNet || 0) + signedAmount,
      });
    }

    for (const item of purchasePayables) {
      const current = rows.get(item.supplierCode);
      addDebt(rows, item.supplierCode, item.supplierName, {
        purchasePayable: (current?.purchasePayable || 0) + item.outstandingAmount,
      });
    }

    for (const item of debtRecords) {
      const current = rows.get(item.partnerCode);
      const bucket = agingBucket(item.dueDate);
      const currentDue = current?.nearestDueDate || null;
      const nextDue = item.outstandingAmount > 0 && item.dueDate && (!currentDue || item.dueDate < currentDue) ? item.dueDate : currentDue;
      const hasOpenDebt = item.outstandingAmount > 0 && item.status !== "SETTLED";
      addDebt(rows, item.partnerCode, item.partnerName, {
        partnerGroup: item.partnerGroup,
        debtReceivable: (current?.debtReceivable || 0) + (item.debtType === "RECEIVABLE" ? item.outstandingAmount : 0),
        debtPayable: (current?.debtPayable || 0) + (item.debtType === "PAYABLE" ? item.outstandingAmount : 0),
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
        balance: row.openingAmount + row.purchasePayable + row.debtReceivable - row.debtPayable - row.depositHolding - row.bankMatched - row.voucherNet,
      }))
      .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));

    return NextResponse.json(result);
  } catch (error) {
    console.error("Error fetching debts:", error);
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

export async function DELETE(request: Request) {
  try {
    const auth = requireMenuAction(request, "/debts", "delete");
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const id = cleanText(searchParams.get("id"));
    const reason = cleanText(searchParams.get("reason")) || null;
    if (!id) return NextResponse.json({ error: "Thiếu ID công nợ" }, { status: 400 });

    const current = await prisma.debtRecord.findUnique({ where: { id } });
    if (!current) return NextResponse.json({ error: "Không tìm thấy khoản công nợ" }, { status: 404 });

    try {
      assertBranchAccess(auth.session, current.branchCode);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Không có quyền chi nhánh" }, { status: 403 });
    }

    // Còn phiếu thu/chi đã đối trừ vào khoản này thì phải giữ lại để không mất dấu thanh toán.
    const settlementCount = await prisma.debtSettlement.count({ where: { debtId: id } });
    if (settlementCount > 0) {
      return NextResponse.json(
        { error: "Khoản công nợ đã được thanh toán bằng phiếu thu/chi, không thể xóa." },
        { status: 400 },
      );
    }
    if (current.outstandingAmount !== current.originalAmount || current.status !== "OPEN") {
      return NextResponse.json(
        { error: "Khoản công nợ đã phát sinh thanh toán hoặc đã tất toán, không thể xóa." },
        { status: 400 },
      );
    }

    if (await isPeriodLocked(current.documentDate, current.branchCode)) {
      return NextResponse.json({ error: "Kỳ kế toán đã khóa, không thể xóa công nợ" }, { status: 400 });
    }

    await softDeleteRecord({ model: "DebtRecord", id, session: auth.session, reason });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof SoftDeleteError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Error deleting debt record:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
