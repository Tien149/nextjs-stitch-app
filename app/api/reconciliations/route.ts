import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { assertBranchAccess, branchFilterForSession } from "@/lib/accounting";

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function toAmount(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function sameDay(a: Date, b: Date) {
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}

function scoreCandidate(bank: { transactionDate: Date; creditAmount: number; debitAmount: number; partnerHint: string | null }, candidate: { date: Date; amount: number; partnerCode?: string | null }) {
  const bankAmount = bank.creditAmount || bank.debitAmount;
  let score = 0;
  if (Math.abs(bankAmount - candidate.amount) < 1) score += 70;
  if (sameDay(bank.transactionDate, candidate.date)) score += 20;
  if (bank.partnerHint && candidate.partnerCode && bank.partnerHint === candidate.partnerCode) score += 10;
  return score;
}

export async function GET(request: Request) {
  try {
    const auth = requireMenuAccess(request, "/reconciliations");
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status") || "UNMATCHED";
    const branchFilter = branchFilterForSession(auth.session, searchParams.get("branchCode") || "ALL");

    const [bankRows, revenueRows, deposits, vouchers, matches] = await Promise.all([
      prisma.bankStatementTransaction.findMany({
        where: {
          ...branchFilter,
          ...(status === "ALL" ? {} : { reconcileStatus: status })
        },
        orderBy: { transactionDate: "desc" },
        take: 100,
      }),
      prisma.revenueImportRow.findMany({ where: { ...branchFilter }, orderBy: { saleDate: "desc" }, take: 300 }),
      prisma.deposit.findMany({ where: { ...branchFilter }, orderBy: { receivedDate: "desc" }, take: 300 }),
      prisma.financialVoucher.findMany({ where: { ...branchFilter, status: "APPROVED" }, orderBy: { voucherDate: "desc" }, take: 300 }),
      prisma.reconciliationMatch.findMany({ orderBy: { createdAt: "desc" }, take: 100 }),
    ]);

    const rows = bankRows.map((bank) => {
      const bankAmount = bank.creditAmount || bank.debitAmount;
      const candidates = [
        ...revenueRows.map((row) => ({
          targetType: "REVENUE_POS",
          targetId: row.id,
          targetCode: row.externalRef,
          targetDate: row.saleDate,
          targetAmount: row.netAmount,
          label: `${row.branchCode} - ${row.channel || "POS"} - ${row.paymentMethod}`,
          score: scoreCandidate(bank, { date: row.saleDate, amount: row.netAmount }),
        })),
        ...deposits.map((row) => ({
          targetType: "DEPOSIT",
          targetId: row.id,
          targetCode: row.code,
          targetDate: row.receivedDate,
          targetAmount: row.amount,
          label: `${row.partnerName} - ${row.purpose}`,
          score: scoreCandidate(bank, { date: row.receivedDate, amount: row.amount, partnerCode: row.partnerCode }),
        })),
        ...vouchers.map((row) => ({
          targetType: "VOUCHER",
          targetId: row.id,
          targetCode: row.code,
          targetDate: row.voucherDate,
          targetAmount: row.amount,
          label: `${row.partnerName} - ${row.description}`,
          score: scoreCandidate(bank, { date: row.voucherDate, amount: row.amount, partnerCode: row.partnerCode }),
        })),
      ]
        .filter((candidate) => candidate.score >= 70 && Math.abs(candidate.targetAmount - bankAmount) < 1)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      return { ...bank, candidates };
    });

    return NextResponse.json({ rows, matches });
  } catch (error) {
    console.error("Error fetching reconciliation data:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const auth = requireMenuAction(request, "/reconciliations", "edit");
    if (!auth.ok) return auth.response;

    const body = await request.json();
    const bankTransactionId = cleanText(body.bankTransactionId);
    const targetType = cleanText(body.targetType);
    const targetId = cleanText(body.targetId);
    const targetCode = cleanText(body.targetCode);
    const targetAmount = toAmount(body.targetAmount);

    if (!bankTransactionId || !targetType || !targetId || !targetCode || targetAmount <= 0) {
      return NextResponse.json({ error: "Thiếu thông tin đối soát" }, { status: 400 });
    }

    const bank = await prisma.bankStatementTransaction.findUnique({ where: { id: bankTransactionId } });
    if (!bank) return NextResponse.json({ error: "Không tìm thấy giao dịch sao kê" }, { status: 404 });
    if (bank.branchCode) {
      try {
        assertBranchAccess(auth.session, bank.branchCode);
      } catch (e) {
        return NextResponse.json({ error: e instanceof Error ? e.message : "Không có quyền chi nhánh" }, { status: 403 });
      }
    }
    if (bank.reconcileStatus === "MATCHED") {
      return NextResponse.json({ error: "Giao dịch này đã được đối soát" }, { status: 400 });
    }

    const matchedAmount = bank.creditAmount || bank.debitAmount;
    if (Math.abs(matchedAmount - targetAmount) >= 1) {
      return NextResponse.json({ error: "Số tiền sao kê và chứng từ không khớp" }, { status: 400 });
    }

    const match = await prisma.$transaction(async (tx) => {
      const created = await tx.reconciliationMatch.create({
        data: {
          bankTransactionId,
          targetType,
          targetId,
          targetCode,
          targetDate: body.targetDate ? new Date(String(body.targetDate)) : null,
          targetAmount,
          matchedAmount,
          note: cleanText(body.note) || null,
          matchedBy: auth.session.name,
        },
      });

      await tx.bankStatementTransaction.update({
        where: { id: bankTransactionId },
        data: { reconcileStatus: "MATCHED" },
      });

      return created;
    });

    return NextResponse.json(match, { status: 201 });
  } catch (error) {
    console.error("Error creating reconciliation match:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Internal Server Error" }, { status: 500 });
  }
}
