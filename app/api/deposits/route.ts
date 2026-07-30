import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { assertBranchAccess, branchFilterForSession } from "@/lib/accounting";
import { prisma } from "@/lib/prisma";
import { generateFormattedVoucherCode } from "@/lib/voucher-code-generator";
import { isPeriodLocked } from "@/lib/phase3";
import { writeAuditLog } from "@/lib/audit-log";
import { duplicatedInTrashMessage, findDeletedByUnique, softDeleteRecord, SoftDeleteError } from "@/lib/soft-delete";
import type { DemoSession } from "@/lib/auth-demo";
import { moneySourceMatchesBranch } from "@/lib/money-sources";

/**
 * Lịch sử không tính là phát sinh xử lý cọc:
 * - CREATE/COLLECT: ghi nhận ban đầu.
 * - UPDATE: chỉ là vết chỉnh sửa thông tin, không đụng tới số dư nên không
 *   được phép khoá luôn quyền sửa/xoá phiếu về sau.
 */
const initialDepositActions = ["CREATE", "COLLECT", "UPDATE"];

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function toAmount(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function toDate(value: unknown, fallback = new Date()) {
  if (!value) return fallback;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? fallback : date;
}

async function nextDepositCode(voucherDate?: Date | string | null, branchCode?: string | null) {
  const d = voucherDate ? new Date(voucherDate) : new Date();
  const validDate = isNaN(d.getTime()) ? new Date() : d;
  const startOfMonth = new Date(validDate.getFullYear(), validDate.getMonth(), 1);
  const endOfMonth = new Date(validDate.getFullYear(), validDate.getMonth() + 1, 1);

  const count = await prisma.deposit.count({
    where: {
      ...(branchCode ? { branchCode } : {}),
      receivedDate: { gte: startOfMonth, lt: endOfMonth },
      code: { startsWith: "PCOC" },
    },
  });

  return generateFormattedVoucherCode({
    voucherType: "PCOC",
    voucherDate: validDate,
    branchCode,
    seqNumber: count + 1,
  });
}

export async function GET(request: Request) {
  try {
    const auth = requireMenuAccess(request, "/deposits");
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status") || undefined;
    const search = searchParams.get("search")?.trim();
    const branchFilter = branchFilterForSession(auth.session, searchParams.get("branchCode") || "ALL");

    const deposits = await prisma.deposit.findMany({
      where: {
        ...branchFilter,
        ...(status && status !== "ALL" ? { status } : {}),
        ...(search
          ? {
              OR: [
                { code: { contains: search } },
                { partnerCode: { contains: search } },
                { partnerName: { contains: search } },
                { purpose: { contains: search } },
              ],
            }
          : {}),
      },
      include: {
        histories: {
          orderBy: { createdAt: "desc" },
        },
      },
      orderBy: { receivedDate: "desc" },
    });

    return NextResponse.json(deposits);
  } catch (error) {
    console.error("Error fetching deposits:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const auth = requireMenuAction(request, "/deposits", "create");
    if (!auth.ok) return auth.response;

    const body = await request.json();
    const partnerCode = cleanText(body.partnerCode);
    const partnerName = cleanText(body.partnerName);
    const branchCode = cleanText(body.branchCode);
    const moneySourceCode = cleanText(body.moneySourceCode);
    const purpose = cleanText(body.purpose);
    const amount = toAmount(body.amount);

    if (!partnerCode || !partnerName || !branchCode || !moneySourceCode || !purpose || amount <= 0) {
      return NextResponse.json(
        { error: "Thiếu khách hàng, chi nhánh, nguồn tiền, nội dung hoặc số tiền không hợp lệ" },
        { status: 400 },
      );
    }

    try {
      assertBranchAccess(auth.session, branchCode);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Không có quyền chi nhánh" }, { status: 403 });
    }

    // Verify master data status
    const activeBranch = await prisma.masterDataItem.findUnique({
      where: { type_code: { type: "BRANCH", code: branchCode } }
    });
    if (!activeBranch || activeBranch.status !== "ACTIVE") {
      return NextResponse.json({ error: `Cửa hàng [${branchCode}] không tồn tại hoặc ngưng hoạt động` }, { status: 400 });
    }

    const activePartner = await prisma.masterDataItem.findUnique({
      where: { type_code: { type: "PARTNER", code: partnerCode } }
    });
    if (!activePartner || activePartner.status !== "ACTIVE") {
      return NextResponse.json({ error: `Khách hàng [${partnerCode}] không tồn tại hoặc ngưng hoạt động` }, { status: 400 });
    }

    const activeSource = await prisma.masterDataItem.findUnique({
      where: { type_code: { type: "MONEY_SOURCE", code: moneySourceCode } }
    });
    if (!activeSource || activeSource.status !== "ACTIVE" || !moneySourceMatchesBranch(activeSource, branchCode)) {
      return NextResponse.json({ error: `Nguồn tiền [${moneySourceCode}] không tồn tại, ngưng hoạt động hoặc không thuộc cửa hàng đã chọn` }, { status: 400 });
    }

    const receivedDate = toDate(body.receivedDate);
    const code = await nextDepositCode(receivedDate, branchCode);

    // Mã sinh tự động có thể trùng với phiếu cọc đang nằm trong thùng rác -> báo rõ để xử lý.
    const trashedDeposit = await findDeletedByUnique("Deposit", { code });
    if (trashedDeposit) {
      return NextResponse.json({ error: duplicatedInTrashMessage(code, "Phiếu cọc") }, { status: 400 });
    }

    const deposit = await prisma.deposit.create({
      data: {
        code,
        receivedDate,
        partnerCode,
        partnerName,
        branchCode,
        moneySourceCode,
        amount,
        remainingAmount: amount,
        purpose,
        note: cleanText(body.note) || null,
        histories: {
          create: {
            action: "CREATE",
            amount,
            actionDate: receivedDate,
            treatmentNote: "Ghi nhận tiền cọc",
            actor: auth.session.name,
            note: "Ghi nhan tien coc",
          },
        },
      },
      include: { histories: true },
    });

    return NextResponse.json(deposit, { status: 201 });
  } catch (error) {
    console.error("Error creating deposit:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

type DepositRecord = NonNullable<Awaited<ReturnType<typeof prisma.deposit.findUnique>>>;

/**
 * Sửa thông tin nghiệp vụ của phiếu cọc còn đang giữ tiền.
 * Trường nào không gửi lên thì giữ nguyên giá trị cũ.
 */
async function updateDeposit(session: DemoSession, current: DepositRecord, body: Record<string, unknown>) {
  if (current.status !== "HOLDING") {
    return NextResponse.json(
      { error: "Phiếu cọc đã cấn trừ/hoàn/hủy, không thể sửa. Hãy lập phiếu cọc mới." },
      { status: 400 },
    );
  }

  const partnerCode = body.partnerCode === undefined ? current.partnerCode : cleanText(body.partnerCode);
  const partnerName = body.partnerName === undefined ? current.partnerName : cleanText(body.partnerName);
  const branchCode = body.branchCode === undefined ? current.branchCode : cleanText(body.branchCode);
  const moneySourceCode = body.moneySourceCode === undefined ? current.moneySourceCode : cleanText(body.moneySourceCode);
  const purpose = body.purpose === undefined ? current.purpose : cleanText(body.purpose);
  const note = body.note === undefined ? current.note : cleanText(body.note) || null;
  const amount = body.amount === undefined ? current.amount : toAmount(body.amount);
  const receivedDate = body.receivedDate === undefined ? current.receivedDate : toDate(body.receivedDate, current.receivedDate);

  if (!partnerCode || !partnerName || !branchCode || !moneySourceCode || !purpose || amount <= 0) {
    return NextResponse.json(
      { error: "Thiếu khách hàng, chi nhánh, nguồn tiền, nội dung hoặc số tiền không hợp lệ" },
      { status: 400 },
    );
  }

  try {
    assertBranchAccess(session, branchCode);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Không có quyền chi nhánh" }, { status: 403 });
  }

  // Đã phát sinh cấn trừ/hoàn/bổ sung hoặc sinh từ chứng từ thu/chi thì số tiền
  // do các nghiệp vụ đó quyết định, sửa tay sẽ lệch số liệu.
  const [processedHistoryCount, linkedVoucherCount] = await Promise.all([
    prisma.depositHistory.count({ where: { depositId: current.id, action: { notIn: initialDepositActions } } }),
    prisma.depositHistory.count({ where: { depositId: current.id, voucherId: { not: null } } }),
  ]);
  const processed = processedHistoryCount > 0 || linkedVoucherCount > 0 || current.remainingAmount !== current.amount;
  if (processed && amount !== current.amount) {
    return NextResponse.json(
      { error: "Phiếu cọc đã phát sinh cấn trừ/hoàn cọc hoặc gắn với chứng từ thu/chi, không thể sửa số tiền. Hãy dùng thao tác bổ sung hoặc cấn trừ." },
      { status: 400 },
    );
  }

  const activeSource = await prisma.masterDataItem.findUnique({
    where: { type_code: { type: "MONEY_SOURCE", code: moneySourceCode } },
  });
  if (!activeSource || activeSource.status !== "ACTIVE" || !moneySourceMatchesBranch(activeSource, branchCode)) {
    return NextResponse.json({ error: `Nguồn tiền [${moneySourceCode}] không tồn tại, ngưng hoạt động hoặc không thuộc cửa hàng đã chọn` }, { status: 400 });
  }

  const [currentPeriodLocked, nextPeriodLocked] = await Promise.all([
    isPeriodLocked(current.receivedDate, current.branchCode),
    isPeriodLocked(receivedDate, branchCode),
  ]);
  if (currentPeriodLocked || nextPeriodLocked) {
    return NextResponse.json({ error: "Kỳ kế toán đã khóa, không thể sửa phiếu cọc" }, { status: 400 });
  }

  const deposit = await prisma.deposit.update({
    where: { id: current.id },
    data: {
      receivedDate,
      partnerCode,
      partnerName,
      branchCode,
      moneySourceCode,
      amount,
      // Chưa phát sinh xử lý nên số dư cọc luôn bằng số tiền cọc.
      ...(amount !== current.amount ? { remainingAmount: amount } : {}),
      purpose,
      note,
      histories: {
        create: {
          action: "UPDATE",
          amount: null,
          actionDate: new Date(),
          treatmentNote: "Sửa thông tin phiếu cọc",
          actor: session.name,
          note,
        },
      },
    },
    include: {
      histories: {
        orderBy: { createdAt: "desc" },
      },
    },
  });

  await writeAuditLog({
    session,
    module: "DEPOSITS",
    action: "UPDATE",
    entityType: "Deposit",
    entityId: deposit.id,
    entityCode: deposit.code,
    branchCode: deposit.branchCode,
    metadata: {
      before: { receivedDate: current.receivedDate, partnerCode: current.partnerCode, partnerName: current.partnerName, branchCode: current.branchCode, moneySourceCode: current.moneySourceCode, amount: current.amount, purpose: current.purpose, note: current.note },
      after: { receivedDate, partnerCode, partnerName, branchCode, moneySourceCode, amount, purpose, note },
    },
  });

  return NextResponse.json(deposit);
}

export async function PATCH(request: Request) {
  try {
    const auth = requireMenuAction(request, "/deposits", "edit");
    if (!auth.ok) return auth.response;

    const body = await request.json();
    const id = cleanText(body.id);
    const action = cleanText(body.action);
    const actionAmount = toAmount(body.amount);
    const note = cleanText(body.note) || null;
    const actionDate = toDate(body.actionDate);
    const treatmentNote = cleanText(body.treatmentNote) || note;

    if (!id || !action) {
      return NextResponse.json({ error: "Thieu ID hoac thao tac xu ly" }, { status: 400 });
    }

    const current = await prisma.deposit.findUnique({ where: { id } });
    if (!current) {
      return NextResponse.json({ error: "Khong tim thay phieu coc" }, { status: 404 });
    }

    if (current.remainingAmount <= 0 && action !== "SUPPLEMENT" && action !== "UPDATE") {
      return NextResponse.json({ error: "Phieu coc da het so du xu ly" }, { status: 400 });
    }

    try {
      assertBranchAccess(auth.session, current.branchCode);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Không có quyền chi nhánh" }, { status: 403 });
    }

    if (action === "UPDATE") return await updateDeposit(auth.session, current, body);

    let status = current.status;
    let remainingAmount = current.remainingAmount;
    let historyAmount: number | null = null;

    if (action === "SUPPLEMENT") {
      if (actionAmount <= 0) {
        return NextResponse.json({ error: "So tien bo sung coc khong hop le" }, { status: 400 });
      }
      remainingAmount = current.remainingAmount + actionAmount;
      status = "HOLDING";
      historyAmount = actionAmount;
    } else if (action === "OFFSET") {
      if (actionAmount <= 0 || actionAmount > current.remainingAmount) {
        return NextResponse.json({ error: "So tien can tru khong hop le" }, { status: 400 });
      }
      remainingAmount = current.remainingAmount - actionAmount;
      status = remainingAmount === 0 ? "OFFSET" : "HOLDING";
      historyAmount = actionAmount;
    } else if (action === "REFUND") {
      historyAmount = current.remainingAmount;
      remainingAmount = 0;
      status = "REFUNDED";
    } else if (action === "CANCEL") {
      historyAmount = current.remainingAmount;
      remainingAmount = 0;
      status = "CANCELLED";
    } else if (action === "TRANSFER_REVENUE") {
      historyAmount = current.remainingAmount;
      remainingAmount = 0;
      status = "REVENUE";
    } else {
      return NextResponse.json({ error: "Thao tac khong ho tro" }, { status: 400 });
    }

    const deposit = await prisma.deposit.update({
      where: { id },
      data: {
        status,
        remainingAmount,
        ...(action === "SUPPLEMENT" ? { amount: current.amount + actionAmount } : {}),
        histories: {
          create: {
            action,
            amount: historyAmount,
            actionDate,
            treatmentNote,
            actor: auth.session.name,
            note,
          },
        },
      },
      include: {
        histories: {
          orderBy: { createdAt: "desc" },
        },
      },
    });

    return NextResponse.json(deposit);
  } catch (error) {
    console.error("Error updating deposit:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const auth = requireMenuAction(request, "/deposits", "delete");
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const id = cleanText(searchParams.get("id"));
    const reason = cleanText(searchParams.get("reason")) || null;
    if (!id) return NextResponse.json({ error: "Thiếu ID phiếu cọc" }, { status: 400 });

    const current = await prisma.deposit.findUnique({ where: { id } });
    if (!current) return NextResponse.json({ error: "Không tìm thấy phiếu cọc" }, { status: 404 });

    try {
      assertBranchAccess(auth.session, current.branchCode);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Không có quyền chi nhánh" }, { status: 403 });
    }

    // Đã cấn trừ/hoàn/chuyển doanh thu thì phải giữ lại để không mất dấu dòng tiền.
    const [processedHistoryCount, linkedVoucherCount] = await Promise.all([
      prisma.depositHistory.count({ where: { depositId: id, action: { notIn: initialDepositActions } } }),
      prisma.depositHistory.count({ where: { depositId: id, voucherId: { not: null } } }),
    ]);
    if (processedHistoryCount > 0 || current.remainingAmount !== current.amount) {
      return NextResponse.json(
        { error: "Phiếu cọc đã phát sinh cấn trừ/hoàn cọc, không thể xóa. Hãy dùng thao tác hủy phiếu cọc." },
        { status: 400 },
      );
    }
    if (linkedVoucherCount > 0) {
      return NextResponse.json(
        { error: "Phiếu cọc được sinh từ chứng từ thu/chi đã duyệt, không thể xóa. Hãy hủy chứng từ gốc trước." },
        { status: 400 },
      );
    }
    if (current.status !== "HOLDING") {
      return NextResponse.json(
        { error: "Phiếu cọc đã cấn trừ/hoàn/hủy, không thể xóa." },
        { status: 400 },
      );
    }

    if (await isPeriodLocked(current.receivedDate, current.branchCode)) {
      return NextResponse.json({ error: "Kỳ kế toán đã khóa, không thể xóa phiếu cọc" }, { status: 400 });
    }

    await softDeleteRecord({ model: "Deposit", id, session: auth.session, reason });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof SoftDeleteError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Error deleting deposit:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
