import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import type { Prisma } from "@prisma/custom-client";
import { prisma, prismaRaw, type RawTxClient } from "@/lib/prisma";
import type { DemoSession } from "@/lib/auth-demo";
import { assertBranchAccess, branchFilterForSession, ensureDefaultAccounts } from "@/lib/accounting";
import { cleanText, isPeriodLocked, periodFromDate, toDate, toNumber } from "@/lib/phase3";
import { writeAuditLog } from "@/lib/audit-log";
import { nextSeqFromCodes } from "@/lib/voucher-code-generator";
import { SoftDeleteError } from "@/lib/soft-delete";
import {
  availableForReallocationEdit,
  costReallocationTotal,
  journalIsBalanced,
  planCostReallocationJournals,
  reallocationOverspendMessage,
  validateCostReallocation,
} from "@/lib/cost-reallocation";
import { findExpenseForPnlItem, postedExpenseForPnlItem } from "@/lib/expense-summary";
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

type ParsedReallocation = {
  fromBranchCode: string;
  pnlItemCode: string;
  description: string;
  documentDate: Date;
  lines: Array<{ toBranchCode: string; amount: number; note: string | null }>;
};

type ReallocationPlan = ParsedReallocation & {
  period: string;
  totalAmount: number;
  journals: ReturnType<typeof planCostReallocationJournals>;
  accountIdByCode: Map<string, string>;
};

type ExistingReallocation = Prisma.CostReallocationGetPayload<{ include: { lines: true } }>;

function parseReallocationBody(body: Record<string, unknown>): ParsedReallocation {
  const rawLines = Array.isArray(body.lines) ? body.lines as Array<Record<string, unknown>> : [];
  return {
    fromBranchCode: cleanText(body.fromBranchCode).toUpperCase(),
    pnlItemCode: cleanText(body.pnlItemCode).toUpperCase(),
    description: cleanText(body.description),
    documentDate: toDate(body.documentDate),
    lines: rawLines.map((line) => ({
      toBranchCode: cleanText(line.toBranchCode).toUpperCase(),
      amount: toNumber(line.amount),
      note: cleanText(line.note) || null,
    })),
  };
}

const badRequest = (error: string, status = 400) => NextResponse.json({ error }, { status });

/**
 * Kiểm tra và dựng bút toán cho một phiếu sắp ghi sổ — dùng chung cho lập mới và sửa.
 * `current` là phiếu đang sửa: phần chi phí nó đã trừ khỏi sổ được cộng trả lại khi kiểm vượt.
 */
async function planReallocation(
  session: DemoSession,
  input: ParsedReallocation,
  current: ExistingReallocation | null,
): Promise<{ ok: true; plan: ReallocationPlan } | { ok: false; response: NextResponse }> {
  const fail = (error: string, status = 400) => ({ ok: false as const, response: badRequest(error, status) });
  const { fromBranchCode, pnlItemCode, description, documentDate, lines } = input;

  const errors = validateCostReallocation({ fromBranchCode, pnlItemCode, lines });
  if (!description) errors.push("Thiếu diễn giải");
  if (errors.length > 0) return fail(errors[0]);

  // Quyền và kỳ khóa phải kiểm ở CẢ hai đầu: phiếu ghi sổ đồng thời vào nhiều nhà hàng.
  const branches = [fromBranchCode, ...lines.map((line) => line.toBranchCode)];
  for (const branch of branches) {
    try {
      assertBranchAccess(session, branch);
    } catch (e) {
      return fail(e instanceof Error ? e.message : "Không có quyền chi nhánh", 403);
    }
    if (await isPeriodLocked(documentDate, branch)) {
      return fail(`Kỳ kế toán của ${branch} đã khóa, không thể phân bổ chi phí vào kỳ này`);
    }
  }
  const knownBranches = await prisma.masterDataItem.findMany({
    where: { type: "BRANCH", code: { in: branches }, status: "ACTIVE", deletedAt: null },
    select: { code: true },
  });
  const knownBranchCodes = new Set(knownBranches.map((row) => row.code));
  const unknownBranch = branches.find((branch) => !knownBranchCodes.has(branch));
  if (unknownBranch) return fail(`Nhà hàng [${unknownBranch}] không tồn tại hoặc đã ngừng hoạt động`);

  const pnlItem = await prisma.masterDataItem.findFirst({
    where: { type: "PNL_ITEM", code: pnlItemCode, status: "ACTIVE", deletedAt: null },
    select: { code: true, name: true, group: true },
  });
  if (!pnlItem) return fail(`Hạng mục P&L [${pnlItemCode}] không tồn tại hoặc đã ngừng hoạt động`);

  const journals = planCostReallocationJournals({ fromBranchCode, pnlItemCode, lines }, pnlItem.group);
  const unbalanced = journals.find((journal) => !journalIsBalanced(journal));
  if (unbalanced) return fail(`Bút toán của ${unbalanced.branchCode} không cân, không thể ghi sổ`);

  const accounts = await ensureDefaultAccounts();
  const accountIdByCode = new Map(accounts.map((row) => [row.code, row.id]));
  const missingAccount = journals.flatMap((journal) => journal.lines).find((line) => !accountIdByCode.has(line.accountCode));
  if (missingAccount) return fail(`Thiếu tài khoản kế toán ${missingAccount.accountCode}`);

  const totalAmount = costReallocationTotal(lines);
  const period = periodFromDate(documentDate);

  // Không có chi phí để chia thì phiếu này không phải phân bổ, mà là khai sai kỳ / nhà hàng /
  // hạng mục. Chặn tại đây vì sau khi ghi sổ thì hậu quả nằm rải ở hai nhà hàng và chỉ lộ ra
  // khi ai đó đối chiếu Tổng hợp chi phí với chứng từ gốc.
  const postedAmount = availableForReallocationEdit({
    postedAmount: await postedExpenseForPnlItem(period, fromBranchCode, pnlItemCode),
    next: { period, fromBranchCode, pnlItemCode },
    current,
  });
  if (totalAmount > postedAmount) {
    // Chỉ đi tìm tiền khi thật sự sắp báo lỗi — bốn truy vấn này không đáng chạy ở luồng bình thường.
    const whereabouts = await findExpenseForPnlItem(period, fromBranchCode, pnlItemCode);
    const overspend = reallocationOverspendMessage({ period, fromBranchCode, pnlItemName: pnlItem.name, postedAmount, total: totalAmount, whereabouts });
    if (overspend) return fail(overspend);
  }

  return { ok: true, plan: { ...input, period, totalAmount, journals, accountIdByCode } };
}

