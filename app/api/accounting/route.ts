import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { ensureDefaultAccounts, periodBounds, postJournalEntry, requestedBranch, syncAccountingPeriod } from "@/lib/accounting";
import { prisma } from "@/lib/prisma";
import { apiError, businessError, cleanText, normalizePeriod, toDate, toNumber } from "@/lib/phase3";

const menuHref = "/accounting";

export async function GET(request: Request) {
  try {
    const auth = requireMenuAccess(request, menuHref);
    if (!auth.ok) return auth.response;
    const params = new URL(request.url).searchParams;
    const period = normalizePeriod(params.get("period")) || new Date().toISOString().slice(0, 7);
    const branchCode = requestedBranch(auth.session, cleanText(params.get("branchCode")) || "ALL");
    const { start, end } = periodBounds(period);
    const [accounts, entries, categories] = await Promise.all([
      ensureDefaultAccounts(),
      prisma.journalEntry.findMany({
        where: { entryDate: { gte: start, lt: end }, status: "POSTED", ...(branchCode === "ALL" ? {} : { branchCode }) },
        include: { lines: { include: { account: true }, orderBy: { debit: "desc" } } },
        orderBy: [{ entryDate: "desc" }, { code: "desc" }],
        take: 300,
      }),
      prisma.masterDataItem.findMany({
        where: { type: { in: ["REVENUE_EXPENSE_CATEGORY", "MONEY_SOURCE"] }, status: "ACTIVE" }
      })
    ]);
    const debit = entries.flatMap((entry) => entry.lines).reduce((sum, line) => sum + line.debit, 0);
    const credit = entries.flatMap((entry) => entry.lines).reduce((sum, line) => sum + line.credit, 0);
    return NextResponse.json({ period, branchCode, accounts, entries, categories, totals: { debit, credit, difference: debit - credit } });
  } catch (error) {
    const result = apiError(error);
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const action = cleanText(body.action);
    const auth = requireMenuAction(request, menuHref, action === "SYNC_PERIOD" ? "config" : "create");
    if (!auth.ok) return auth.response;
    if (action === "SYNC_PERIOD") {
      const period = normalizePeriod(body.period);
      if (!period) businessError("Kỳ đồng bộ phải có dạng YYYY-MM");
      const branchCode = requestedBranch(auth.session, cleanText(body.branchCode) || "ALL");
      return NextResponse.json(await syncAccountingPeriod(period, branchCode, auth.session.name));
    }
    if (action === "CREATE_MANUAL") {
      const entryDate = toDate(body.entryDate);
      const branchCode = requestedBranch(auth.session, cleanText(body.branchCode));
      const description = cleanText(body.description) || "Bút toán điều chỉnh";
      const sourceId = crypto.randomUUID();

      let lines: any[] = [];
      if (body.entryType && body.amount) {
        const amount = toNumber(body.amount);
        const categoryCode = cleanText(body.categoryCode);
        const moneySourceCode = cleanText(body.moneySourceCode);
        
        // Determine bank vs cash account for the money source
        const cashAccount = (moneySourceCode.toUpperCase().includes("BANK") || moneySourceCode.toUpperCase().includes("VCB") || moneySourceCode.toUpperCase().includes("ACB")) ? "1121" : "1111";
        
        if (body.entryType === "EXPENSE") {
          lines = [
            { accountCode: "6428", debit: amount, categoryCode, description },
            { accountCode: cashAccount, credit: amount, description }
          ];
        } else if (body.entryType === "INCOME") {
          lines = [
            { accountCode: cashAccount, debit: amount, description },
            { accountCode: "511", credit: amount, categoryCode, description }
          ];
        } else {
          lines = [
            { accountCode: "6428", debit: amount, categoryCode, description },
            { accountCode: cashAccount, credit: amount, description }
          ];
        }
      } else {
        const rawLines = Array.isArray(body.lines) ? body.lines : [];
        if (rawLines.length < 2) businessError("Bút toán tay cần ít nhất hai dòng");
        lines = rawLines.map((line: Record<string, unknown>) => ({
          accountCode: cleanText(line.accountCode),
          debit: toNumber(line.debit),
          credit: toNumber(line.credit),
          departmentCode: cleanText(line.departmentCode) || null,
          categoryCode: cleanText(line.categoryCode) || null,
          description: cleanText(line.description) || description,
        }));
      }

      const result = await postJournalEntry({
        entryDate,
        branchCode,
        sourceType: "MANUAL",
        sourceId,
        sourceCode: cleanText(body.sourceCode) || null,
        description,
        createdBy: auth.session.name,
        lines,
      });
      return NextResponse.json({ status: result }, { status: 201 });
    }
    businessError("Thao tác sổ cái không hợp lệ");
  } catch (error) {
    const result = apiError(error);
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
}
