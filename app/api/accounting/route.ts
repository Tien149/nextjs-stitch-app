import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { ensureDefaultAccounts, periodBounds, postJournalEntry, requestedBranch, syncAccountingPeriod } from "@/lib/accounting";
import { prisma } from "@/lib/prisma";
import { apiError, assertPeriodOpen, businessError, cleanText, normalizePeriod, toDate, toNumber } from "@/lib/phase3";
import { moneySourceAccountCode, moneySourceMatchesBranch } from "@/lib/money-sources";
import { normalizeCashflowCategoryType } from "@/lib/voucher-rules";
import { writeAuditLog } from "@/lib/audit-log";

const menuHref = "/accounting";

type ManualEntryLine = {
  accountCode: string;
  debit?: number;
  credit?: number;
  departmentCode?: string | null;
  categoryCode?: string | null;
  description?: string | null;
};

/**
 * Dựng hai vế Nợ/Có của bút toán tay từ dữ liệu người dùng khai trên form.
 *
 * `fallbackCashAccount` dành riêng cho lúc SỬA: tài khoản tiền của bút toán cũ. Sổ cái chỉ lưu
 * mã tài khoản (1111, 1121...) chứ không lưu nguồn tiền nào đã sinh ra nó, nên không đọc ngược
 * ra được nguồn tiền. Người sửa không đổi nguồn tiền thì giữ nguyên tài khoản cũ — chính xác
 * tuyệt đối, thay vì đoán một nguồn tiền cùng tài khoản rồi ghi lệch quỹ.
 */
async function buildManualLines(body: Record<string, unknown>, branchCode: string, description: string, fallbackCashAccount?: string) {
  if (!body.entryType || !body.amount) {
    const rawLines = Array.isArray(body.lines) ? body.lines : [];
    if (rawLines.length < 2) businessError("Bút toán tay cần ít nhất hai dòng");
    return rawLines.map((line: Record<string, unknown>) => ({
      accountCode: cleanText(line.accountCode),
      debit: toNumber(line.debit),
      credit: toNumber(line.credit),
      departmentCode: cleanText(line.departmentCode) || null,
      categoryCode: cleanText(line.categoryCode) || null,
      description: cleanText(line.description) || description,
    })) as ManualEntryLine[];
  }

  const amount = toNumber(body.amount);
  const categoryCode = cleanText(body.categoryCode);
  const moneySourceCode = cleanText(body.moneySourceCode);
  const [moneySource, category] = await Promise.all([
    moneySourceCode
      ? prisma.masterDataItem.findFirst({ where: { type: "MONEY_SOURCE", code: moneySourceCode, status: "ACTIVE" } })
      : Promise.resolve(null),
    prisma.masterDataItem.findFirst({ where: { type: "REVENUE_EXPENSE_CATEGORY", code: categoryCode, status: "ACTIVE" } }),
  ]);
  if (moneySourceCode && (!moneySource || !moneySourceMatchesBranch(moneySource, branchCode))) {
    businessError(`Nguồn tiền [${moneySourceCode}] không tồn tại hoặc không thuộc cửa hàng đã chọn`);
  }
  if (!moneySource && !fallbackCashAccount) businessError("Thiếu nguồn tiền cho bút toán tay");
  if (!category) businessError(`Danh mục Thu/Chi [${categoryCode}] không tồn tại hoặc đã ngưng hoạt động`);
  const expectedCategoryType = body.entryType === "INCOME" ? "RECEIPT" : "PAYMENT";
  if (normalizeCashflowCategoryType(category.group) !== expectedCategoryType) {
    businessError(body.entryType === "INCOME"
      ? "Bút toán thu nhập phải chọn danh mục loại Thu"
      : "Bút toán chi phí phải chọn danh mục loại Chi");
  }
  const cashAccount = moneySource ? moneySourceAccountCode(moneySource) : (fallbackCashAccount as string);

  if (body.entryType === "INCOME") {
    return [
      { accountCode: cashAccount, debit: amount, description },
      { accountCode: "511", credit: amount, categoryCode, description },
    ] as ManualEntryLine[];
  }
  return [
    { accountCode: "6428", debit: amount, categoryCode, description },
    { accountCode: cashAccount, credit: amount, description },
  ] as ManualEntryLine[];
}

