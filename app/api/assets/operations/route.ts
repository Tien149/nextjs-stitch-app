import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { addPeriod, apiError, businessError, cleanText, isPeriodLocked, normalizePeriod, toDate, toNumber } from "@/lib/phase3";

const menuHref = "/assets";

export async function GET(request: Request) {
  try {
    const auth = requireMenuAccess(request, menuHref);
    if (!auth.ok) return auth.response;
    const [assets, depreciations, maintenances, damageReports] = await Promise.all([
      prisma.assetRecord.findMany({ orderBy: { createdAt: "desc" } }),
      prisma.assetDepreciation.findMany({ include: { asset: true }, orderBy: [{ period: "desc" }, { createdAt: "desc" }], take: 200 }),
      prisma.assetMaintenance.findMany({ include: { asset: true }, orderBy: { scheduledDate: "desc" }, take: 200 }),
      prisma.assetDamageReport.findMany({ include: { asset: true }, orderBy: { reportedDate: "desc" }, take: 200 }),
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
      const branchCode = cleanText(body.branchCode) || "ALL";
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
      const result = await prisma.assetMaintenance.create({
        data: {
          assetId,
          maintenanceType: cleanText(body.maintenanceType) || "Định kỳ",
          scheduledDate: toDate(body.scheduledDate),
          supplierName: cleanText(body.supplierName) || null,
          cost: toNumber(body.cost),
          note: cleanText(body.note) || null,
          createdBy: auth.session.name,
        },
      });
      return NextResponse.json(result, { status: 201 });
    }

    if (action === "COMPLETE_MAINTENANCE") {
      const id = cleanText(body.id);
      if (!id) businessError("Thiếu lịch bảo trì");
      const result = await prisma.assetMaintenance.update({
        where: { id },
        data: { status: "COMPLETED", completedDate: toDate(body.completedDate), cost: toNumber(body.cost), note: cleanText(body.note) || undefined },
      });
      return NextResponse.json(result);
    }

    if (action === "REPORT_DAMAGE") {
      const assetId = cleanText(body.assetId);
      const description = cleanText(body.description);
      if (!assetId || !description) businessError("Tài sản và mô tả hư hỏng là bắt buộc");
      const code = `BH-${new Date().getFullYear()}-${String(await prisma.assetDamageReport.count() + 1).padStart(4, "0")}`;
      const result = await prisma.assetDamageReport.create({
        data: {
          code,
          assetId,
          severity: cleanText(body.severity) || "MEDIUM",
          description,
          reportedBy: auth.session.name,
          note: cleanText(body.note) || null,
        },
      });
      return NextResponse.json(result, { status: 201 });
    }

    if (action === "RESOLVE_DAMAGE") {
      const id = cleanText(body.id);
      const treatment = cleanText(body.repairTreatment) || "EXPENSE";
      const repairCost = toNumber(body.repairCost);
      const report = await prisma.assetDamageReport.findUnique({ where: { id }, include: { asset: true } });
      if (!report) businessError("Không tìm thấy báo hỏng");
      const resolvedAt = toDate(body.resolvedAt);
      if (await isPeriodLocked(resolvedAt, report.asset.branchCode)) businessError("Kỳ kế toán đã khóa");
      const result = await prisma.$transaction(async (tx) => {
        if (treatment === "CAPITALIZE" && repairCost > 0) {
          await tx.assetRecord.update({ where: { id: report.assetId }, data: { originalCost: { increment: repairCost }, currentValue: { increment: repairCost } } });
        }
        if (treatment === "ALLOCATE" && repairCost > 0) {
          const periods = Math.max(2, Math.floor(toNumber(body.numberOfPeriods) || 6));
          const startPeriod = `${resolvedAt.getFullYear()}-${String(resolvedAt.getMonth() + 1).padStart(2, "0")}`;
          const amount = repairCost / periods;
          await tx.accrual.create({
            data: {
              code: `PBSC-${report.code}`,
              name: `Phân bổ sửa chữa ${report.asset.name}`,
              branchCode: report.asset.branchCode,
              categoryCode: "REPAIR",
              totalAmount: repairCost,
              startPeriod,
              numberOfPeriods: periods,
              createdBy: auth.session.name,
              schedules: { create: Array.from({ length: periods }, (_, index) => ({ period: addPeriod(startPeriod, index), amount })) },
            },
          });
        }
        return tx.assetDamageReport.update({
          where: { id },
          data: { status: "COMPLETED", repairCost, repairTreatment: treatment, resolvedAt, resolvedBy: auth.session.name, note: cleanText(body.note) || undefined },
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
