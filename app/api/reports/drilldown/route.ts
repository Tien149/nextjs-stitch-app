import { NextResponse } from "next/server";
import { requireMenuAccess } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { periodBounds } from "@/lib/accounting";
import { apiError, businessError, cleanText, normalizePeriod } from "@/lib/phase3";
import { createPnlItemRefLookup, DEPRECIATION_PNL_ACCOUNT, depreciationCatalogItemCode, payrollCatalogItemCode, pnlLineAmount, pnlLineKeyOf, resolvePnlItemCode, withDepreciationPnlItem } from "@/lib/reports";

/** Khoá drilldown cho một hạng mục P&L: `pnlItem:<mã>`; `pnlItem:UNCLASSIFIED` là chứng từ chưa gán hạng mục. */
const PNL_ITEM_METRIC_PREFIX = "pnlItem:";

export async function GET(request: Request) {
  try {
    const auth = requireMenuAccess(request, "/reports");
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const period = normalizePeriod(searchParams.get("period") || "");
    const branchCode = searchParams.get("branchCode") || "ALL";
    const metric = cleanText(searchParams.get("metric") || "");
    // Dòng KQKD mà hạng mục đang đứng dưới (tab Ngân sách): cùng một mã hạng mục có thể
    // dính bút toán lương lẫn OPEX, chỉ lấy đúng phần thuộc dòng đang xem cho khớp số.
    const lineKey = cleanText(searchParams.get("line") || "");
    const pnlItemCode = metric.startsWith(PNL_ITEM_METRIC_PREFIX) ? metric.slice(PNL_ITEM_METRIC_PREFIX.length) : null;

    if (!period || !metric) {
      businessError("Thiếu kỳ báo cáo hoặc chỉ tiêu");
    }

    const { start, end } = periodBounds(period);
    // Hạng mục lương/nhân sự hạch toán 6428 vẫn thuộc dòng Chi phí nhân sự — phải bắt đúng
    // dòng như lib/reports.ts, không thì bấm dòng nhân sự thiếu tiền, bấm OPEX lại thừa.
    const [catalogPnlItems, pnlGroups] = await Promise.all([
      prisma.masterDataItem.findMany({ where: { type: "PNL_ITEM" }, select: { code: true, name: true, group: true, subGroup: true, status: true } }),
      prisma.masterDataItem.findMany({ where: { type: "PNL_GROUP" }, select: { code: true, name: true, group: true } }),
    ]);
    // Cùng danh mục với bảng P&L: có sẵn hạng mục "CPCĐ - CP Khấu Hao" dù danh mục chưa khai.
    const pnlItems = withDepreciationPnlItem(catalogPnlItems, pnlGroups);
    const pnlItemRefOf = createPnlItemRefLookup(pnlItems, pnlGroups);
    // Khấu hao không gắn hạng mục nhưng trên P&L đứng ở hạng mục CP Khấu Hao — bấm vào hạng mục
    // đó phải thấy đúng các dòng khấu hao (cùng luật với lib/reports.ts).
    const depreciationItemCode = depreciationCatalogItemCode(pnlItems);
    const payrollItemCode = payrollCatalogItemCode(pnlItems);
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
    /**
     * P&L đọc khấu hao thẳng từ màn Khấu hao (loadDepreciationPnlRows), không từ bút toán 6424 —
     * drilldown phải đọc cùng nguồn, không thì kỳ chưa "Đồng bộ ghi sổ" bấm vào dòng khấu hao
     * ra danh sách trống trong khi bảng có số.
     */
    const depreciations = await prisma.assetDepreciation.findMany({
      where: { period, ...(branchCode === "ALL" ? {} : { asset: { branchCode } }) },
      include: { asset: { select: { code: true, name: true } } },
      orderBy: { createdAt: "desc" },
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

    /** Số tiền một dòng góp vào chỉ tiêu đang xem; null nếu không thuộc chỉ tiêu đó. */
    const matchedAmount = (line: {
      account: { accountType: string; reportGroup: string };
      pnlItemCode: string | null;
      debit: number;
      credit: number;
    }) => {
      let isMatch = false;
      let lineAmount = 0;

      const { accountType } = line.account;
      const accountLine = pnlLineKeyOf(line.account, pnlItemRefOf(line.pnlItemCode));

      if (pnlItemCode !== null) {
        const isExpenseLine = accountLine !== null && accountLine !== "revenue" && accountLine !== "otherIncome";
        const effectiveItemCode = resolvePnlItemCode(line, depreciationItemCode, payrollItemCode);
        const sameItem = pnlItemCode === "UNCLASSIFIED" ? !effectiveItemCode : effectiveItemCode === pnlItemCode;
        if (isExpenseLine && sameItem && (!lineKey || lineKey === accountLine)) {
          isMatch = true;
          lineAmount = line.debit - line.credit;
        }
      } else if (metric === "revenue" && accountType === "REVENUE") {
        isMatch = true;
        lineAmount = line.credit - line.debit;
      } else if (metric === "cogs" && accountType === "COGS") {
        isMatch = true;
        lineAmount = line.debit - line.credit;
      } else if (metric === "payroll" && accountLine === "payroll") {
        isMatch = true;
        lineAmount = line.debit - line.credit;
      } else if (metric === "otherOpex" && accountLine === "otherOpex") {
        isMatch = true;
        lineAmount = line.debit - line.credit;
      } else if (metric === "opexBeforeDepreciation" && (accountLine === "payroll" || accountLine === "otherOpex" || accountLine === "capex")) {
        // Chi phí hoạt động = nhân sự + CAPEX + OPEX (khấu hao đã nằm trong OPEX; CAPEX trừ vào
        // lợi nhuận từ 24/09/2026). Theo DÒNG P&L chứ không theo loại tài khoản.
        isMatch = true;
        lineAmount = accountLine === "capex" ? pnlLineAmount("capex", line) : line.debit - line.credit;
      } else if (metric === "ebitda") {
        // Lợi nhuận hoạt động = doanh thu − giá vốn − nhân sự − CAPEX − OPEX (gồm khấu hao).
        if (accountType === "COGS" || accountLine === "payroll" || accountLine === "otherOpex" || accountLine === "capex") {
          isMatch = true;
          lineAmount = accountLine === "capex" ? pnlLineAmount("capex", line) : line.debit - line.credit;
        } else if (accountType === "REVENUE") {
          isMatch = true;
          lineAmount = -(line.credit - line.debit); // Display negative expense-equivalent or positive outflow
        }
      }

      return isMatch && Math.abs(lineAmount) > 0.01 ? lineAmount : null;
    };

    for (const entry of entries) {
      for (const line of entry.lines) {
        // Khấu hao lấy từ màn Khấu hao ở vòng dưới.
        if (line.account.reportGroup === DEPRECIATION_PNL_ACCOUNT.reportGroup) continue;
        const lineAmount = matchedAmount(line);
        if (lineAmount !== null) {
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

    for (const row of depreciations) {
      const amount = matchedAmount({ account: DEPRECIATION_PNL_ACCOUNT, pnlItemCode: null, debit: row.depreciationAmount, credit: 0 });
      if (amount === null) continue;
      list.push({
        id: row.id,
        code: row.asset.code,
        date: `${row.period}-01`,
        description: `Khấu hao ${row.asset.name} kỳ ${row.period.slice(5, 7)}/${row.period.slice(0, 4)}`,
        amount,
        accountCode: "6424",
        accountName: "Chi phí khấu hao",
      });
    }

    return NextResponse.json(list);
  } catch (error) {
    const result = apiError(error);
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
}
