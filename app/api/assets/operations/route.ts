import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { prisma, type TxClient } from "@/lib/prisma";
import { apiError, assertPeriodOpen, buildAllocationSchedules, businessError, cleanText, isPeriodLocked, normalizePeriod, toDate, toNumber } from "@/lib/phase3";
import { assertBranchAccess, requestedBranch } from "@/lib/accounting";
import { scopePayloadByTab } from "@/lib/tab-scope";
import { normalizeMoneySourceGroup } from "@/lib/money-sources";
import { writeAuditLog } from "@/lib/audit-log";
import { nextSeqFromCodes, nextYearlyCode, voucherCodePrefix } from "@/lib/voucher-code-generator";

const menuHref = "/assets";

/**
 * Mã phiếu chi theo ĐÚNG định dạng chuẩn của hệ thống (PCHI/UNC-YYMM-CH-#####) và cấp số
 * max + 1 trong chuỗi. Bản cũ tự chế "PC-YYYYMM-###" lệch chuẩn, lại đếm COUNT toàn thời gian
 * nên vừa sai format vừa dễ trùng sau khi có phiếu bị xoá.
 */
async function nextPaymentVoucherCode(tx: TxClient, voucherDate: Date, branchCode: string, documentChannel: string) {
  const prefix = voucherCodePrefix({ voucherType: "PAYMENT", documentChannel, voucherDate, branchCode });
  // Đọc bằng SQL thô để thấy CẢ phiếu đã xoá mềm. Client thường lọc deletedAt nên mã của
  // phiếu nằm trong thùng rác trở nên vô hình, trong khi ràng buộc unique vẫn giữ chỗ — cấp
  // lại đúng mã đó là vỡ "Unique constraint failed on the fields: (code)" giữa transaction.
  const issued = await tx.$queryRaw<Array<{ code: string }>>`SELECT "code" FROM "FinancialVoucher" WHERE "code" LIKE ${prefix + "%"}`;
  return prefix + String(nextSeqFromCodes(issued.map((row) => row.code), prefix)).padStart(5, "0");
}

async function defaultMoneySource(tx: TxClient, branchCode: string) {
  const source = await tx.masterDataItem.findFirst({
    where: { type: "MONEY_SOURCE", status: "ACTIVE", branch: { in: [branchCode, "ALL"] } },
    orderBy: { code: "asc" },
  });
  return source?.code || (branchCode === "HN" ? "POS_HN" : "TM_HCM");
}

async function documentChannelForSource(tx: TxClient, moneySourceCode: string) {
  const source = await tx.masterDataItem.findFirst({
    where: { type: "MONEY_SOURCE", code: moneySourceCode },
    select: { group: true },
  });
  return normalizeMoneySourceGroup(source?.group) === "BANK" ? "BANK" : "CASH";
}

async function nextWorkItemCode(tx: TxClient) {
  return nextYearlyCode(tx.workItem, "CV");
}

function addMonths(date: Date, months: number) {
  const next = new Date(date);
  const targetDay = next.getDate();
  next.setMonth(next.getMonth() + months);
  if (next.getDate() < targetDay) next.setDate(0);
  return next;
}

function maintenanceDates(startDate: Date, rule: string, interval: number, endDate: Date | null) {
  const normalizedRule = rule === "QUARTERLY" || rule === "YEARLY" || rule === "MONTHLY" ? rule : "NONE";
  if (normalizedRule === "NONE") return [startDate];
  const stepMonths = normalizedRule === "YEARLY" ? 12 * interval : normalizedRule === "QUARTERLY" ? 3 * interval : interval;
  const finalDate = endDate || addMonths(startDate, stepMonths * 11);
  const dates: Date[] = [];
  let current = startDate;
  while (current <= finalDate && dates.length < 24) {
    dates.push(new Date(current));
    current = addMonths(current, stepMonths);
  }
  return dates;
}