async function nextReallocationCode(tx: RawTxClient, period: string) {
  // Max + 1 chứ không COUNT: phiếu bị xoá làm COUNT tụt và cấp lại mã đang còn sống.
  const codePrefix = `PBCP-${period.replace("-", "")}-`;
  const issuedCodes = await tx.costReallocation.findMany({ where: { code: { startsWith: codePrefix } }, select: { code: true } });
  return codePrefix + String(nextSeqFromCodes(issuedCodes.map((row) => row.code), codePrefix)).padStart(4, "0");
}

/** Mã công nợ nội bộ của phiếu — lập mới, sửa và xoá đều gỡ/ghi theo đúng danh sách này. */
function reallocationDebtCodes(reallocation: ExistingReallocation) {
  return reallocation.lines.flatMap((line) => [line.receivableDebtCode, line.payableDebtCode].filter(Boolean) as string[]);
}

/** Đã có nhà hàng hoàn tiền thì số liệu do phiếu thu/chi quyết định — không cho sửa/xoá ngầm. */
async function reallocationHasSettlement(reallocation: ExistingReallocation) {
  const debtCodes = reallocationDebtCodes(reallocation);
  if (debtCodes.length === 0) return false;
  return (await prisma.debtSettlement.count({ where: { debt: { code: { in: debtCodes } } } })) > 0;
}

/** Gỡ hết bút toán và công nợ nội bộ của phiếu (xoá thật — mã bút toán/công nợ là unique). */
async function unpostReallocation(tx: RawTxClient, reallocation: ExistingReallocation) {
  await tx.journalEntry.deleteMany({ where: { sourceType: "COST_REALLOCATION", sourceId: reallocation.id } });
  await tx.journalEntry.deleteMany({ where: { sourceType: "COST_REALLOCATION_LINE", sourceId: { in: reallocation.lines.map((line) => line.id) } } });
  const debtCodes = reallocationDebtCodes(reallocation);
  if (debtCodes.length > 0) await tx.debtRecord.deleteMany({ where: { code: { in: debtCodes } } });
}

