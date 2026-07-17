import { NextResponse } from "next/server";
import { requireMenuAccess } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";

type DebtRow = {
  partnerCode: string;
  partnerName: string;
  openingAmount: number;
  depositHolding: number;
  bankMatched: number;
  voucherNet: number;
  purchasePayable: number;
  balance: number;
};

type LedgerRow = {
  date: Date;
  source: string;
  code: string;
  description: string;
  amount: number;
};

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

    const [partners, openingBalances, deposits, bankRows, vouchers, purchasePayables] = await Promise.all([
      prisma.masterDataItem.findMany({ where: { type: "PARTNER" } }),
      prisma.openingBalance.findMany({ where: { balanceType: { in: ["AR", "AP"] } } }),
      prisma.deposit.findMany(),
      prisma.bankStatementTransaction.findMany({ where: { partnerHint: { not: null } } }),
      prisma.financialVoucher.findMany({ where: { partnerCode: { not: null }, status: { not: "CANCELLED" } } }),
      prisma.supplierPayable.findMany({ include: { purchaseOrder: true } }),
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
    for (const partner of partners) addDebt(rows, partner.code, partner.name, {});

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

    const result = Array.from(rows.values())
      .map((row) => ({
        ...row,
        balance: row.openingAmount + row.purchasePayable - row.depositHolding - row.bankMatched - row.voucherNet,
      }))
      .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));

    return NextResponse.json(result);
  } catch (error) {
    console.error("Error fetching debts:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