/** Bút toán tay của người dùng, kèm kiểm tra đúng loại và đúng quyền cửa hàng. */
async function findManualEntry(id: string) {
  if (!id) businessError("Thiếu bút toán cần xử lý");
  const entry = await prisma.journalEntry.findUnique({ where: { id }, include: { lines: { include: { account: true } } } });
  if (!entry) businessError("Không tìm thấy bút toán");
  if (entry.sourceType !== "MANUAL") {
    businessError(`Bút toán ${entry.code} sinh tự động từ ${entry.sourceType}, phải sửa ở chứng từ gốc chứ không sửa thẳng trên sổ cái.`);
  }
  return entry;
}

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
    const auth = requireMenuAction(
      request,
      menuHref,
      action === "SYNC_PERIOD" ? "config" : action === "UPDATE_MANUAL" ? "edit" : action === "DELETE_MANUAL" ? "delete" : "create",
    );
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
      // `postJournalEntry` gặp kỳ khoá thì trả "SKIPPED_LOCKED" và đi tiếp — đúng cho nút Đồng
      // bộ ghi sổ hàng loạt, nhưng ở đây là người dùng lập tay một bút toán: im lặng bỏ qua
      // thì màn hình báo tạo thành công trong khi sổ cái không có gì. Chặn thẳng từ đầu.
      await assertPeriodOpen({ date: entryDate, branchCode }, "lập bút toán tay");

      const result = await postJournalEntry({
        entryDate,
        branchCode,
        sourceType: "MANUAL",
        sourceId: crypto.randomUUID(),
        sourceCode: cleanText(body.sourceCode) || null,
        description,
        createdBy: auth.session.name,
        lines: await buildManualLines(body, branchCode, description),
      });
      return NextResponse.json({ status: result }, { status: 201 });
    }

    /**
     * Sửa bút toán tay đã lập.
     *
     * Chỉ đụng được vào bút toán do người dùng tự lập (sourceType MANUAL); bút toán sinh từ
     * phiếu thu/chi, lương, khấu hao... phải sửa ở chứng từ gốc rồi đồng bộ lại, sửa thẳng trên
     * sổ cái sẽ bị lần đồng bộ sau ghi đè.
     *
     * Ghi đè lên đúng `sourceId` cũ nên bút toán giữ nguyên mã JE: `postJournalEntry` thấy đã
     * có bản ghi thì xoá các dòng cũ rồi tạo lại theo số mới.
     */
    if (action === "UPDATE_MANUAL") {
      const entry = await findManualEntry(cleanText(body.entryId) || cleanText(body.id));
      const branchCode = requestedBranch(auth.session, cleanText(body.branchCode) || entry.branchCode);
      const entryDate = body.entryDate === undefined ? entry.entryDate : toDate(body.entryDate);
      const description = cleanText(body.description) || entry.description;
      // Chặn cả kỳ cũ lẫn kỳ mới: chuyển một bút toán RA KHỎI tháng đã chốt cũng là làm đổi số
      // của tháng đó, y như sửa tại chỗ.
      await assertPeriodOpen(
        [{ date: entry.entryDate, branchCode: entry.branchCode }, { date: entryDate, branchCode }],
        "sửa bút toán tay",
      );

      // Vế tiền của bút toán cũ, dùng lại khi người sửa không đổi nguồn tiền.
      const currentCashAccount = entry.lines
        .map((line) => line.account.code)
        .find((code) => !["6428", "511"].includes(code));

      const result = await postJournalEntry({
        entryDate,
        branchCode,
        sourceType: "MANUAL",
        sourceId: entry.sourceId,
        sourceCode: body.sourceCode === undefined ? entry.sourceCode : cleanText(body.sourceCode) || null,
        description,
        createdBy: auth.session.name,
        lines: await buildManualLines(body, branchCode, description, currentCashAccount),
      });
      await writeAuditLog({ session: auth.session, module: menuHref, action: "UPDATE_MANUAL", entityType: "JournalEntry", entityId: entry.id, entityCode: entry.code, branchCode, metadata: { status: result, before: { entryDate: entry.entryDate, description: entry.description, lines: entry.lines.map((line) => ({ account: line.account.code, debit: line.debit, credit: line.credit })) } } });
      return NextResponse.json({ status: result, code: entry.code });
    }

    /** Xoá bút toán tay. Xoá mềm nên vẫn lấy lại được từ Thùng rác nếu bấm nhầm. */
    if (action === "DELETE_MANUAL") {
      const entry = await findManualEntry(cleanText(body.entryId) || cleanText(body.id));
      await assertPeriodOpen({ date: entry.entryDate, branchCode: entry.branchCode }, "xoá bút toán tay");
      await prisma.journalEntry.delete({ where: { id: entry.id } });
      await writeAuditLog({ session: auth.session, module: menuHref, action: "DELETE_MANUAL", entityType: "JournalEntry", entityId: entry.id, entityCode: entry.code, branchCode: entry.branchCode, metadata: { description: entry.description, lines: entry.lines.map((line) => ({ account: line.account.code, debit: line.debit, credit: line.credit })) } });
      return NextResponse.json({ ok: true, code: entry.code });
    }

    businessError("Thao tác sổ cái không hợp lệ");
  } catch (error) {
    const result = apiError(error);
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
}
