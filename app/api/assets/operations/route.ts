import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/custom-client";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { addPeriod, apiError, businessError, cleanText, isPeriodLocked, normalizePeriod, toDate, toNumber } from "@/lib/phase3";
import { assertBranchAccess, requestedBranch } from "@/lib/accounting";

const menuHref = "/assets";

async function nextPaymentVoucherCode(tx: Prisma.TransactionClient) {
  const now = new Date();
  const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const count = await tx.financialVoucher.count({ where: { voucherType: "PAYMENT" } });
  return `PC-${ym}-${String(count + 1).padStart(3, "0")}`;
}

async function defaultMoneySource(tx: Prisma.TransactionClient, branchCode: string) {
  const source = await tx.masterDataItem.findFirst({
    where: { type: "MONEY_SOURCE", status: "ACTIVE", branch: { in: [branchCode, "ALL"] } },
    orderBy: { code: "asc" },
  });
  return source?.code || (branchCode === "HN" ? "POS_HN" : "TM_HCM");
}

async function nextWorkItemCode(tx: Prisma.TransactionClient) {
  const count = await tx.workItem.count();
  return `CV-${new Date().getFullYear()}-${String(count + 1).padStart(4, "0")}`;
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
    const [assets, depreciations, maintenances, damageReports] = await Promise.all([
      prisma.assetRecord.findMany({ where: assetWhere, orderBy: { createdAt: "desc" } }),
      prisma.assetDepreciation.findMany({ where: relatedWhere, include: { asset: true }, orderBy: [{ period: "desc" }, { createdAt: "desc" }], take: 200 }),
      prisma.assetMaintenance.findMany({ where: relatedWhere, include: { asset: true }, orderBy: { scheduledDate: "desc" }, take: 200 }),
      prisma.assetDamageReport.findMany({ where: relatedWhere, include: { asset: true }, orderBy: { reportedDate: "desc" }, take: 200 }),
    ]);
    return NextResponse.json({ assets, depreciations, maintenances, damageReports });
  } catch (error) {
    const result = apiError(error);
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const action = cleanText(body.action);
    const requiredAction = ["RUN_DEPRECIATION", "COMPLETE_MAINTENANCE", "RESOLVE_DAMAGE", "CONFIGURE_DEPRECIATION"].includes(action) ? "edit" : "create";
    const auth = requireMenuAction(request, menuHref, requiredAction);
    if (!auth.ok) return auth.response;

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
        const monthlyAmount = (asset.originalCost - asset.residualValue) / (asset.usefulLifeMonths || 1);
        const amount = Math.max(0, Math.min(monthlyAmount, asset.currentValue - asset.residualValue));
        if (amount <= 0) continue;
        const previous = await prisma.assetDepreciation.aggregate({ where: { assetId: asset.id }, _sum: { depreciationAmount: true } });
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

    if (action === "REPORT_DAMAGE") {
      const assetId = cleanText(body.assetId);
      const description = cleanText(body.description);
      if (!assetId || !description) businessError("Tài sản và mô tả hư hỏng là bắt buộc");
      const asset = await prisma.assetRecord.findUnique({ where: { id: assetId } });
      if (!asset) businessError("Không tìm thấy tài sản");
      assertBranchAccess(auth.session, asset.branchCode);
      const code = `BH-${new Date().getFullYear()}-${String(await prisma.assetDamageReport.count() + 1).padStart(4, "0")}`;
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
          const amount = repairCost / periods;
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
              schedules: { create: Array.from({ length: periods }, (_, index) => ({ period: addPeriod(startPeriod, index), amount })) },
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
          await tx.financialVoucher.create({
            data: {
              code: await nextPaymentVoucherCode(tx),
              sourceDocumentCode: report.code,
              voucherType: "PAYMENT",
              voucherDate: resolvedAt,
              partnerCode: cleanText(body.supplierCode) || report.asset.supplierCode || null,
              partnerName: cleanText(body.supplierName) || report.asset.supplierName || "Nhà cung cấp sửa chữa",
              branchCode: report.asset.branchCode,
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
          const count = await tx.financialVoucher.count({ where: { voucherType: "RECEIPT" } });
          const voucherCode = `PTTL-${String(count + 1).padStart(4, "0")}`;
          await tx.financialVoucher.create({
            data: {
              code: voucherCode,
              sourceDocumentCode: asset.code,
              voucherType: "RECEIPT",
              voucherDate: disposalDate,
              partnerCode: asset.supplierCode || null,
              partnerName: asset.supplierName || "Thanh lý tài sản",
              branchCode: asset.branchCode,
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