export async function GET(request: Request) {
  try {
    const auth = requireMenuAccess(request, menuHref);
    if (!auth.ok) return auth.response;
    const { searchParams } = new URL(request.url);
    const branchCode = requestedBranch(auth.session, cleanText(searchParams.get("branchCode")) || "ALL");
    const assetWhere = branchCode === "ALL" ? {} : { branchCode };
    const relatedWhere = branchCode === "ALL" ? {} : { asset: { branchCode } };
    const [assets, depreciations, maintenances, damageReports, assetStocktakes] = await Promise.all([
      prisma.assetRecord.findMany({ where: assetWhere, orderBy: { createdAt: "desc" } }),
      prisma.assetDepreciation.findMany({ where: relatedWhere, include: { asset: true }, orderBy: [{ period: "desc" }, { createdAt: "desc" }], take: 200 }),
      prisma.assetMaintenance.findMany({ where: relatedWhere, include: { asset: true }, orderBy: { scheduledDate: "desc" }, take: 200 }),
      prisma.assetDamageReport.findMany({ where: relatedWhere, include: { asset: true }, orderBy: { reportedDate: "desc" }, take: 200 }),
      prisma.assetStocktakeSession.findMany({ where: branchCode === "ALL" ? {} : { branchCode }, include: { lines: { include: { asset: true } } }, orderBy: { createdAt: "desc" }, take: 20 }),
    ]);
    return NextResponse.json(scopePayloadByTab(auth.session, "/assets/operations", { assets, depreciations, maintenances, damageReports, assetStocktakes }));
  } catch (error) {
    const result = apiError(error);
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const action = cleanText(body.action);
    const requiredAction = ["RUN_DEPRECIATION", "REOPEN_DEPRECIATION", "REOPEN_ASSET_STOCKTAKE", "REOPEN_MAINTENANCE", "REOPEN_DAMAGE", "REOPEN_DISPOSAL", "COMPLETE_MAINTENANCE", "RESOLVE_DAMAGE", "CONFIGURE_DEPRECIATION"].includes(action) ? "edit" : "create";
    const auth = requireMenuAction(request, menuHref, requiredAction);
    if (!auth.ok) return auth.response;

    if (action === "APPROVE_ASSET_STOCKTAKE") {
      const branchCode = cleanText(body.branchCode);
      const stocktakeDate = toDate(body.stocktakeDate);
      const rawLines = Array.isArray(body.lines) ? body.lines as Array<{ assetId?: unknown; systemQuantity?: unknown; actualQuantity?: unknown; condition?: unknown; note?: unknown }> : [];
      const lines = rawLines
        .map((line) => ({
          assetId: cleanText(line.assetId),
          systemQuantity: line.systemQuantity === undefined || line.systemQuantity === null || line.systemQuantity === "" ? null : toNumber(line.systemQuantity),
          actualQuantity: toNumber(line.actualQuantity),
          condition: cleanText(line.condition),
          note: cleanText(line.note),
        }))
        .filter((line) => line.assetId && Number.isFinite(line.actualQuantity) && line.actualQuantity >= 0);
      if (!branchCode || lines.length === 0) businessError("Kiểm kê tài sản cần cửa hàng và ít nhất một dòng");
      assertBranchAccess(auth.session, branchCode);

      const result = await prisma.$transaction(async (tx) => {
        const head = `KKTS-${stocktakeDate.getFullYear()}-`;
        const issued = await tx.$queryRaw<Array<{ code: string }>>`SELECT "code" FROM "AssetStocktakeSession" WHERE "code" LIKE ${head + "%"}`;
        const session = await tx.assetStocktakeSession.create({
          data: {
            code: head + String(nextSeqFromCodes(issued.map((row) => row.code), head)).padStart(4, "0"),
            stocktakeDate,
            branchCode,
            status: "APPROVED",
            note: cleanText(body.note) || null,
            createdBy: auth.session.name,
            approvedBy: auth.session.name,
            approvedAt: new Date(),
          },
        });
        for (const line of lines) {
          const asset = await tx.assetRecord.findUnique({ where: { id: line.assetId } });
          if (!asset) businessError("Không tìm thấy tài sản trong danh sách kiểm kê");
          if (asset.branchCode !== branchCode) businessError(`Tài sản ${asset.code} thuộc cửa hàng ${asset.branchCode}, không thuộc phiên kiểm kê này`);
          // Khoá lạc quan — cùng luật với kiểm kê kho: số sổ sách đổi từ lúc tải danh sách thì
          // bắt tải lại, không âm thầm đè số đếm cũ lên biến động mới.
          if (line.systemQuantity !== null && Math.abs(line.systemQuantity - asset.quantity) > 0.000001) {
            businessError(`Số sổ sách của ${asset.code} đã thay đổi từ lúc tải danh sách (${line.systemQuantity} → ${asset.quantity}). Tải lại danh sách rồi kiểm lại dòng này.`);
          }
          await tx.assetStocktakeLine.create({
            data: {
              sessionId: session.id,
              assetId: asset.id,
              systemQuantity: asset.quantity,
              actualQuantity: line.actualQuantity,
              varianceQuantity: line.actualQuantity - asset.quantity,
              condition: line.condition || null,
              note: line.note || null,
            },
          });
          // Duyệt kiểm kê = số đếm là số chốt.
          await tx.assetRecord.update({ where: { id: asset.id }, data: { quantity: line.actualQuantity } });
        }
        return tx.assetStocktakeSession.findUnique({ where: { id: session.id }, include: { lines: { include: { asset: true } } } });
      });

      await writeAuditLog({ session: auth.session, module: "/assets", action: "APPROVE_ASSET_STOCKTAKE", entityType: "AssetStocktakeSession", entityId: result?.id || null, entityCode: result?.code || null, branchCode, metadata: { lines: lines.length } });
      return NextResponse.json(result, { status: 201 });
    }

    /**
     * Mở lại phiên kiểm kê tài sản đã duyệt.
     *
     * Duyệt kiểm kê ghi thẳng số đếm vào `quantity` của tài sản và không giữ đường lùi: đếm
     * nhầm là số sổ sách sai vĩnh viễn. Mỗi dòng kiểm kê có lưu `systemQuantity` — số sổ sách
     * ngay trước lúc duyệt — nên mở lại chỉ việc trả từng tài sản về đúng số đó.
     *
     * Chặn khi số hiện tại đã khác số đã duyệt: giữa chừng có người sửa tay hoặc có phiên kiểm
     * kê sau, trả về số cũ sẽ xoá mất thay đổi đó mà không ai hay.
     */
    if (action === "REOPEN_ASSET_STOCKTAKE") {
      const sessionId = cleanText(body.sessionId) || cleanText(body.id);
      if (!sessionId) businessError("Thiếu phiên kiểm kê cần mở lại");
      const stocktake = await prisma.assetStocktakeSession.findUnique({ where: { id: sessionId }, include: { lines: { include: { asset: true } } } });
      if (!stocktake) businessError("Không tìm thấy phiên kiểm kê tài sản");
      assertBranchAccess(auth.session, stocktake.branchCode);
      if (stocktake.status !== "APPROVED") businessError(`Phiên kiểm kê ${stocktake.code} đang ở trạng thái ${stocktake.status}, chưa duyệt nên không có gì để mở lại.`);
      await assertPeriodOpen({ date: stocktake.stocktakeDate, branchCode: stocktake.branchCode }, "mở lại phiên kiểm kê tài sản");

      const changed = stocktake.lines.find((line) => Math.abs(line.asset.quantity - line.actualQuantity) > 0.000001);
      if (changed) {
        businessError(`Số lượng của ${changed.asset.code} đã đổi từ sau lần duyệt (${changed.actualQuantity} → ${changed.asset.quantity}). Mở lại sẽ xoá mất thay đổi đó, nên hãy kiểm lại bằng một phiên kiểm kê mới thay vì mở lại phiên này.`);
      }

      const result = await prisma.$transaction(async (tx) => {
        for (const line of stocktake.lines) {
          await tx.assetRecord.update({ where: { id: line.assetId }, data: { quantity: line.systemQuantity } });
        }
        await tx.assetStocktakeSession.update({ where: { id: sessionId }, data: { status: "DRAFT", approvedBy: null, approvedAt: null } });
        return tx.assetStocktakeSession.findUnique({ where: { id: sessionId }, include: { lines: { include: { asset: true } } } });
      });

      await writeAuditLog({ session: auth.session, module: "/assets", action: "REOPEN_ASSET_STOCKTAKE", entityType: "AssetStocktakeSession", entityId: sessionId, entityCode: stocktake.code, branchCode: stocktake.branchCode, metadata: { restored: stocktake.lines.map((line) => ({ code: line.asset.code, from: line.actualQuantity, to: line.systemQuantity })) } });
      return NextResponse.json(result);
    }

    if (action === "CONFIGURE_DEPRECIATION") {
      const assetId = cleanText(body.assetId);
      const usefulLifeMonths = Math.floor(toNumber(body.usefulLifeMonths));
      if (!assetId || usefulLifeMonths <= 0) businessError("Tài sản và số tháng sử dụng là bắt buộc");
      const asset = await prisma.assetRecord.findUnique({ where: { id: assetId } });
      if (!asset) businessError("Không tìm thấy tài sản");
      assertBranchAccess(auth.session, asset.branchCode);
      const result = await prisma.assetRecord.update({
        where: { id: assetId },
        data: {
          usefulLifeMonths,
          depreciationStartDate: toDate(body.depreciationStartDate),
          residualValue: toNumber(body.residualValue),
        },
      });
      return NextResponse.json(result);
    }

    if (action === "RUN_DEPRECIATION") {
      const period = normalizePeriod(body.period);
      const branchCode = requestedBranch(auth.session, cleanText(body.branchCode) || "ALL");
      if (!period) businessError("Kỳ khấu hao phải có dạng YYYY-MM");
      const periodDate = new Date(`${period}-01T00:00:00`);
      if (await isPeriodLocked(periodDate, branchCode)) businessError("Kỳ kế toán đã khóa");
      const assets = await prisma.assetRecord.findMany({
        where: {
          status: "IN_USE",
          usefulLifeMonths: { gt: 0 },
          depreciationStartDate: { lte: new Date(`${period}-28T23:59:59`) },
          ...(branchCode !== "ALL" ? { branchCode } : {}),
        },
      });
      let created = 0;
      let totalAmount = 0;
      for (const asset of assets) {
        const exists = await prisma.assetDepreciation.findUnique({ where: { assetId_period: { assetId: asset.id, period } } });
        if (exists) continue;
        const previous = await prisma.assetDepreciation.aggregate({ where: { assetId: asset.id }, _sum: { depreciationAmount: true }, _count: { _all: true } });
        // Số khấu hao tháng làm tròn tới đồng; phần còn lại có thể trích nốt = giá trị còn lại −
        // giá trị thanh lý. Cùng luật với chi phí phân bổ (`splitAmountByPeriods`): các kỳ đầu
        // lấy số tròn, KỲ CUỐI lấy đúng phần còn lại — nếu không thì làm tròn dồn qua 60 tháng
        // để lại vài đồng lẻ treo mãi trên giá trị tài sản, hoặc đẻ thêm một kỳ khấu hao 1 đồng.
        const remaining = Math.max(0, Math.round(asset.currentValue - asset.residualValue));
        const monthlyAmount = Math.round((asset.originalCost - asset.residualValue) / (asset.usefulLifeMonths || 1));
        const isFinalPeriod = previous._count._all + 1 >= (asset.usefulLifeMonths || 1);
        const amount = isFinalPeriod ? remaining : Math.min(monthlyAmount, remaining);
        if (amount <= 0) continue;
        await prisma.$transaction([
          prisma.assetDepreciation.create({
            data: {
              assetId: asset.id,
              period,
              depreciationAmount: amount,
              accumulatedDepreciation: (previous._sum.depreciationAmount || 0) + amount,
              remainingValue: asset.currentValue - amount,
              runBy: auth.session.name,
            },
          }),
          prisma.assetRecord.update({ where: { id: asset.id }, data: { currentValue: { decrement: amount } } }),
        ]);
        created += 1;
        totalAmount += amount;
      }
      return NextResponse.json({ created, totalAmount });
    }

    /**
     * Mở lại kỳ khấu hao đã chạy để chạy lại.
     *
     * Chạy khấu hao là thao tác một chiều: RUN_DEPRECIATION bỏ qua tài sản đã có dòng của kỳ,
     * nên khai sai số tháng / giá trị còn lại xong mới phát hiện thì không có đường sửa. Mở lại
     * = xoá dòng khấu hao của kỳ, cộng trả giá trị còn lại của tài sản và xoá luôn bút toán
     * 6424/214 đã đẩy sang sổ cái, đưa tài sản về đúng trạng thái trước khi chạy.
     *
     * Chỉ mở được kỳ SAU CÙNG của mỗi tài sản: lũy kế và giá trị còn lại của các kỳ sau được
     * tính chồng lên kỳ này, xoá kỳ giữa sẽ để lại dãy lũy kế sai mà không ai nhìn ra. Kỳ sau
     * còn số thì trả về đúng danh sách kỳ để người dùng lùi dần từ kỳ mới nhất.
     */
    if (action === "REOPEN_DEPRECIATION") {
      const period = normalizePeriod(body.period);
      const branchCode = requestedBranch(auth.session, cleanText(body.branchCode) || "ALL");
      const assetId = cleanText(body.assetId);
      if (!period) businessError("Kỳ khấu hao phải có dạng YYYY-MM");
      const rows = await prisma.assetDepreciation.findMany({
        where: {
          period,
          ...(assetId ? { assetId } : {}),
          ...(branchCode !== "ALL" ? { asset: { branchCode } } : {}),
        },
        include: { asset: true },
      });
      if (rows.length === 0) businessError(`Kỳ ${period} chưa chạy khấu hao cho tài sản nào, không có gì để mở lại`);
      for (const row of rows) assertBranchAccess(auth.session, row.asset.branchCode);

      // Kỳ khóa sổ chặn theo đúng cửa hàng của từng tài sản, không chỉ cửa hàng đang lọc.
      await assertPeriodOpen(
        [...new Set(rows.map((row) => row.asset.branchCode))].map((branch) => ({ period, branchCode: branch })),
        "mở lại khấu hao",
      );

      const laterPeriods = await prisma.assetDepreciation.findMany({
        where: { assetId: { in: rows.map((row) => row.assetId) }, period: { gt: period } },
        select: { period: true },
        distinct: ["period"],
        orderBy: { period: "desc" },
      });
      if (laterPeriods.length > 0) {
        businessError(`Các kỳ sau đã chạy khấu hao (${laterPeriods.map((row) => row.period).join(", ")}). Mở lại từ kỳ mới nhất rồi lùi dần về ${period}.`);
      }

      const restorable = rows.filter((row) => row.asset.status !== "DISPOSED");
      const totalAmount = rows.reduce((sum, row) => sum + row.depreciationAmount, 0);
      await prisma.$transaction(async (tx) => {
        await tx.journalEntry.deleteMany({ where: { sourceType: "DEPRECIATION", sourceId: { in: rows.map((row) => row.id) } } });
        await tx.assetDepreciation.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
        // Tài sản đã thanh lý bị ép giá trị còn lại về 0 lúc thanh lý; cộng trả vào đó là dựng
        // lại giá trị cho một tài sản không còn dùng, nên chỉ hoàn cho tài sản đang sử dụng.
        for (const row of restorable) {
          await tx.assetRecord.update({ where: { id: row.assetId }, data: { currentValue: { increment: row.depreciationAmount } } });
        }
      });

      await writeAuditLog({
        session: auth.session,
        module: "/assets",
        action: "REOPEN_DEPRECIATION",
        entityType: "AssetDepreciation",
        entityId: assetId || null,
        entityCode: period,
        branchCode,
        metadata: { period, reopened: rows.length, totalAmount, skippedDisposed: rows.length - restorable.length },
      });
      return NextResponse.json({ reopened: rows.length, totalAmount, restored: restorable.length, period });
    }

    if (action === "SCHEDULE_MAINTENANCE") {
      const assetId = cleanText(body.assetId);
      if (!assetId) businessError("Thiếu tài sản cần bảo trì");
      const asset = await prisma.assetRecord.findUnique({ where: { id: assetId } });
      if (!asset) businessError("Không tìm thấy tài sản");
      assertBranchAccess(auth.session, asset.branchCode);
      const scheduledDate = toDate(body.scheduledDate);
      const recurrenceRule = cleanText(body.recurrenceRule) || "NONE";
      const recurrenceInterval = Math.max(1, Math.floor(toNumber(body.recurrenceInterval) || 1));
      const recurrenceEndDate = body.recurrenceEndDate ? toDate(body.recurrenceEndDate) : null;
      const dates = maintenanceDates(scheduledDate, recurrenceRule, recurrenceInterval, recurrenceEndDate);
      const shouldCreateWorkTask = body.createWorkTask !== false;
      const result = await prisma.$transaction(async (tx) => {
        const created = [];
        for (const date of dates) {
          const maintenance = await tx.assetMaintenance.create({
            data: {
              assetId,
              maintenanceType: cleanText(body.maintenanceType) || "Định kỳ",
              scheduledDate: date,
              supplierName: cleanText(body.supplierName) || null,
              cost: toNumber(body.cost),
              recurrenceRule: recurrenceRule === "NONE" ? null : recurrenceRule,
              recurrenceInterval,
              recurrenceEndDate,
              note: cleanText(body.note) || null,
              createdBy: auth.session.name,
            },
          });
          if (!shouldCreateWorkTask) {
            created.push(maintenance);
            continue;
          }
          const workItem = await tx.workItem.create({
            data: {
              code: await nextWorkItemCode(tx),
              title: `Bảo trì ${asset.code} - ${asset.name}`,
              description: `${cleanText(body.maintenanceType) || "Bảo trì định kỳ"}${maintenance.supplierName ? ` - ${maintenance.supplierName}` : ""}`,
              branchCode: asset.branchCode,
              departmentCode: asset.departmentCode || "OPS",
              assigneeName: cleanText(body.assigneeName) || auth.session.name,
              linkedModule: "ASSET_MAINTENANCE",
              linkedId: maintenance.id,
              linkedCode: asset.code,
              checklistJson: JSON.stringify(["Kiểm tra tình trạng thiết bị", "Ghi nhận chi phí/phát sinh", "Cập nhật kết quả bảo trì"]),
              priority: "MEDIUM",
              dueDate: date,
              createdBy: auth.session.name,
              histories: { create: { action: "CREATED_FROM_ASSET_MAINTENANCE", toStatus: "TODO", actor: auth.session.name, note: cleanText(body.note) || null } },
            },
          });
          created.push(await tx.assetMaintenance.update({ where: { id: maintenance.id }, data: { linkedWorkItemId: workItem.id } }));
        }
        return created.length === 1 ? created[0] : { created: created.length, items: created };
      });
      return NextResponse.json(result, { status: 201 });
    }

    if (action === "COMPLETE_MAINTENANCE") {
      const id = cleanText(body.id);
      if (!id) businessError("Thiếu lịch bảo trì");
      const maintenance = await prisma.assetMaintenance.findUnique({ where: { id }, include: { asset: true } });
      if (!maintenance) businessError("Không tìm thấy lịch bảo trì");
      assertBranchAccess(auth.session, maintenance.asset.branchCode);
      const result = await prisma.assetMaintenance.update({
        where: { id },
        data: { status: "COMPLETED", completedDate: toDate(body.completedDate), cost: toNumber(body.cost), note: cleanText(body.note) || undefined },
      });
      if (maintenance.linkedWorkItemId) {
        await prisma.workItem.update({
          where: { id: maintenance.linkedWorkItemId },
          data: {
            status: "COMPLETED",
            completedAt: new Date(),
            histories: { create: { action: "COMPLETED_FROM_ASSET_MAINTENANCE", fromStatus: "TODO", toStatus: "COMPLETED", actor: auth.session.name, note: cleanText(body.note) || null } },
          },
        });
      }
      return NextResponse.json(result);
    }

    /**
     * Mở lại lịch bảo trì đã hoàn tất: đưa về Đang chờ, xoá ngày hoàn thành và mở lại công
     * việc liên quan. Chi phí ghi nhầm chỉ sửa được bằng cách bấm Hoàn tất lại với số đúng.
     */
    if (action === "REOPEN_MAINTENANCE") {
      const id = cleanText(body.id);
      if (!id) businessError("Thiếu lịch bảo trì cần mở lại");
      const maintenance = await prisma.assetMaintenance.findUnique({ where: { id }, include: { asset: true } });
      if (!maintenance) businessError("Không tìm thấy lịch bảo trì");
      assertBranchAccess(auth.session, maintenance.asset.branchCode);
      if (maintenance.status !== "COMPLETED") businessError("Lịch bảo trì này chưa hoàn tất nên không có gì để mở lại.");
      await assertPeriodOpen({ date: maintenance.completedDate || maintenance.scheduledDate, branchCode: maintenance.asset.branchCode }, "mở lại lịch bảo trì");

      const result = await prisma.assetMaintenance.update({ where: { id }, data: { status: "SCHEDULED", completedDate: null } });
      if (maintenance.linkedWorkItemId) {
        await prisma.workItem.update({
          where: { id: maintenance.linkedWorkItemId },
          data: {
            status: "TODO",
            completedAt: null,
            histories: { create: { action: "REOPENED_FROM_ASSET_MAINTENANCE", fromStatus: "COMPLETED", toStatus: "TODO", actor: auth.session.name, note: cleanText(body.note) || null } },
          },
        });
      }
      await writeAuditLog({ session: auth.session, module: "/assets", action: "REOPEN_MAINTENANCE", entityType: "AssetMaintenance", entityId: id, entityCode: maintenance.asset.code, branchCode: maintenance.asset.branchCode, metadata: { cost: maintenance.cost, completedDate: maintenance.completedDate } });
      return NextResponse.json(result);
    }

    /**
     * Mở lại báo hỏng đã xử lý.
     *
     * RESOLVE_DAMAGE rẽ bốn nhánh và nhánh nào cũng để lại dấu vết ngoài bản ghi báo hỏng:
     * tăng nguyên giá, sinh phiếu phân bổ, sinh công nợ NCC, hoặc lập phiếu chi. Chọn nhầm
     * cách xử lý mà không mở lại được thì mỗi lần nhầm là một chứng từ rác nằm lại trong sổ.
     * Mở lại gỡ đúng thứ mà lần xử lý đó đã tạo ra rồi đưa báo hỏng về Chờ xử lý.
     */
    if (action === "REOPEN_DAMAGE") {
      const id = cleanText(body.id);
      if (!id) businessError("Thiếu báo hỏng cần mở lại");
      const report = await prisma.assetDamageReport.findUnique({ where: { id }, include: { asset: true } });
      if (!report) businessError("Không tìm thấy báo hỏng");
      assertBranchAccess(auth.session, report.asset.branchCode);
      if (report.status !== "COMPLETED") businessError(`Báo hỏng ${report.code} chưa xử lý xong nên không có gì để mở lại.`);
      const resolvedAt = report.resolvedAt || new Date();
      await assertPeriodOpen({ date: resolvedAt, branchCode: report.asset.branchCode }, "mở lại báo hỏng");

      const undone: string[] = [];
      if (report.repairTreatment === "CAPITALIZE" && report.repairCost > 0) {
        await prisma.assetRecord.update({ where: { id: report.assetId }, data: { originalCost: { decrement: report.repairCost }, currentValue: { decrement: report.repairCost } } });
        undone.push(`giảm lại nguyên giá ${report.repairCost}`);
      }
      if (report.repairTreatment === "ALLOCATE") {
        const accrual = await prisma.accrual.findFirst({ where: { sourceType: "ASSET_REPAIR", sourceId: report.id }, include: { schedules: true } });
        if (accrual) {
          // Kỳ nào đã ghi nhận chi phí thì số đã nằm trên P&L — bắt bỏ ghi nhận ở màn Sổ quỹ
          // trước, chứ xoá thẳng phiếu phân bổ sẽ để lại bút toán 6428 không còn gốc.
          const posted = accrual.schedules.filter((schedule) => schedule.status === "POSTED");
          if (posted.length > 0) {
            businessError(`Phiếu phân bổ ${accrual.code} đã ghi nhận ${posted.length} kỳ (${posted.map((schedule) => schedule.period).join(", ")}). Bỏ ghi nhận các kỳ đó ở tab Trích trước rồi mới mở lại báo hỏng.`);
          }
          await prisma.accrual.delete({ where: { id: accrual.id } });
          undone.push(`xoá phiếu phân bổ ${accrual.code}`);
        }
      }
      if (report.repairTreatment === "DEBT") {
        const debt = await prisma.debtRecord.findFirst({ where: { sourceType: "ASSET_REPAIR", sourceId: report.id }, include: { settlements: true } });
        if (debt) {
          if (debt.settlements.length > 0) {
            businessError(`Công nợ ${debt.code} của báo hỏng này đã được gạch nợ. Hoàn tác các phiếu thu/chi gạch nợ trước rồi mới mở lại.`);
          }
          await prisma.debtRecord.delete({ where: { id: debt.id } });
          await prisma.journalEntry.deleteMany({ where: { sourceType: "DEBT_PAYABLE", sourceId: debt.id } });
          undone.push(`xoá công nợ ${debt.code}`);
        }
      }
      if (report.repairTreatment === "EXPENSE") {
        const voucher = await prisma.financialVoucher.findFirst({ where: { sourceDocumentCode: report.code, voucherType: "PAYMENT" } });
        if (voucher) {
          await prisma.financialVoucher.delete({ where: { id: voucher.id } });
          await prisma.journalEntry.deleteMany({ where: { sourceType: "VOUCHER", sourceId: voucher.id } });
          undone.push(`xoá phiếu chi ${voucher.code}`);
        }
      }

      const result = await prisma.assetDamageReport.update({
        where: { id },
        data: { status: "NEW", repairCost: 0, repairTreatment: null, resolvedAt: null, resolvedBy: null },
      });
      if (report.linkedWorkItemId) {
        await prisma.workItem.update({
          where: { id: report.linkedWorkItemId },
          data: {
            status: "TODO",
            completedAt: null,
            histories: { create: { action: "REOPENED_FROM_ASSET_REPAIR", fromStatus: "COMPLETED", toStatus: "TODO", actor: auth.session.name, note: cleanText(body.note) || null } },
          },
        });
      }
      await writeAuditLog({ session: auth.session, module: "/assets", action: "REOPEN_DAMAGE", entityType: "AssetDamageReport", entityId: id, entityCode: report.code, branchCode: report.asset.branchCode, metadata: { treatment: report.repairTreatment, repairCost: report.repairCost, undone } });
      return NextResponse.json({ ...result, undone });
    }

    /**
     * Mở lại tài sản đã thanh lý.
     *
     * Thanh lý ép giá trị còn lại về 0 và không lưu lại giá trị trước đó, nên khôi phục bằng
     * cách dựng lại theo đúng công thức mà mọi luồng khác vẫn giữ: nguyên giá trừ tổng khấu
     * hao đã chạy. Ghi tăng đặt giá trị còn lại = nguyên giá, khấu hao trừ dần, sửa chữa ghi
     * tăng cộng vào cả hai vế — nên đẳng thức này luôn đúng ngoài lúc đã thanh lý.
     */
    if (action === "REOPEN_DISPOSAL") {
      const assetId = cleanText(body.assetId) || cleanText(body.id);
      if (!assetId) businessError("Thiếu tài sản cần mở lại");
      const asset = await prisma.assetRecord.findUnique({ where: { id: assetId } });
      if (!asset) businessError("Không tìm thấy tài sản");
      assertBranchAccess(auth.session, asset.branchCode);
      if (asset.status !== "DISPOSED") businessError(`Tài sản ${asset.code} chưa thanh lý nên không có gì để mở lại.`);
      const disposalDate = asset.disposalDate || new Date();
      await assertPeriodOpen({ date: disposalDate, branchCode: asset.branchCode }, "mở lại thanh lý tài sản");

      const depreciated = await prisma.assetDepreciation.aggregate({ where: { assetId }, _sum: { depreciationAmount: true } });
      const restoredValue = Math.max(0, asset.originalCost - (depreciated._sum.depreciationAmount || 0));

      const receipt = await prisma.financialVoucher.findFirst({ where: { sourceDocumentCode: asset.code, voucherType: "RECEIPT", categoryCode: "ASSET_DISPOSAL" } });
      if (receipt) {
        await prisma.financialVoucher.delete({ where: { id: receipt.id } });
        await prisma.journalEntry.deleteMany({ where: { sourceType: "VOUCHER", sourceId: receipt.id } });
      }

      const result = await prisma.assetRecord.update({
        where: { id: assetId },
        data: {
          status: "IN_USE",
          disposalStatus: null,
          disposalDate: null,
          disposalAmount: 0,
          disposalNote: null,
          currentValue: restoredValue,
        },
      });
      await writeAuditLog({ session: auth.session, module: "/assets", action: "REOPEN_DISPOSAL", entityType: "AssetRecord", entityId: assetId, entityCode: asset.code, branchCode: asset.branchCode, metadata: { disposalAmount: asset.disposalAmount, restoredValue, removedVoucher: receipt?.code || null } });
      return NextResponse.json(result);
    }

    if (action === "REPORT_DAMAGE") {
      const assetId = cleanText(body.assetId);
      const description = cleanText(body.description);
      if (!assetId || !description) businessError("Tài sản và mô tả hư hỏng là bắt buộc");
      const asset = await prisma.assetRecord.findUnique({ where: { id: assetId } });
      if (!asset) businessError("Không tìm thấy tài sản");
      assertBranchAccess(auth.session, asset.branchCode);
      const code = await nextYearlyCode(prisma.assetDamageReport, "BH");
      const result = await prisma.$transaction(async (tx) => {
        const report = await tx.assetDamageReport.create({
          data: {
            code,
            assetId,
            severity: cleanText(body.severity) || "MEDIUM",
            description,
            reportedBy: auth.session.name,
            note: cleanText(body.note) || null,
          },
        });
        const workItem = await tx.workItem.create({
          data: {
            code: await nextWorkItemCode(tx),
            title: `Xử lý sửa chữa ${asset.code} - ${asset.name}`,
            description,
            branchCode: asset.branchCode,
            departmentCode: asset.departmentCode || "OPS",
            assigneeName: cleanText(body.assigneeName) || auth.session.name,
            linkedModule: "ASSET_DAMAGE_REPORT",
            linkedId: report.id,
            linkedCode: code,
            checklistJson: JSON.stringify(["Kiểm tra hiện trạng", "Đề xuất xử lý/nhà cung cấp", "Cập nhật chi phí thực tế", "Hoàn tất sửa chữa"]),
            priority: cleanText(body.severity) === "HIGH" ? "HIGH" : "MEDIUM",
            dueDate: body.dueDate ? toDate(body.dueDate) : new Date(Date.now() + 24 * 60 * 60 * 1000),
            createdBy: auth.session.name,
            histories: { create: { action: "CREATED_FROM_ASSET_DAMAGE", toStatus: "TODO", actor: auth.session.name, note: cleanText(body.note) || null } },
          },
        });
        return tx.assetDamageReport.update({ where: { id: report.id }, data: { linkedWorkItemId: workItem.id } });
      });
      return NextResponse.json(result, { status: 201 });
    }

    if (action === "RESOLVE_DAMAGE") {
      const id = cleanText(body.id);
      const treatment = cleanText(body.repairTreatment) || "EXPENSE";
      const repairCost = toNumber(body.repairCost);
      const report = await prisma.assetDamageReport.findUnique({ where: { id }, include: { asset: true } });
      if (!report) businessError("Không tìm thấy báo hỏng");
      assertBranchAccess(auth.session, report.asset.branchCode);
      const resolvedAt = toDate(body.resolvedAt);
      if (await isPeriodLocked(resolvedAt, report.asset.branchCode)) businessError("Kỳ kế toán đã khóa");
      const result = await prisma.$transaction(async (tx) => {
        if (treatment === "CAPITALIZE" && repairCost > 0) {
          await tx.assetRecord.update({ where: { id: report.assetId }, data: { originalCost: { increment: repairCost }, currentValue: { increment: repairCost } } });
        }
        if (treatment === "ALLOCATE" && repairCost > 0) {
          const periods = Math.max(2, Math.floor(toNumber(body.numberOfPeriods || body.allocationMonths) || 6));
          const startPeriod = `${resolvedAt.getFullYear()}-${String(resolvedAt.getMonth() + 1).padStart(2, "0")}`;
          const categoryCode = cleanText(body.categoryCode) || "REPAIR";
          await tx.accrual.create({
            data: {
              code: `PBSC-${report.code}`,
              name: `Phân bổ sửa chữa ${report.asset.name}`,
              branchCode: report.asset.branchCode,
              categoryCode,
              totalAmount: repairCost,
              startPeriod,
              numberOfPeriods: periods,
              sourceType: "ASSET_REPAIR",
              sourceId: report.id,
              createdBy: auth.session.name,
              schedules: { create: buildAllocationSchedules(startPeriod, repairCost, periods) },
            },
          });
        }
        if (treatment === "DEBT" && repairCost > 0) {
          const partnerName = cleanText(body.supplierName) || report.asset.supplierName || "Nhà cung cấp sửa chữa";
          const partnerCode = cleanText(body.supplierCode) || report.asset.supplierCode || "NCC_REPAIR";
          const debtCode = `CN-${report.code}`;
          await tx.debtRecord.create({
            data: {
              code: debtCode,
              debtType: "PAYABLE",
              partnerGroup: "EXTERNAL",
              partnerCode,
              partnerName,
              branchCode: report.asset.branchCode,
              documentDate: resolvedAt,
              dueDate: body.dueDate ? toDate(body.dueDate) : null,
              categoryCode: cleanText(body.categoryCode) || "REPAIR",
              originalAmount: repairCost,
              outstandingAmount: repairCost,
              description: `Công nợ sửa chữa ${report.asset.code} - ${report.asset.name}: ${report.description}`,
              sourceType: "ASSET_REPAIR",
              sourceId: report.id,
              status: "OPEN",
            },
          });
        }
        if (treatment === "EXPENSE" && repairCost > 0) {
          const moneySourceCode = cleanText(body.moneySourceCode) || await defaultMoneySource(tx, report.asset.branchCode);
          const documentChannel = await documentChannelForSource(tx, moneySourceCode);
          await tx.financialVoucher.create({
            data: {
              code: await nextPaymentVoucherCode(tx, resolvedAt, report.asset.branchCode, documentChannel),
              sourceDocumentCode: report.code,
              voucherType: "PAYMENT",
              voucherDate: resolvedAt,
              partnerCode: cleanText(body.supplierCode) || report.asset.supplierCode || null,
              partnerName: cleanText(body.supplierName) || report.asset.supplierName || "Nhà cung cấp sửa chữa",
              branchCode: report.asset.branchCode,
              documentChannel,
              moneySourceCode,
              categoryCode: cleanText(body.categoryCode) || "REPAIR",
              amount: repairCost,
              description: `Chi phí sửa chữa ${report.asset.code} - ${report.asset.name}: ${report.description}`,
              status: "PENDING_REVIEW",
              createdBy: auth.session.name,
            },
          });
        }
        const updatedReport = await tx.assetDamageReport.update({
          where: { id },
          data: { status: "COMPLETED", repairCost, repairTreatment: treatment, resolvedAt, resolvedBy: auth.session.name, note: cleanText(body.note) || undefined },
        });
        if (updatedReport.linkedWorkItemId) {
          await tx.workItem.update({
            where: { id: updatedReport.linkedWorkItemId },
            data: {
              status: "COMPLETED",
              completedAt: new Date(),
              histories: { create: { action: "COMPLETED_FROM_ASSET_REPAIR", fromStatus: "TODO", toStatus: "COMPLETED", actor: auth.session.name, note: cleanText(body.note) || null } },
            },
          });
        }
        return updatedReport;
      });
      return NextResponse.json(result);
    }

    if (action === "DISPOSE_ASSET") {
      const assetId = cleanText(body.assetId) || cleanText(body.id);
      const asset = await prisma.assetRecord.findUnique({ where: { id: assetId } });
      if (!asset) businessError("Không tìm thấy tài sản");
      assertBranchAccess(auth.session, asset.branchCode);

      const disposalDate = body.disposalDate ? toDate(body.disposalDate) : new Date();
      if (await isPeriodLocked(disposalDate, asset.branchCode)) businessError("Kỳ kế toán đã khóa");

      const disposalAmount = toNumber(body.disposalAmount);
      const disposalNote = cleanText(body.disposalNote) || cleanText(body.note);

      const result = await prisma.$transaction(async (tx) => {
        if (disposalAmount > 0) {
          const moneySourceCode = cleanText(body.moneySourceCode) || await defaultMoneySource(tx, asset.branchCode);
          const documentChannel = await documentChannelForSource(tx, moneySourceCode);
          // Cùng lý do: COUNT mọi phiếu thu (kể cả đã xoá mềm) sẽ cấp trúng mã đang sống. Và
          // cũng phải đọc thô để thấy phiếu trong thùng rác, nếu không lại đâm trúng mã của nó.
          const disposalPrefix = "PTTL-";
          const issuedDisposal = await tx.$queryRaw<Array<{ code: string }>>`SELECT "code" FROM "FinancialVoucher" WHERE "code" LIKE ${disposalPrefix + "%"}`;
          const voucherCode = disposalPrefix + String(nextSeqFromCodes(issuedDisposal.map((row) => row.code), disposalPrefix)).padStart(4, "0");
          await tx.financialVoucher.create({
            data: {
              code: voucherCode,
              sourceDocumentCode: asset.code,
              voucherType: "RECEIPT",
              voucherDate: disposalDate,
              partnerCode: asset.supplierCode || null,
              partnerName: asset.supplierName || "Thanh lý tài sản",
              branchCode: asset.branchCode,
              documentChannel,
              moneySourceCode,
              categoryCode: "ASSET_DISPOSAL",
              amount: disposalAmount,
              description: `Thu tiền thanh lý tài sản ${asset.code} - ${asset.name}`,
              status: "PENDING_REVIEW",
              createdBy: auth.session.name,
            },
          });
        }

        return tx.assetRecord.update({
          where: { id: assetId },
          data: {
            status: "DISPOSED",
            disposalStatus: "DISPOSED",
            disposalDate,
            disposalAmount,
            disposalNote: disposalNote || null,
            currentValue: 0,
          },
        });
      });

      return NextResponse.json(result);
    }

    businessError("Thao tác tài sản không hợp lệ");
  } catch (error) {
    const result = apiError(error);
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
}
