import { NextResponse } from "next/server";
import { requireMenuAccess } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { periodBounds } from "@/lib/accounting";
import { apiError, businessError, cleanText, normalizePeriod } from "@/lib/phase3";

export async function GET(request: Request) {
  try {
    const auth = requireMenuAccess(request, "/reports");
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const period = normalizePeriod(searchParams.get("period") || "");
    const branchCode = searchParams.get("branchCode") || "ALL";
    const metric = cleanText(searchParams.get("metric") || "");

    if (!period || !metric) {
      businessError("Thiếu kỳ báo cáo hoặc chỉ tiêu");
    }

    const { start, end } = periodBounds(period);
    const entries = await prisma.journalEntry.findMany({
      where: {
        entryDate: { gte: start, lt: end },
        status: "POSTED",
        ...(branchCode === "ALL" ? {} : { branchCode }),
      },
      include: {
        lines: {
          include: {
            account: true,
          },
        },
      },
      orderBy: { entryDate: "desc" },
    });

    const list: Array<{
      id: string;
      code: string;
      date: string;
      description: string;
      amount: number;
      accountCode: string;
      accountName: string;
    }> = [];

    for (const entry of entries) {
      for (const line of entry.lines) {
        let isMatch = false;
        let lineAmount = 0;

        const { accountType, reportGroup } = line.account;

        if (metric === "revenue" && accountType === "REVENUE") {
          isMatch = true;
          lineAmount = line.credit - line.debit;
        } else if (metric === "cogs" && accountType === "COGS") {
          isMatch = true;
          lineAmount = line.debit - line.credit;
        } else if (metric === "payroll" && accountType === "OPEX" && reportGroup === "PAYROLL") {
          isMatch = true;
          lineAmount = line.debit - line.credit;
        } else if (metric === "depreciation" && accountType === "OPEX" && reportGroup === "DEPRECIATION") {
          isMatch = true;
          lineAmount = line.debit - line.credit;
        } else if (
          metric === "otherOpex" &&
          accountType === "OPEX" &&
          reportGroup !== "PAYROLL" &&
          reportGroup !== "DEPRECIATION"
        ) {
          isMatch = true;
          lineAmount = line.debit - line.credit;
        } else if (
          metric === "opexBeforeDepreciation" &&
          accountType === "OPEX" &&
          reportGroup !== "DEPRECIATION"
        ) {
          isMatch = true;
          lineAmount = line.debit - line.credit;
        } else if (metric === "ebitda") {
          // EBITDA includes COGS, PAYROLL, OTHER_OPEX
          if (accountType === "COGS" || (accountType === "OPEX" && reportGroup !== "DEPRECIATION")) {
            isMatch = true;
            lineAmount = line.debit - line.credit;
          } else if (accountType === "REVENUE") {
            isMatch = true;
            lineAmount = -(line.credit - line.debit); // Display negative expense-equivalent or positive outflow
          }
        }

        if (isMatch && Math.abs(lineAmount) > 0.01) {
          list.push({
            id: entry.id,
            code: entry.sourceCode || entry.code,
            date: entry.entryDate.toISOString().slice(0, 10),
            description: line.description || entry.description,
            amount: lineAmount,
            accountCode: line.account.code,
            accountName: line.account.name,
          });
        }
      }
    }

    return NextResponse.json(list);
  } catch (error) {
    const result = apiError(error);
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
}