/** Tạo các dòng phân bổ, bút toán ở mọi nhà hàng và công nợ nội bộ hai đầu cho phiếu `reallocationId`. */
async function postReallocation(tx: RawTxClient, reallocationId: string, code: string, plan: ReallocationPlan, createdBy: string) {
  const { fromBranchCode, pnlItemCode, description, documentDate, period, journals, accountIdByCode } = plan;
  const reallocationLines = [];
  for (const line of plan.lines) {
    reallocationLines.push(await tx.costReallocationLine.create({
      data: { reallocationId, toBranchCode: line.toBranchCode, amount: line.amount, note: line.note },
    }));
  }

  // Bút toán ở nhà hàng đã trả: giảm chi phí, ghi phải thu nội bộ.
  const fromJournal = journals[0];
  await tx.journalEntry.create({
    data: {
      code: `JE-${code}-${fromBranchCode}`,
      entryDate: documentDate,
      period,
      branchCode: fromBranchCode,
      sourceType: "COST_REALLOCATION",
      sourceId: reallocationId,
      sourceCode: code,
      description: `${description} — ${fromJournal.description}`,
      status: "POSTED",
      createdBy,
      lines: {
        create: fromJournal.lines.map((line) => ({
          accountId: accountIdByCode.get(line.accountCode) as string,
          debit: line.debit,
          credit: line.credit,
          pnlItemCode: line.pnlItemCode || null,
          partnerCode: line.partnerCode || null,
          description: code,
        })),
      },
    },
  });

  const fromPartner = await ensureInternalPartner(tx as unknown as typeof prisma, fromBranchCode);
  for (const [index, line] of reallocationLines.entries()) {
    const journal = journals[index + 1];
    await tx.journalEntry.create({
      data: {
        code: `JE-${code}-${line.toBranchCode}`,
        entryDate: documentDate,
        period,
        branchCode: line.toBranchCode,
        sourceType: "COST_REALLOCATION_LINE",
        sourceId: line.id,
        sourceCode: code,
        description: `${description} — ${journal.description}`,
        status: "POSTED",
        createdBy,
        lines: {
          create: journal.lines.map((row) => ({
            accountId: accountIdByCode.get(row.accountCode) as string,
            debit: row.debit,
            credit: row.credit,
            pnlItemCode: row.pnlItemCode || null,
            partnerCode: row.partnerCode || null,
            description: code,
          })),
        },
      },
    });

    // Công nợ nội bộ hai đầu: nhà hàng đã trả có khoản phải thu, nhà hàng nhận có khoản
    // phải trả. Khi hoàn tiền, phiếu thu/chi gạch thẳng vào hai mã này.
    const toPartner = await ensureInternalPartner(tx as unknown as typeof prisma, line.toBranchCode);
    const receivable = await tx.debtRecord.create({
      data: {
        code: `${code}-PT-${line.toBranchCode}`,
        debtType: "RECEIVABLE",
        partnerGroup: "INTERNAL",
        partnerCode: toPartner.code,
        partnerName: toPartner.name,
        branchCode: fromBranchCode,
        documentDate,
        pnlItemCode,
        originalAmount: line.amount,
        outstandingAmount: line.amount,
        description: `${line.toBranchCode} hoàn lại chi phí phân bổ theo ${code}`,
        sourceType: "COST_REALLOCATION",
        sourceId: reallocationId,
        status: "OPEN",
      },
    });
    const payable = await tx.debtRecord.create({
      data: {
        code: `${code}-PTR-${line.toBranchCode}`,
        debtType: "PAYABLE",
        partnerGroup: "INTERNAL",
        partnerCode: fromPartner.code,
        partnerName: fromPartner.name,
        branchCode: line.toBranchCode,
        documentDate,
        pnlItemCode,
        originalAmount: line.amount,
        outstandingAmount: line.amount,
        description: `Hoàn lại ${fromBranchCode} chi phí đã trả hộ theo ${code}`,
        sourceType: "COST_REALLOCATION",
        sourceId: reallocationId,
        status: "OPEN",
      },
    });
    await tx.costReallocationLine.update({
      where: { id: line.id },
      data: { receivableDebtCode: receivable.code, payableDebtCode: payable.code },
    });
  }
}

