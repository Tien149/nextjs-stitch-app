import { NextResponse } from "next/server";
import { prismaDateRange } from "@/lib/date-range";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { prisma, prismaRaw, type RawTxClient } from "@/lib/prisma";
import type { DemoSession } from "@/lib/auth-demo";
import { assertBranchAccess, branchFilterForSession, ensureDefaultAccounts } from "@/lib/accounting";
import { cleanText, isPeriodLocked, periodFromDate, toDate, toNumber } from "@/lib/phase3";
import { writeAuditLog } from "@/lib/audit-log";
import { nextSeqFromCodes } from "@/lib/voucher-code-generator";
import { journalIsBalanced, type PlannedJournal } from "@/lib/cost-reallocation";
import { money } from "@/lib/format-number";
import { findExpenseForPnlItem, postedExpenseForPnlItem } from "@/lib/expense-summary";
import { availableForPnlReclassEdit, planPnlReclassJournal, validatePnlReclass } from "@/lib/pnl-reclassification";

/**
 * Phiếu điều chỉnh hạng mục P&L trong một nhà hàng (khách 30/10/2026) — lib/pnl-reclassification.ts.
 * Nằm chung menu Chia sẻ chi phí nội bộ nên dùng quyền của menu đó.
 */
const MENU = "/cost-reallocations";
const SOURCE_TYPE = "PNL_RECLASS";

type ParsedReclass = {
  branchCode: string;
  fromPnlItemCode: string;
  toPnlItemCode: string;
  amount: number;
  description: string;
  documentDate: Date;
};
type ReclassRecord = NonNullable<Awaited<ReturnType<typeof prisma.pnlReclassification.findFirst>>>;

const badRequest = (error: string, status = 400) => NextResponse.json({ error }, { status });

function parseBody(body: Record<string, unknown>): ParsedReclass {
  return {
    branchCode: cleanText(body.branchCode).toUpperCase(),
    fromPnlItemCode: cleanText(body.fromPnlItemCode).toUpperCase(),
    toPnlItemCode: cleanText(body.toPnlItemCode).toUpperCase(),
    amount: toNumber(body.amount),
    description: cleanText(body.description),
    documentDate: toDate(body.documentDate),
  };
}

/** Kiểm tra + dựng bút toán, dùng chung cho lập mới và sửa (`current` = phiếu đang sửa). */
async function planReclass(session: DemoSession, input: ParsedReclass, current: ReclassRecord | null) {
  const fail = (error: string, status = 400) => ({ ok: false as const, response: badRequest(error, status) });
  const errors = validatePnlReclass(input);
  if (!input.description) errors.push("Thiếu lý do / diễn giải");
  if (errors.length > 0) return fail(errors[0]);
  try {
    assertBranchAccess(session, input.branchCode);
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Không có quyền chi nhánh", 403);
  }
  if (await isPeriodLocked(input.documentDate, input.branchCode)) return fail(`Kỳ kế toán của ${input.branchCode} đã khóa, không điều chỉnh vào kỳ này được`);
  const branch = await prisma.masterDataItem.findFirst({ where: { type: "BRANCH", code: input.branchCode, status: "ACTIVE", deletedAt: null }, select: { code: true } });
  if (!branch) return fail(`Nhà hàng [${input.branchCode}] không tồn tại hoặc đã ngừng hoạt động`);

  const items = await prisma.masterDataItem.findMany({
    where: { type: "PNL_ITEM", code: { in: [input.fromPnlItemCode, input.toPnlItemCode] }, status: "ACTIVE", deletedAt: null },
    select: { code: true, name: true, group: true },
  });
  const fromItem = items.find((item) => item.code === input.fromPnlItemCode);
  const toItem = items.find((item) => item.code === input.toPnlItemCode);
  if (!fromItem) return fail(`Hạng mục P&L [${input.fromPnlItemCode}] không tồn tại hoặc đã ngừng hoạt động`);
  if (!toItem) return fail(`Hạng mục P&L [${input.toPnlItemCode}] không tồn tại hoặc đã ngừng hoạt động`);

  const journal = planPnlReclassJournal(input, { from: fromItem.group, to: toItem.group });
  if (!journalIsBalanced(journal)) return fail("Bút toán không cân, không ghi sổ được");
  const accounts = await ensureDefaultAccounts();
  const accountIdByCode = new Map(accounts.map((row) => [row.code, row.id]));
  const missing = journal.lines.find((line) => !accountIdByCode.has(line.accountCode));
  if (missing) return fail(`Thiếu tài khoản kế toán ${missing.accountCode}`);

  // Chỉ dời được chi phí ĐANG CÓ trên sổ của hạng mục A trong đúng kỳ, đúng nhà hàng — dời quá thì A âm
  // mà không ai thấy (cùng luật chặn của Chia sẻ chi phí nội bộ).
  const period = periodFromDate(input.documentDate);
  const postedAmount = availableForPnlReclassEdit({
    postedAmount: await postedExpenseForPnlItem(period, input.branchCode, input.fromPnlItemCode),
    next: { period, branchCode: input.branchCode, fromPnlItemCode: input.fromPnlItemCode },
    current,
  });
  if (input.amount > postedAmount + 0.5) {
    const where = await findExpenseForPnlItem(period, input.branchCode, input.fromPnlItemCode);
    const hints = [
      where.otherPeriods.length ? `Chi phí hạng mục này đang nằm ở kỳ: ${where.otherPeriods.map((row) => `${row.period} (${money(row.amount)} đ)`).join(", ")} — sửa Ngày chứng từ về đúng kỳ.` : "",
      where.notPostedVouchers.length ? `Có ${money(where.notPostedTotal)} đ ở phiếu chi chưa vào sổ (${where.notPostedVouchers.slice(0, 5).map((row) => row.code).join(", ")}) — Đồng bộ ghi sổ kỳ này trước.` : "",
    ].filter(Boolean);
    return fail(`Kỳ ${period} ở ${input.branchCode} hạng mục "${fromItem.name}" chỉ có ${money(Math.max(0, postedAmount))} đ chi phí, không đủ để chuyển ${money(input.amount)} đ. ${hints.join(" ")}`.trim());
  }
  return { ok: true as const, plan: { ...input, period, journal, accountIdByCode } };
}

