import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { prisma, prismaRaw } from "@/lib/prisma";
import { assertBranchAccess, branchFilterForSession, ensureDefaultAccounts } from "@/lib/accounting";
import { cleanText, isPeriodLocked, periodFromDate, toDate, toNumber } from "@/lib/phase3";
import { writeAuditLog } from "@/lib/audit-log";
import { nextSeqFromCodes } from "@/lib/voucher-code-generator";
import { SoftDeleteError } from "@/lib/soft-delete";
import {
  costReallocationTotal,
  journalIsBalanced,
  planCostReallocationJournals,
  validateCostReallocation,
} from "@/lib/cost-reallocation";
import { ensureInternalPartner } from "@/lib/internal-partner";

export async function GET(request: Request) {
  try {
    const auth = requireMenuAccess(request, "/cost-reallocations");
    if (!auth.ok) return auth.response;
    const { searchParams } = new URL(request.url);
    const period = cleanText(searchParams.get("period"));
    const branchFilter = branchFilterForSession(auth.session, searchParams.get("branchCode") || "ALL");

    const rows = await prisma.costReallocation.findMany({
      where: {
        deletedAt: null,
        ...(period ? { period } : {}),
        ...(branchFilter.branchCode ? { fromBranchCode: branchFilter.branchCode } : {}),
      },
      include: { lines: true },
      orderBy: [{ documentDate: "desc" }, { createdAt: "desc" }],
      take: 200,
    });
    return NextResponse.json(rows);
  } catch (error) {
    console.error("Error fetching cost reallocations:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const auth = requireMenuAction(request, "/cost-reallocations", "create");
    if (!auth.ok) return auth.response;
    const body = await request.json();

    const fromBranchCode = cleanText(body.fromBranchCode).toUpperCase();
    const pnlItemCode = cleanText(body.pnlItemCode).toUpperCase();
    const description = cleanText(body.description);
    const documentDate = toDate(body.documentDate);
    const rawLines = Array.isArray(body.lines) ? body.lines as Array<Record<string, unknown>> : [];
    const lines = rawLines.map((line) => ({
      toBranchCode: cleanText(line.toBranchCode).toUpperCase(),
      amount: toNumber(line.amount),
      note: cleanText(line.note) || null,
    }));

    const errors = validateCostReallocation({ fromBranchCode, pnlItemCode, lines });
    if (!description) errors.push("Thiếu diễn giải");
    if (errors.length > 0) return NextResponse.json({ error: errors[0] }, { status: 400 });

    // Quyền và kỳ khóa phải kiểm ở CẢ hai đầu: phiếu ghi sổ đồng thời vào nhiều nhà hàng.
    const branches = [fromBranchCode, ...lines.map((line) => line.toBranchCode)];
    for (const branch of branches) {
      try {
        assertBranchAccess(auth.session, branch);
      } catch (e) {
        return NextResponse.json({ error: e instanceof Error ? e.message : "Không có quyền chi nhánh" }, { status: 403 });
      }
      if (await isPeriodLocked(documentDate, branch)) {
        return NextResponse.json({ error: `Kỳ kế toán của ${branch} đã khóa, không thể phân bổ chi phí vào kỳ này` }, { status: 400 });
      }
    }
    const knownBranches = await prisma.masterDataItem.findMany({
      where: { type: "BRANCH", code: { in: branches }, status: "ACTIVE", deletedAt: null },
      select: { code: true },
    });
    const knownBranchCodes = new Set(knownBranches.map((row) => row.code));
    const unknownBranch = branches.find((branch) => !knownBranchCodes.has(branch));
    if (unknownBranch) {
      return NextResponse.json({ error: `Nhà hàng [${unknownBranch}] không tồn tại hoặc đã ngừng hoạt động` }, { status: 400 });
    }

    const pnlItem = await prisma.masterDataItem.findFirst({
      where: { type: "PNL_ITEM", code: pnlItemCode, status: "ACTIVE", deletedAt: null },
      select: { code: true, name: true, group: true },
    });
    if (!pnlItem) return NextResponse.json({ error: `Hạng mục P&L [${pnlItemCode}] không tồn tại hoặc đã ngừng hoạt động` }, { status: 400 });

    const journals = planCostReallocationJournals({ fromBranchCode, pnlItemCode, lines }, pnlItem.group);
    const unbalanced = journals.find((journal) => !journalIsBalanced(journal));
    if (unbalanced) {
      return NextResponse.json({ error: `Bút toán của ${unbalanced.branchCode} không cân, không thể ghi sổ` }, { status: 400 });
    }

    const accounts = await ensureDefaultAccounts();
    const accountIdByCode = new Map(accounts.map((row) => [row.code, row.id]));
    const missingAccount = journals.flatMap((journal) => journal.lines).find((line) => !accountIdByCode.has(line.accountCode));
    if (missingAccount) {
      return NextResponse.json({ error: `Thiếu tài khoản kế toán ${missingAccount.accountCode}` }, { status: 400 });
    }

    const totalAmount = costReallocationTotal(lines);
    const period = periodFromDate(documentDate);

    const created = await prismaRaw.$transaction(async (tx) => {
      const prefix = `PBCP-${period.replace("-", "")}`;
      // Max + 1 chứ không COUNT: phiếu bị xoá làm COUNT tụt và cấp lại mã đang còn sống.
      const codePrefix = `${prefix}-`;
      const issuedCodes = await tx.costReallocation.findMany({ where: { code: { startsWith: codePrefix } }, select: { code: true } });
      const code = codePrefix + String(nextSeqFromCodes(issuedCodes.map((row) => row.code), codePrefix)).padStart(4, "0");

      const reallocation = await tx.costReallocation.create({
        data: {
          code,
          documentDate,
          period,
          fromBranchCode,
          pnlItemCode,
          description,
          totalAmount,
          status: "POSTED",
          createdBy: auth.session.name,
          lines: { create: lines.map((line) => ({ toBranchCode: line.toBranchCode, amount: line.amount, note: line.note })) },
        },
        include: { lines: true },
      });

      // Bút toán ở nhà hàng đã trả: giảm chi phí, ghi phải thu nội bộ.
      const fromJournal = journals[0];
      await tx.journalEntry.create({
        data: {
          code: `JE-${reallocation.code}-${fromBranchCode}`,
          entryDate: documentDate,
          period,
          branchCode: fromBranchCode,
          sourceType: "COST_REALLOCATION",
          sourceId: reallocation.id,
          sourceCode: reallocation.code,
          description: `${description} — ${fromJournal.description}`,
          status: "POSTED",
          createdBy: auth.session.name,
          lines: {
            create: fromJournal.lines.map((line) => ({
              accountId: accountIdByCode.get(line.accountCode) as string,
              debit: line.debit,
              credit: line.credit,
              pnlItemCode: line.pnlItemCode || null,
              partnerCode: line.partnerCode || null,
              description: reallocation.code,
            })),
          },
        },
      });

      const fromPartner = await ensureInternalPartner(tx as unknown as typeof prisma, fromBranchCode);
      for (const [index, line] of reallocation.lines.entries()) {
        const journal = journals[index + 1];
        await tx.journalEntry.create({
          data: {
            code: `JE-${reallocation.code}-${line.toBranchCode}`,
            entryDate: documentDate,
            period,
            branchCode: line.toBranchCode,
            sourceType: "COST_REALLOCATION_LINE",
            sourceId: line.id,
            sourceCode: reallocation.code,
            description: `${description} — ${journal.description}`,
            status: "POSTED",
            createdBy: auth.session.name,
            lines: {
              create: journal.lines.map((row) => ({
                accountId: accountIdByCode.get(row.accountCode) as string,
                debit: row.debit,
                credit: row.credit,
                pnlItemCode: row.pnlItemCode || null,
                partnerCode: row.partnerCode || null,
                description: reallocation.code,
              })),
            },
          },
        });

        // Công nợ nội bộ hai đầu: nhà hàng đã trả có khoản phải thu, nhà hàng nhận có khoản
        // phải trả. Khi hoàn tiền, phiếu thu/chi gạch thẳng vào hai mã này.
        const toPartner = await ensureInternalPartner(tx as unknown as typeof prisma, line.toBranchCode);
        const receivable = await tx.debtRecord.create({
          data: {
            code: `${reallocation.code}-PT-${line.toBranchCode}`,
            debtType: "RECEIVABLE",
            partnerGroup: "INTERNAL",
            partnerCode: toPartner.code,
            partnerName: toPartner.name,
            branchCode: fromBranchCode,
            documentDate,
            pnlItemCode,
            originalAmount: line.amount,
            outstandingAmount: line.amount,
            description: `${line.toBranchCode} hoàn lại chi phí phân bổ theo ${reallocation.code}`,
            sourceType: "COST_REALLOCATION",
            sourceId: reallocation.id,
            status: "OPEN",
          },
        });
        const payable = await tx.debtRecord.create({
          data: {
            code: `${reallocation.code}-PTR-${line.toBranchCode}`,
            debtType: "PAYABLE",
            partnerGroup: "INTERNAL",
            partnerCode: fromPartner.code,
            partnerName: fromPartner.name,
            branchCode: line.toBranchCode,
            documentDate,
            pnlItemCode,
            originalAmount: line.amount,
            outstandingAmount: line.amount,
            description: `Hoàn lại ${fromBranchCode} chi phí đã trả hộ theo ${reallocation.code}`,
            sourceType: "COST_REALLOCATION",
            sourceId: reallocation.id,
            status: "OPEN",
          },
        });
        await tx.costReallocationLine.update({
          where: { id: line.id },
          data: { receivableDebtCode: receivable.code, payableDebtCode: payable.code },
        });
      }

      return reallocation;
    });

    await writeAuditLog({
      session: auth.session,
      module: "COST_REALLOCATIONS",
      action: "CREATE",
      entityType: "CostReallocation",
      entityId: created.id,
      entityCode: created.code,
      branchCode: fromBranchCode,
      metadata: { fromBranchCode, pnlItemCode, totalAmount, branches: lines.map((line) => line.toBranchCode) },
    });
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    console.error("Error creating cost reallocation:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const auth = requireMenuAction(request, "/cost-reallocations", "delete");
    if (!auth.ok) return auth.response;
    const { searchParams } = new URL(request.url);
    const id = cleanText(searchParams.get("id"));
    if (!id) return NextResponse.json({ error: "Thiếu ID phiếu phân bổ" }, { status: 400 });

    const current = await prisma.costReallocation.findFirst({ where: { id, deletedAt: null }, include: { lines: true } });
    if (!current) return NextResponse.json({ error: "Không tìm thấy phiếu phân bổ" }, { status: 404 });

    try {
      assertBranchAccess(auth.session, current.fromBranchCode);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Không có quyền chi nhánh" }, { status: 403 });
    }
    for (const branch of [current.fromBranchCode, ...current.lines.map((line) => line.toBranchCode)]) {
      if (await isPeriodLocked(current.documentDate, branch)) {
        return NextResponse.json({ error: `Kỳ kế toán của ${branch} đã khóa, không thể xoá phiếu` }, { status: 400 });
      }
    }

    // Đã có nhà hàng hoàn tiền thì số liệu do phiếu thu/chi quyết định — không cho xoá ngầm.
    const debtCodes = current.lines.flatMap((line) => [line.receivableDebtCode, line.payableDebtCode].filter(Boolean) as string[]);
    const settledCount = debtCodes.length > 0
      ? await prisma.debtSettlement.count({ where: { debt: { code: { in: debtCodes } } } })
      : 0;
    if (settledCount > 0) {
      return NextResponse.json(
        { error: "Công nợ nội bộ của phiếu đã có thanh toán, không thể xoá. Hãy hoàn tác phiếu thu/chi trước." },
        { status: 400 },
      );
    }

    await prismaRaw.$transaction(async (tx) => {
      await tx.journalEntry.deleteMany({ where: { sourceType: "COST_REALLOCATION", sourceId: current.id } });
      await tx.journalEntry.deleteMany({ where: { sourceType: "COST_REALLOCATION_LINE", sourceId: { in: current.lines.map((line) => line.id) } } });
      if (debtCodes.length > 0) await tx.debtRecord.deleteMany({ where: { code: { in: debtCodes } } });
      await tx.costReallocation.update({
        where: { id: current.id },
        data: { deletedAt: new Date(), deletedBy: auth.session.name, status: "CANCELLED" },
      });
    });

    await writeAuditLog({
      session: auth.session,
      module: "COST_REALLOCATIONS",
      action: "DELETE",
      entityType: "CostReallocation",
      entityId: current.id,
      entityCode: current.code,
      branchCode: current.fromBranchCode,
      metadata: { totalAmount: current.totalAmount },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof SoftDeleteError) return NextResponse.json({ error: error.message }, { status: 400 });
    console.error("Error deleting cost reallocation:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