export async function POST(request: Request) {
  try {
    const auth = requireMenuAction(request, "/cost-reallocations", "create");
    if (!auth.ok) return auth.response;
    const planned = await planReallocation(auth.session, parseReallocationBody(await request.json()), null);
    if (!planned.ok) return planned.response;
    const { plan } = planned;

    const created = await prismaRaw.$transaction(async (tx) => {
      const code = await nextReallocationCode(tx, plan.period);
      const reallocation = await tx.costReallocation.create({
        data: {
          code,
          documentDate: plan.documentDate,
          period: plan.period,
          fromBranchCode: plan.fromBranchCode,
          pnlItemCode: plan.pnlItemCode,
          description: plan.description,
          totalAmount: plan.totalAmount,
          status: "POSTED",
          createdBy: auth.session.name,
        },
      });
      await postReallocation(tx, reallocation.id, code, plan, auth.session.name);
      return tx.costReallocation.findUniqueOrThrow({ where: { id: reallocation.id }, include: { lines: true } });
    });

    await writeAuditLog({
      session: auth.session,
      module: "COST_REALLOCATIONS",
      action: "CREATE",
      entityType: "CostReallocation",
      entityId: created.id,
      entityCode: created.code,
      branchCode: plan.fromBranchCode,
      metadata: { fromBranchCode: plan.fromBranchCode, pnlItemCode: plan.pnlItemCode, totalAmount: plan.totalAmount, branches: plan.lines.map((line) => line.toBranchCode) },
    });
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    console.error("Error creating cost reallocation:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

/**
 * Sửa phiếu = gỡ toàn bộ bút toán + công nợ nội bộ cũ rồi ghi lại theo nội dung mới, trong
 * cùng một transaction. Giữ nguyên id; giữ mã phiếu nếu vẫn cùng kỳ, đổi sang kỳ khác thì cấp
 * mã mới của kỳ đó để mã PBCP-YYYYMM không nói sai tháng.
 */
export async function PUT(request: Request) {
  try {
    const auth = requireMenuAction(request, "/cost-reallocations", "edit");
    if (!auth.ok) return auth.response;
    const body = await request.json();
    const id = cleanText(body.id);
    if (!id) return badRequest("Thiếu ID phiếu phân bổ");

    const current = await prisma.costReallocation.findFirst({ where: { id, deletedAt: null }, include: { lines: true } });
    if (!current) return badRequest("Không tìm thấy phiếu phân bổ", 404);

    // Phiếu cũ cũng bị gỡ khỏi sổ nên quyền và kỳ khoá của mọi nhà hàng cũ phải kiểm như khi xoá.
    for (const branch of [current.fromBranchCode, ...current.lines.map((line) => line.toBranchCode)]) {
      try {
        assertBranchAccess(auth.session, branch);
      } catch (e) {
        return badRequest(e instanceof Error ? e.message : "Không có quyền chi nhánh", 403);
      }
      if (await isPeriodLocked(current.documentDate, branch)) {
        return badRequest(`Kỳ kế toán của ${branch} đã khóa, không thể sửa phiếu`);
      }
    }
    if (await reallocationHasSettlement(current)) {
      return badRequest("Công nợ nội bộ của phiếu đã có thanh toán, không thể sửa. Hãy hoàn tác phiếu thu/chi trước.");
    }

    const planned = await planReallocation(auth.session, parseReallocationBody(body), current);
    if (!planned.ok) return planned.response;
    const { plan } = planned;

    const updated = await prismaRaw.$transaction(async (tx) => {
      await unpostReallocation(tx, current);
      await tx.costReallocationLine.deleteMany({ where: { reallocationId: current.id } });
      const code = plan.period === current.period ? current.code : await nextReallocationCode(tx, plan.period);
      await tx.costReallocation.update({
        where: { id: current.id },
        data: {
          code,
          documentDate: plan.documentDate,
          period: plan.period,
          fromBranchCode: plan.fromBranchCode,
          pnlItemCode: plan.pnlItemCode,
          description: plan.description,
          totalAmount: plan.totalAmount,
        },
      });
      await postReallocation(tx, current.id, code, plan, auth.session.name);
      return tx.costReallocation.findUniqueOrThrow({ where: { id: current.id }, include: { lines: true } });
    });

    await writeAuditLog({
      session: auth.session,
      module: "COST_REALLOCATIONS",
      action: "UPDATE",
      entityType: "CostReallocation",
      entityId: updated.id,
      entityCode: updated.code,
      branchCode: plan.fromBranchCode,
      metadata: {
        before: {
          code: current.code,
          documentDate: current.documentDate,
          fromBranchCode: current.fromBranchCode,
          pnlItemCode: current.pnlItemCode,
          description: current.description,
          totalAmount: current.totalAmount,
          lines: current.lines.map((line) => ({ toBranchCode: line.toBranchCode, amount: line.amount, note: line.note })),
        },
        after: {
          code: updated.code,
          documentDate: plan.documentDate,
          fromBranchCode: plan.fromBranchCode,
          pnlItemCode: plan.pnlItemCode,
          description: plan.description,
          totalAmount: plan.totalAmount,
          lines: plan.lines,
        },
      },
    });
    return NextResponse.json(updated);
  } catch (error) {
    console.error("Error updating cost reallocation:", error);
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

    if (await reallocationHasSettlement(current)) {
      return NextResponse.json(
        { error: "Công nợ nội bộ của phiếu đã có thanh toán, không thể xoá. Hãy hoàn tác phiếu thu/chi trước." },
        { status: 400 },
      );
    }

    await prismaRaw.$transaction(async (tx) => {
      await unpostReallocation(tx, current);
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