async function nextCode(tx: RawTxClient, period: string) {
  const prefix = `DCHM-${period.replace("-", "")}-`;
  const issued = await tx.pnlReclassification.findMany({ where: { code: { startsWith: prefix } }, select: { code: true } });
  return prefix + String(nextSeqFromCodes(issued.map((row) => row.code), prefix)).padStart(4, "0");
}

async function postJournal(tx: RawTxClient, id: string, code: string, plan: ParsedReclass & { period: string; journal: PlannedJournal; accountIdByCode: Map<string, string> }, createdBy: string) {
  await tx.journalEntry.create({
    data: {
      code: `JE-${code}`,
      entryDate: plan.documentDate,
      period: plan.period,
      branchCode: plan.branchCode,
      sourceType: SOURCE_TYPE,
      sourceId: id,
      sourceCode: code,
      description: `${plan.description} — ${plan.journal.description}`,
      status: "POSTED",
      createdBy,
      lines: {
        create: plan.journal.lines.map((line) => ({
          accountId: plan.accountIdByCode.get(line.accountCode) as string,
          debit: line.debit,
          credit: line.credit,
          pnlItemCode: line.pnlItemCode || null,
          description: code,
        })),
      },
    },
  });
}

/** Gỡ bút toán của phiếu (xoá thật — mã bút toán là unique). */
async function unpostJournal(tx: RawTxClient, id: string) {
  await tx.journalEntry.deleteMany({ where: { sourceType: SOURCE_TYPE, sourceId: id } });
}

export async function GET(request: Request) {
  try {
    const auth = requireMenuAccess(request, MENU);
    if (!auth.ok) return auth.response;
    const { searchParams } = new URL(request.url);
    const documentDate = prismaDateRange({ from: searchParams.get("from"), to: searchParams.get("to") });
    const branchFilter = branchFilterForSession(auth.session, searchParams.get("branchCode") || "ALL");
    const rows = await prisma.pnlReclassification.findMany({
      where: {
        deletedAt: null,
        ...(documentDate ? { documentDate } : {}),
        ...(branchFilter.branchCode ? { branchCode: branchFilter.branchCode } : {}),
      },
      orderBy: [{ documentDate: "desc" }, { createdAt: "desc" }],
      take: 2000,
    });
    return NextResponse.json(rows);
  } catch (error) {
    console.error("Error fetching P&L reclassifications:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const auth = requireMenuAction(request, MENU, "create");
    if (!auth.ok) return auth.response;
    const planned = await planReclass(auth.session, parseBody(await request.json()), null);
    if (!planned.ok) return planned.response;
    const { plan } = planned;
    const created = await prismaRaw.$transaction(async (tx) => {
      const code = await nextCode(tx, plan.period);
      const record = await tx.pnlReclassification.create({
        data: {
          code, documentDate: plan.documentDate, period: plan.period, branchCode: plan.branchCode,
          fromPnlItemCode: plan.fromPnlItemCode, toPnlItemCode: plan.toPnlItemCode, amount: plan.amount,
          description: plan.description, status: "POSTED", createdBy: auth.session.name,
        },
      });
      await postJournal(tx, record.id, code, plan, auth.session.name);
      return record;
    });
    await writeAuditLog({
      session: auth.session, module: "PNL_RECLASSIFICATIONS", action: "CREATE", entityType: "PnlReclassification",
      entityId: created.id, entityCode: created.code, branchCode: created.branchCode,
      metadata: { from: created.fromPnlItemCode, to: created.toPnlItemCode, amount: created.amount, period: created.period },
    });
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    console.error("Error creating P&L reclassification:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

/** Sửa = gỡ bút toán cũ rồi ghi lại; đổi sang kỳ khác thì cấp mã mới của kỳ đó. */
export async function PUT(request: Request) {
  try {
    const auth = requireMenuAction(request, MENU, "edit");
    if (!auth.ok) return auth.response;
    const body = await request.json();
    const current = await prisma.pnlReclassification.findFirst({ where: { id: cleanText(body.id), deletedAt: null } });
    if (!current) return badRequest("Không tìm thấy phiếu điều chỉnh", 404);
    try {
      assertBranchAccess(auth.session, current.branchCode);
    } catch (e) {
      return badRequest(e instanceof Error ? e.message : "Không có quyền chi nhánh", 403);
    }
    if (await isPeriodLocked(current.documentDate, current.branchCode)) return badRequest(`Kỳ kế toán của ${current.branchCode} đã khóa, không sửa phiếu được`);
    const planned = await planReclass(auth.session, parseBody(body), current);
    if (!planned.ok) return planned.response;
    const { plan } = planned;
    const updated = await prismaRaw.$transaction(async (tx) => {
      await unpostJournal(tx, current.id);
      const code = plan.period === current.period ? current.code : await nextCode(tx, plan.period);
      const record = await tx.pnlReclassification.update({
        where: { id: current.id },
        data: {
          code, documentDate: plan.documentDate, period: plan.period, branchCode: plan.branchCode,
          fromPnlItemCode: plan.fromPnlItemCode, toPnlItemCode: plan.toPnlItemCode, amount: plan.amount, description: plan.description,
        },
      });
      await postJournal(tx, record.id, code, plan, auth.session.name);
      return record;
    });
    await writeAuditLog({
      session: auth.session, module: "PNL_RECLASSIFICATIONS", action: "UPDATE", entityType: "PnlReclassification",
      entityId: updated.id, entityCode: updated.code, branchCode: updated.branchCode,
      metadata: {
        before: { code: current.code, documentDate: current.documentDate, branchCode: current.branchCode, from: current.fromPnlItemCode, to: current.toPnlItemCode, amount: current.amount, description: current.description },
        after: { code: updated.code, documentDate: updated.documentDate, branchCode: updated.branchCode, from: updated.fromPnlItemCode, to: updated.toPnlItemCode, amount: updated.amount, description: updated.description },
      },
    });
    return NextResponse.json(updated);
  } catch (error) {
    console.error("Error updating P&L reclassification:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const auth = requireMenuAction(request, MENU, "delete");
    if (!auth.ok) return auth.response;
    const id = cleanText(new URL(request.url).searchParams.get("id"));
    const current = await prisma.pnlReclassification.findFirst({ where: { id, deletedAt: null } });
    if (!current) return badRequest("Không tìm thấy phiếu điều chỉnh", 404);
    try {
      assertBranchAccess(auth.session, current.branchCode);
    } catch (e) {
      return badRequest(e instanceof Error ? e.message : "Không có quyền chi nhánh", 403);
    }
    if (await isPeriodLocked(current.documentDate, current.branchCode)) return badRequest(`Kỳ kế toán của ${current.branchCode} đã khóa, không xoá phiếu được`);
    await prismaRaw.$transaction(async (tx) => {
      await unpostJournal(tx, current.id);
      await tx.pnlReclassification.update({ where: { id: current.id }, data: { deletedAt: new Date(), deletedBy: auth.session.name, status: "CANCELLED" } });
    });
    await writeAuditLog({
      session: auth.session, module: "PNL_RECLASSIFICATIONS", action: "DELETE", entityType: "PnlReclassification",
      entityId: current.id, entityCode: current.code, branchCode: current.branchCode, metadata: { amount: current.amount },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Error deleting P&L reclassification:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
