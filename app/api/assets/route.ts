import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { prisma, prismaRaw } from "@/lib/prisma";
import { requestedBranch, assertBranchAccess, ensureDefaultAccounts, postJournalEntry } from "@/lib/accounting";
import { closedPeriodMessage, findClosedPeriod, isPeriodLocked, periodFromDate } from "@/lib/phase3";
import { writeAuditLog } from "@/lib/audit-log";
import type { DemoSession } from "@/lib/auth-demo";
import { assertAssetCodeAvailable, AssetCodeError, nextAssetCode, nextAssetLot, normalizeAssetCode } from "@/lib/asset-code-generator";
import { assetAcquisitionJournalCode, assetPayableCode } from "@/lib/asset-lot";
import {
  softDeleteRecord,
  SoftDeleteError,
} from "@/lib/soft-delete";

const auditModule = "/assets";

/** Các trường không được sửa sau khi tài sản đã trích khấu hao. */
const depreciationLockedFields = [
  "quantity",
  "purchaseDate",
  "originalCost",
  "usefulLifeMonths",
  "depreciationStartDate",
  "residualValue",
] as const;

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function toAmount(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function isDisposedAsset(asset: { disposalStatus: string | null; status: string }) {
  return Boolean(asset.disposalStatus) || asset.status === "DISPOSED";
}

export async function GET(request: Request) {
  try {
    const auth = requireMenuAccess(request, "/assets");
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const search = searchParams.get("search")?.trim() || searchParams.get("q")?.trim();
    const statusParam = searchParams.get("status") || undefined;
    const assetGroup = searchParams.get("assetGroup") || undefined;
    const departmentCode = searchParams.get("departmentCode") || undefined;
    const warehouseCode = searchParams.get("warehouseCode") || searchParams.get("location") || undefined;
    const branchCode = requestedBranch(auth.session, cleanText(searchParams.get("branchCode")) || "ALL");
    const branchFilter = branchCode === "ALL" ? {} : { branchCode };

    const assets = await prisma.assetRecord.findMany({
      where: {
        ...branchFilter,
        ...(assetGroup && assetGroup !== "ALL" ? { assetGroup } : {}),
        ...(departmentCode && departmentCode !== "ALL" ? { departmentCode } : {}),
        ...(warehouseCode && warehouseCode !== "ALL"
          ? {
              OR: [
                { warehouseCode: warehouseCode },
                { location: warehouseCode },
              ],
            }
          : {}),
        ...(search
          ? {
              OR: [
                { code: { contains: search } },
                { name: { contains: search } },
                { branchCode: { contains: search } },
                { departmentCode: { contains: search } },
                { assetGroup: { contains: search } },
                { supplierName: { contains: search } },
                { supplierCode: { contains: search } },
                { location: { contains: search } },
                { warehouseCode: { contains: search } },
                { note: { contains: search } },
              ],
            }
          : {}),
      },
      include: {
        depreciations: {
          select: {
            depreciationAmount: true,
          },
        },
        _count: { select: { maintenances: true, damageReports: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    const assetPeriods = Array.from(new Set(assets.map((asset) => periodFromDate(asset.purchaseDate))));
    const [journalEntries, openingBalances, assetDebts, lockedPeriods, lotCounts] = await Promise.all([
      prismaRaw.journalEntry.findMany({
        where: { sourceType: "ASSET_ACQUISITION", sourceId: { in: assets.map((asset) => asset.id) }, deletedAt: null },
        select: { sourceId: true },
      }),
      prismaRaw.openingBalance.findMany({
        where: { balanceType: "ASSET", objectCode: { in: assets.map((asset) => asset.code) }, deletedAt: null },
        select: { objectCode: true },
      }),
      prismaRaw.debtRecord.findMany({
        where: { sourceType: "ASSET", sourceId: { in: assets.map((asset) => asset.id) }, deletedAt: null },
        select: { sourceId: true, code: true, status: true },
      }),
      prismaRaw.accountingPeriod.findMany({
        where: { period: { in: assetPeriods }, status: "CLOSED" },
        select: { period: true, branchCode: true },
      }),
      // Số đợt của mỗi mã (một mã nhiều đợt — lib/asset-lot.ts), đếm cả đợt ngoài bộ lọc hiện tại.
      prisma.assetRecord.groupBy({
        by: ["code"],
        where: { code: { in: Array.from(new Set(assets.map((asset) => asset.code))) } },
        _count: { _all: true },
      }),
    ]);
    const lotCountByCode = new Map(lotCounts.map((row) => [row.code, row._count._all]));
    const journaledAssetIds = new Set(journalEntries.map((entry) => entry.sourceId));
    const openingBalanceAssetCodes = new Set(openingBalances.map((entry) => entry.objectCode));
    const assetDebtById = new Map(assetDebts.map((debt) => [debt.sourceId, debt]));
    const lockedPeriodKeys = new Set(lockedPeriods.map((period) => `${period.branchCode}:${period.period}`));

    const enriched = assets.map((asset) => {
      // Tiến độ tính cả phần đã phân bổ TRƯỚC khi lên hệ thống (tài sản/CCDC đầu kỳ đang dở).
      // Khoá sửa/xoá vẫn chỉ xét các kỳ chạy trên hệ thống (`runPeriods`).
      const runPeriods = asset.depreciations.length;
      const allocatedPeriods = runPeriods + (asset.openingDepreciatedPeriods || 0);
      const allocatedAmount = asset.depreciations.reduce((sum, d) => sum + d.depreciationAmount, 0) + (asset.accumulatedDepreciation || 0);
      const remainingPeriods = asset.usefulLifeMonths ? Math.max(asset.usefulLifeMonths - allocatedPeriods, 0) : null;
      const computedCurrentValue = Math.max(asset.originalCost - allocatedAmount, asset.residualValue);

      let computedStatus: "IN_USE" | "FULLY_ALLOCATED" | "DISPOSED" = "IN_USE";
      if (asset.disposalStatus || asset.status === "DISPOSED") {
        computedStatus = "DISPOSED";
      } else if (asset.usefulLifeMonths && remainingPeriods === 0) {
        computedStatus = "FULLY_ALLOCATED";
      } else if (asset.usefulLifeMonths && computedCurrentValue <= asset.residualValue) {
        computedStatus = "FULLY_ALLOCATED";
      }

      const { depreciations: _depreciations, _count, ...baseAsset } = asset;
      void _depreciations;
      const payableDebt = assetDebtById.get(asset.id);
      const assetPeriod = periodFromDate(asset.purchaseDate);
      const isLockedPeriod = lockedPeriodKeys.has(`${asset.branchCode}:${assetPeriod}`) || lockedPeriodKeys.has(`ALL:${assetPeriod}`);
      const codeEditLockReason = isDisposedAsset(asset)
        ? "Tài sản đã thanh lý."
        : (lotCountByCode.get(asset.code) || 1) > 1
          ? "Mã có nhiều đợt mua; không đổi mã của riêng một đợt."
        : runPeriods > 0
          ? `Tài sản đã trích khấu hao ${runPeriods} kỳ.`
          : _count.maintenances > 0
            ? "Tài sản đã phát sinh bảo trì."
            : _count.damageReports > 0
              ? "Tài sản đã phát sinh báo hỏng."
              : asset.sourcePurchaseOrderId || asset.sourceReceiptId
                ? "Tài sản đã liên kết chứng từ mua hàng/nhập hàng."
                : payableDebt
                  ? `Tài sản đã phát sinh công nợ ${payableDebt.code}.`
                  : journaledAssetIds.has(asset.id)
                  ? "Tài sản đã phát sinh bút toán kế toán."
                  : openingBalanceAssetCodes.has(asset.code)
                    ? "Tài sản được tạo từ số dư đầu kỳ."
                    : isLockedPeriod
                      ? `Tài sản thuộc kỳ kế toán ${assetPeriod} đã khóa.`
                      : null;
      return {
        ...baseAsset,
        warehouseCode: asset.warehouseCode || asset.location,
        location: asset.location || asset.warehouseCode,
        allocatedPeriods,
        allocatedAmount,
        remainingPeriods,
        computedCurrentValue,
        computedStatus,
        canEditCode: !codeEditLockReason,
        codeEditLockReason,
        payableDebtCode: payableDebt?.code || null,
        payableDebtStatus: payableDebt?.status || null,
        lotCount: lotCountByCode.get(asset.code) || 1,
      };
    });

    const filtered = statusParam && statusParam !== "ALL"
      ? enriched.filter((a) => a.computedStatus === statusParam || a.status === statusParam)
      : enriched;

    return NextResponse.json(filtered);
  } catch (error) {
    console.error("Error fetching assets:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const auth = requireMenuAction(request, "/assets", "create");
    if (!auth.ok) return auth.response;

    const body = await request.json();
    /**
     * Mua tăng vào mã đã có (lib/asset-lot.ts): đợt mới dùng lại mã, tên, nhóm, phòng ban, cửa
     * hàng, kho của đợt trước; chỉ số lượng, ngày mua, nguyên giá, số kỳ, NCC, thanh toán là của
     * đợt này. Đọc từ đợt mới nhất TRONG transaction (nextAssetLot) chứ không tin dữ liệu form.
     */
    const reuseCode = body.reuseCode === true;
    const reuseCodeValue = reuseCode ? normalizeAssetCode(body.code) : "";
    if (reuseCode && !reuseCodeValue) {
      return NextResponse.json({ error: "Mua tăng vào mã đã có thì phải chọn mã tài sản" }, { status: 400 });
    }
    const reuseTemplate = reuseCode
      ? await prisma.assetRecord.findFirst({ where: { code: reuseCodeValue }, orderBy: { lotNo: "desc" } })
      : null;
    if (reuseCode && !reuseTemplate) {
      return NextResponse.json({ error: `Mã tài sản ${reuseCodeValue} không tồn tại; tạo hồ sơ mới thay vì mua tăng` }, { status: 400 });
    }
    const name = reuseTemplate ? reuseTemplate.name : cleanText(body.name);
    const branchCode = reuseTemplate ? reuseTemplate.branchCode : cleanText(body.branchCode);
    const assetGroup = reuseTemplate ? reuseTemplate.assetGroup : cleanText(body.assetGroup);
    const originalCost = toAmount(body.originalCost);
    const warehouseCode = reuseTemplate
      ? (reuseTemplate.warehouseCode || reuseTemplate.location || "")
      : (cleanText(body.warehouseCode) || cleanText(body.location));
    const departmentCode = reuseTemplate ? (reuseTemplate.departmentCode || "") : cleanText(body.departmentCode);
    const quantity = toAmount(body.quantity) || 1;
    const usefulLifeMonths = body.usefulLifeMonths !== undefined && body.usefulLifeMonths !== "" ? Math.floor(toAmount(body.usefulLifeMonths)) : null;
    const purchaseDate = body.purchaseDate ? new Date(String(body.purchaseDate)) : new Date();
    const paymentStatus = cleanText(body.paymentStatus).toUpperCase() || "PAID";
    const payableAmount = paymentStatus === "PAYABLE" ? (toAmount(body.payableAmount) || originalCost) : 0;
    const paymentDueDate = body.paymentDueDate ? new Date(String(body.paymentDueDate)) : null;
    const supplierCode = cleanText(body.supplierCode);
    const supplierName = cleanText(body.supplierName);
    const manualCode = reuseCode ? "" : normalizeAssetCode(body.code);

    // Theo dõi quản trị không cần nguyên giá — 0 hợp lệ, chỉ cấm số âm; riêng tài sản
    // ghi công nợ vẫn phải có nguyên giá thật vì nó sinh bút toán và sổ phải trả.
    if (!name || !branchCode || !assetGroup) {
      return NextResponse.json({ error: "Tên tài sản, chi nhánh và nhóm tài sản là bắt buộc" }, { status: 400 });
    }
    if (originalCost < 0) {
      return NextResponse.json({ error: "Nguyên giá không được âm" }, { status: 400 });
    }
    if (paymentStatus === "PAYABLE" && originalCost <= 0) {
      return NextResponse.json({ error: "Tài sản ghi công nợ phải có nguyên giá lớn hơn 0" }, { status: 400 });
    }

    if (quantity <= 0) {
      return NextResponse.json({ error: "Số lượng phải lớn hơn 0" }, { status: 400 });
    }

    if (usefulLifeMonths !== null && usefulLifeMonths <= 0) {
      return NextResponse.json({ error: "Số kỳ khấu hao phải lớn hơn 0" }, { status: 400 });
    }

    if (Number.isNaN(purchaseDate.getTime()) || (paymentDueDate && Number.isNaN(paymentDueDate.getTime()))) {
      return NextResponse.json({ error: "Ngày mua hoặc hạn thanh toán không hợp lệ" }, { status: 400 });
    }
    if (!manualCode && !reuseCode && !departmentCode) {
      return NextResponse.json({ error: "Phòng ban là bắt buộc khi hệ thống tự sinh mã tài sản" }, { status: 400 });
    }
    if (!["PAID", "PAYABLE"].includes(paymentStatus)) {
      return NextResponse.json({ error: "Trạng thái thanh toán chỉ nhận Đã thanh toán hoặc Công nợ phải trả" }, { status: 400 });
    }
    if (paymentStatus === "PAYABLE" && !supplierCode) {
      return NextResponse.json({ error: "Nhà cung cấp là bắt buộc khi ghi nhận công nợ phải trả" }, { status: 400 });
    }
    if (paymentStatus === "PAYABLE" && payableAmount !== originalCost) {
      return NextResponse.json({ error: "Công nợ tài sản phải bằng nguyên giá; khoản đã trả cần được ghi nhận bằng chứng từ thanh toán riêng" }, { status: 400 });
    }
    if (paymentDueDate && paymentDueDate < purchaseDate) {
      return NextResponse.json({ error: "Hạn thanh toán không được trước ngày mua" }, { status: 400 });
    }

    try {
      assertBranchAccess(auth.session, branchCode);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Lỗi phân quyền chi nhánh" }, { status: 403 });
    }

    const [assetGroupItem, department, supplier] = await Promise.all([
      prisma.masterDataItem.findFirst({ where: { type: "ASSET_GROUP", status: "ACTIVE", code: assetGroup } }),
      departmentCode
        ? prisma.masterDataItem.findFirst({
            where: {
              type: "DEPARTMENT", status: "ACTIVE", code: departmentCode,
              OR: [{ branch: branchCode }, { branch: "ALL" }, { branch: null }],
            },
          })
        : null,
      supplierCode
        ? prisma.masterDataItem.findFirst({
            where: {
              type: "PARTNER", status: "ACTIVE", code: supplierCode,
              OR: [
                { partnerType: { in: ["SUPPLIER", "BOTH"] } },
                { partnerType: null, group: { in: ["SUPPLIER", "BOTH"] } },
              ],
            },
          })
        : null,
    ]);
    if (!assetGroupItem) {
      return NextResponse.json({ error: `Nhóm tài sản ${assetGroup} không tồn tại hoặc đã ngưng dùng` }, { status: 400 });
    }
    if (departmentCode && !department) {
      return NextResponse.json({ error: `Phòng ban ${departmentCode} không hợp lệ hoặc không thuộc chi nhánh ${branchCode}` }, { status: 400 });
    }
    if (supplierCode && !supplier) {
      return NextResponse.json({ error: `Đối tác ${supplierCode} không phải Nhà cung cấp/Phải trả đang hoạt động` }, { status: 400 });
    }

    if (warehouseCode) {
      const warehouse = await prisma.masterDataItem.findFirst({
        where: {
          type: "WAREHOUSE",
          status: "ACTIVE",
          code: warehouseCode,
          OR: [{ branch: branchCode }, { branch: "ALL" }, { branch: null }],
        },
      });
      if (!warehouse) {
        return NextResponse.json({ error: `Vị trí/Kho ${warehouseCode} không hợp lệ hoặc không thuộc chi nhánh ${branchCode}` }, { status: 400 });
      }
    }

    // Ghi tăng tài sản luôn sinh bút toán Nợ 211/242 dù trả tiền ngay hay còn nợ, nên luật
    // khoá sổ áp cho mọi hình thức thanh toán. Bản cũ chỉ chặn nhánh PAYABLE: mua trả tiền
    // ngay vẫn ghi tăng được vào tháng đã chốt, tài sản lên danh sách mà sổ cái không có gì.
    const lockedAsset = await findClosedPeriod({ date: purchaseDate, branchCode });
    if (lockedAsset) {
      return NextResponse.json({ error: closedPeriodMessage(lockedAsset, "ghi tăng tài sản") }, { status: 409 });
    }
    const accounts = paymentStatus === "PAYABLE" ? await ensureDefaultAccounts() : [];
    const accountByCode = new Map(accounts.map((account) => [account.code, account.id]));
    const debitAccountCode = ["CCDC", "TOOL"].includes(cleanText(assetGroupItem.group).toUpperCase()) ? "242" : "211";

    const asset = await prismaRaw.$transaction(async (tx) => {
      const lot = reuseCode
        ? await nextAssetLot(tx, reuseCodeValue)
        : { code: manualCode ? await assertAssetCodeAvailable(tx, manualCode) : await nextAssetCode(tx, assetGroup, departmentCode), lotNo: 1 };
      const code = lot.code;
      const created = await tx.assetRecord.create({ data: {
        code,
        lotNo: lot.lotNo,
        name,
        branchCode,
        departmentCode: departmentCode || null,
        assetGroup,
        imageUrl: cleanText(body.imageUrl) || null,
        location: warehouseCode || null,
        warehouseCode: warehouseCode || null,
        quantity,
        purchaseDate,
        originalCost,
        currentValue: toAmount(body.currentValue) || originalCost,
        usefulLifeMonths,
        depreciationStartDate: body.depreciationStartDate ? new Date(String(body.depreciationStartDate)) : null,
        residualValue: toAmount(body.residualValue) || 0,
        supplierCode: supplierCode || null,
        supplierName: supplierName || supplier?.name || null,
        paymentStatus,
        payableAmount,
        paymentDueDate,
        status: cleanText(body.status) || "IN_USE",
        note: cleanText(body.note) || null,
      } });

      if (paymentStatus === "PAYABLE") {
        await tx.debtRecord.create({ data: {
          code: assetPayableCode(created),
          debtType: "PAYABLE",
          partnerGroup: "SUPPLIER",
          partnerCode: supplierCode,
          partnerName: supplierName || supplier?.name || supplierCode,
          branchCode,
          documentDate: purchaseDate,
          dueDate: paymentDueDate,
          originalAmount: payableAmount,
          outstandingAmount: payableAmount,
          description: `Công nợ mua tài sản/CCDC ${created.code}${created.lotNo > 1 ? ` (đợt ${created.lotNo})` : ""} - ${created.name}`,
          sourceType: "ASSET",
          sourceId: created.id,
          status: "OPEN",
        } });
        const debitAccountId = accountByCode.get(debitAccountCode);
        const payableAccountId = accountByCode.get("331");
        if (!debitAccountId || !payableAccountId) throw new Error("Thiếu tài khoản kế toán 211/242 hoặc 331");
        await tx.journalEntry.create({ data: {
          code: assetAcquisitionJournalCode(created),
          entryDate: purchaseDate,
          period: periodFromDate(purchaseDate),
          branchCode,
          sourceType: "ASSET_ACQUISITION",
          sourceId: created.id,
          sourceCode: created.code,
          description: `Ghi nhận mua tài sản/CCDC công nợ ${created.code}`,
          status: "POSTED",
          createdBy: auth.session.name,
          lines: { create: [
            { accountId: debitAccountId, debit: originalCost, credit: 0, departmentCode: departmentCode || null, description: created.name },
            { accountId: payableAccountId, debit: 0, credit: payableAmount, partnerCode: supplierCode, description: created.name },
          ] },
        } });
      }
      return created;
    });

    return NextResponse.json(asset, { status: 201 });
  } catch (error) {
    if (error instanceof AssetCodeError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (typeof error === "object" && error && "code" in error && error.code === "P2002") {
      return NextResponse.json({ error: "Mã tài sản đã tồn tại. Vui lòng dùng mã khác." }, { status: 409 });
    }
    console.error("Error creating asset:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

/**
 * Đổi hình thức thanh toán của tài sản đã tạo: Đã thanh toán ↔ Công nợ phải trả NCC.
 *
 * Khách báo 26/09/2026: nhiều mã tạo lúc form còn mặc định "Đã thanh toán" (NCC Shopee, Nguyễn
 * Thị Phương Thảo...) nên không có công nợ; sau khi đổi mặc định sang Công nợ thì các mã cũ không
 * sửa được vì thông tin thanh toán bị khoá từ lúc tạo. Đổi ở đây sinh/gỡ đúng khoản phải trả
 * CN-<mã> và ghi lại bút toán ghi tăng (Có 411 ↔ Có 331) trong cùng một thao tác, nên sổ nợ và
 * sổ cái không lệch nhau.
 *
 * Không cho đổi khi: tài sản sinh từ đơn mua hàng (công nợ nằm ở phiếu nhập mua) hoặc từ số dư
 * đầu kỳ; kỳ ngày mua đã khoá; công nợ đã được trả một phần/tất toán (phải bỏ gạch nợ trước).
 */
async function changeAssetPaymentStatus(
  current: NonNullable<Awaited<ReturnType<typeof prisma.assetRecord.findUnique>>>,
  body: Record<string, unknown>,
  session: DemoSession,
) {
  const nextStatus = cleanText(body.paymentStatus).toUpperCase();
  const currentStatus = current.paymentStatus === "PAYABLE" ? "PAYABLE" : "PAID";
  if (!["PAID", "PAYABLE"].includes(nextStatus)) {
    return NextResponse.json({ error: "Trạng thái thanh toán chỉ nhận Đã thanh toán hoặc Công nợ phải trả" }, { status: 400 });
  }
  if (nextStatus === currentStatus) return NextResponse.json(current);
  try {
    assertBranchAccess(session, current.branchCode);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Lỗi phân quyền chi nhánh" }, { status: 403 });
  }
  if (isDisposedAsset(current)) {
    return NextResponse.json({ error: `Tài sản ${current.code} đã thanh lý nên không đổi được hình thức thanh toán.` }, { status: 400 });
  }
  if (current.sourcePurchaseOrderId || current.sourceReceiptId) {
    return NextResponse.json({ error: `Tài sản ${current.code} nhận từ đơn mua hàng — công nợ nằm ở phiếu nhập mua, điều chỉnh ở màn Mua hàng.` }, { status: 400 });
  }
  if (current.openingBalanceId) {
    return NextResponse.json({ error: `Tài sản ${current.code} tạo từ số dư đầu kỳ — công nợ đầu kỳ khai ở Số dư đầu kỳ / Công nợ đối tác.` }, { status: 400 });
  }
  const locked = await findClosedPeriod({ date: current.purchaseDate, branchCode: current.branchCode });
  if (locked) {
    return NextResponse.json({ error: closedPeriodMessage(locked, "đổi hình thức thanh toán tài sản") }, { status: 409 });
  }

  const assetGroupItem = await prisma.masterDataItem.findFirst({ where: { type: "ASSET_GROUP", code: current.assetGroup }, select: { group: true } });
  const debitAccountCode = ["CCDC", "TOOL"].includes(cleanText(assetGroupItem?.group).toUpperCase()) ? "242" : "211";
  const existingDebt = await prisma.debtRecord.findFirst({ where: { sourceType: "ASSET", sourceId: current.id } });

  let updated;
  if (nextStatus === "PAYABLE") {
    const supplierCode = cleanText(body.supplierCode) || current.supplierCode || "";
    const paymentDueDate = cleanText(body.paymentDueDate) ? new Date(String(body.paymentDueDate)) : null;
    if (current.originalCost <= 0) {
      return NextResponse.json({ error: "Tài sản ghi công nợ phải có nguyên giá lớn hơn 0 — nhập nguyên giá trước." }, { status: 400 });
    }
    if (!supplierCode) return NextResponse.json({ error: "Chọn nhà cung cấp trước khi chuyển sang công nợ phải trả." }, { status: 400 });
    if (paymentDueDate && (Number.isNaN(paymentDueDate.getTime()) || paymentDueDate < current.purchaseDate)) {
      return NextResponse.json({ error: "Hạn thanh toán không hợp lệ hoặc trước ngày mua" }, { status: 400 });
    }
    if (existingDebt) {
      return NextResponse.json({ error: `Tài sản ${current.code} đã có công nợ ${existingDebt.code}.` }, { status: 409 });
    }
    const supplier = await prisma.masterDataItem.findFirst({
      where: {
        type: "PARTNER", status: "ACTIVE", code: supplierCode,
        OR: [{ partnerType: { in: ["SUPPLIER", "BOTH"] } }, { partnerType: null, group: { in: ["SUPPLIER", "BOTH"] } }],
      },
    });
    if (!supplier) return NextResponse.json({ error: `Đối tác ${supplierCode} không phải Nhà cung cấp/Phải trả đang hoạt động` }, { status: 400 });
    const debtCode = assetPayableCode(current);
    updated = await prisma.$transaction(async (tx) => {
      const asset = await tx.assetRecord.update({
        where: { id: current.id },
        data: { paymentStatus: "PAYABLE", payableAmount: current.originalCost, paymentDueDate, supplierCode, supplierName: supplier.name },
      });
      const debtData = {
        debtType: "PAYABLE",
        partnerGroup: "SUPPLIER",
        partnerCode: supplierCode,
        partnerName: supplier.name,
        branchCode: current.branchCode,
        documentDate: current.purchaseDate,
        dueDate: paymentDueDate,
        originalAmount: current.originalCost,
        outstandingAmount: current.originalCost,
        description: `Công nợ mua tài sản/CCDC ${current.code}${current.lotNo > 1 ? ` (đợt ${current.lotNo})` : ""} - ${current.name}`,
        sourceType: "ASSET",
        sourceId: current.id,
        status: "OPEN",
      };
      // Mã CN-<mã> có thể còn nằm trong Thùng rác (đổi qua đổi lại) — upsert khôi phục luôn.
      await tx.debtRecord.upsert({ where: { code: debtCode }, create: { code: debtCode, ...debtData }, update: debtData });
      return asset;
    });
  } else {
    if (existingDebt) {
      const settled = await prisma.debtSettlement.count({ where: { debtId: existingDebt.id } });
      if (settled > 0 || existingDebt.status !== "OPEN" || Math.abs(existingDebt.outstandingAmount - existingDebt.originalAmount) > 0.5) {
        return NextResponse.json({ error: `Công nợ ${existingDebt.code} đã được trả một phần hoặc tất toán — bỏ phiếu chi gạch nợ trước rồi mới đổi sang Đã thanh toán.` }, { status: 409 });
      }
    }
    updated = await prisma.$transaction(async (tx) => {
      if (existingDebt) await tx.debtRecord.delete({ where: { id: existingDebt.id } });
      return tx.assetRecord.update({ where: { id: current.id }, data: { paymentStatus: "PAID", payableAmount: 0, paymentDueDate: null } });
    });
  }

  // Bút toán ghi tăng: cùng luật với Đồng bộ ghi sổ (lib/accounting.ts) — Nợ 211/242, Có 331 khi
  // còn nợ NCC, Có 411 khi đã trả. Bút toán đã xoá mềm vẫn giữ khoá sourceType+sourceId nên xoá
  // cứng trước, nếu không lần ghi mới đâm ràng buộc unique.
  await prismaRaw.journalEntry.deleteMany({ where: { sourceType: "ASSET_ACQUISITION", sourceId: current.id, deletedAt: { not: null } } });
  let journalStatus = "SKIPPED_ZERO";
  if (updated.originalCost > 0) {
    const payable = updated.paymentStatus === "PAYABLE";
    journalStatus = await postJournalEntry({
      entryDate: updated.purchaseDate,
      branchCode: updated.branchCode,
      sourceType: "ASSET_ACQUISITION",
      sourceId: updated.id,
      sourceCode: updated.code,
      description: `Ghi tăng tài sản ${updated.name}`,
      createdBy: session.name,
      lines: [
        { accountCode: debitAccountCode, debit: updated.originalCost, partnerCode: updated.supplierCode },
        { accountCode: payable ? "331" : "411", credit: updated.originalCost, partnerCode: payable ? updated.supplierCode : null },
      ],
    });
  }

  await writeAuditLog({
    session,
    module: auditModule,
    action: "CHANGE_PAYMENT_STATUS",
    entityType: "AssetRecord",
    entityId: current.id,
    entityCode: current.code,
    branchCode: current.branchCode,
    message: `Đổi thanh toán ${currentStatus === "PAID" ? "Đã thanh toán" : "Công nợ"} → ${nextStatus === "PAID" ? "Đã thanh toán" : "Công nợ"}`,
    metadata: { before: currentStatus, after: nextStatus, debtCode: assetPayableCode(current), supplierCode: updated.supplierCode, amount: updated.originalCost, journalStatus },
  });
  return NextResponse.json(updated);
}

export async function PATCH(request: Request) {
  try {
    const auth = requireMenuAction(request, "/assets", "edit");
    if (!auth.ok) return auth.response;

    const body = await request.json();
    const id = cleanText(body.id);
    if (!id) return NextResponse.json({ error: "Thiếu ID tài sản" }, { status: 400 });

    const current = await prisma.assetRecord.findUnique({ where: { id } });
    if (!current) return NextResponse.json({ error: "Không tìm thấy tài sản" }, { status: 404 });

    if (cleanText(body.action) === "CHANGE_PAYMENT") {
      return changeAssetPaymentStatus(current, body, auth.session);
    }

    if (["paymentStatus", "payableAmount", "paymentDueDate"].some((field) => body[field] !== undefined)) {
      return NextResponse.json({ error: "Thông tin thanh toán/công nợ chỉ được xác lập khi tạo tài sản; hãy dùng chứng từ công nợ để điều chỉnh sau đó" }, { status: 409 });
    }
    if (current.paymentStatus === "PAYABLE" && (
      (body.supplierCode !== undefined && cleanText(body.supplierCode) !== (current.supplierCode || ""))
      || (body.supplierName !== undefined && cleanText(body.supplierName) !== (current.supplierName || ""))
    )) {
      return NextResponse.json({ error: "Không thể đổi nhà cung cấp vì tài sản đã phát sinh công nợ phải trả" }, { status: 409 });
    }

    if (isDisposedAsset(current)) {
      return NextResponse.json(
        { error: `Tài sản ${current.code} đã thanh lý nên không thể chỉnh sửa.` },
        { status: 400 },
      );
    }

    const depreciationCount = await prisma.assetDepreciation.count({ where: { assetId: id } });
    if (depreciationCount > 0) {
      const lockedTouched = depreciationLockedFields.filter((field) => body[field] !== undefined);
      if (lockedTouched.length > 0) {
        return NextResponse.json(
          {
            error: `Tài sản ${current.code} đã trích khấu hao ${depreciationCount} kỳ nên không thể sửa số lượng, ngày mua, nguyên giá, số kỳ khấu hao, ngày bắt đầu khấu hao hoặc giá trị thu hồi. Chỉ được cập nhật thông tin quản lý.`,
          },
          { status: 400 },
        );
      }
    }

    if (body.name !== undefined && !cleanText(body.name)) {
      return NextResponse.json({ error: "Tên tài sản không được để trống" }, { status: 400 });
    }
    if (body.assetGroup !== undefined && !cleanText(body.assetGroup)) {
      return NextResponse.json({ error: "Nhóm tài sản không được để trống" }, { status: 400 });
    }
    if (body.branchCode !== undefined && !cleanText(body.branchCode)) {
      return NextResponse.json({ error: "Chi nhánh không được để trống" }, { status: 400 });
    }
    if (body.quantity !== undefined && toAmount(body.quantity) <= 0) {
      return NextResponse.json({ error: "Số lượng phải lớn hơn 0" }, { status: 400 });
    }
    // Theo dõi quản trị không cần nguyên giá — 0 hợp lệ, chỉ cấm số âm.
    if (body.originalCost !== undefined && toAmount(body.originalCost) < 0) {
      return NextResponse.json({ error: "Nguyên giá không được âm" }, { status: 400 });
    }
    if (body.currentValue !== undefined && toAmount(body.currentValue) < 0) {
      return NextResponse.json({ error: "Giá trị còn lại không được âm" }, { status: 400 });
    }
    if (body.residualValue !== undefined && toAmount(body.residualValue) < 0) {
      return NextResponse.json({ error: "Giá trị thu hồi ước tính không được âm" }, { status: 400 });
    }
    if (
      body.usefulLifeMonths !== undefined
      && body.usefulLifeMonths !== null
      && body.usefulLifeMonths !== ""
      && Math.floor(toAmount(body.usefulLifeMonths)) <= 0
    ) {
      return NextResponse.json({ error: "Số kỳ khấu hao phải lớn hơn 0" }, { status: 400 });
    }

    const targetBranch = body.branchCode !== undefined ? cleanText(body.branchCode) : current.branchCode;
    const nextCode = body.code !== undefined ? normalizeAssetCode(body.code) : current.code;
    if (body.code !== undefined && !nextCode) {
      return NextResponse.json({ error: "Mã tài sản không được để trống khi chỉnh sửa." }, { status: 400 });
    }
    const codeChanged = Boolean(nextCode && nextCode !== current.code);
    if (codeChanged) {
      // Mã có nhiều đợt: đổi mã của riêng một đợt là tách nó khỏi các đợt còn lại — không cho.
      const lotCount = await prismaRaw.assetRecord.count({ where: { code: current.code } });
      if (lotCount > 1) {
        return NextResponse.json({ error: `Không thể đổi mã tài sản ${current.code} vì mã này có ${lotCount} đợt mua.` }, { status: 409 });
      }
      const [maintenanceCount, damageCount, journalCount, openingBalanceCount, debtCount, lockedPeriod] = await Promise.all([
        prismaRaw.assetMaintenance.count({ where: { assetId: id } }),
        prismaRaw.assetDamageReport.count({ where: { assetId: id } }),
        prismaRaw.journalEntry.count({ where: { sourceType: "ASSET_ACQUISITION", sourceId: id } }),
        prismaRaw.openingBalance.count({ where: { balanceType: "ASSET", objectCode: current.code } }),
        prismaRaw.debtRecord.count({ where: { sourceType: "ASSET", sourceId: id, deletedAt: null } }),
        isPeriodLocked(current.purchaseDate, current.branchCode),
      ]);
      const lockReason = depreciationCount > 0
        ? `đã trích khấu hao ${depreciationCount} kỳ`
        : maintenanceCount > 0
          ? "đã phát sinh bảo trì"
          : damageCount > 0
            ? "đã phát sinh báo hỏng"
            : current.sourcePurchaseOrderId || current.sourceReceiptId
              ? "đã liên kết chứng từ mua hàng/nhập hàng"
              : debtCount > 0
                ? "đã phát sinh công nợ phải trả"
                : journalCount > 0
                ? "đã phát sinh bút toán kế toán"
                : openingBalanceCount > 0
                  ? "được tạo từ số dư đầu kỳ"
                  : lockedPeriod
                    ? `thuộc kỳ kế toán ${periodFromDate(current.purchaseDate)} đã khóa`
                    : null;
      if (lockReason) {
        return NextResponse.json({ error: `Không thể đổi mã tài sản ${current.code} vì hồ sơ ${lockReason}.` }, { status: 409 });
      }
    }

    try {
      assertBranchAccess(auth.session, current.branchCode);
      if (body.branchCode !== undefined) {
        assertBranchAccess(auth.session, targetBranch);
      }
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Lỗi phân quyền chi nhánh" }, { status: 403 });
    }

    const warehouseCode = body.warehouseCode !== undefined ? cleanText(body.warehouseCode) : body.location !== undefined ? cleanText(body.location) : undefined;
    if (warehouseCode) {
      const warehouse = await prisma.masterDataItem.findFirst({
        where: {
          type: "WAREHOUSE",
          status: "ACTIVE",
          code: warehouseCode,
          OR: [{ branch: targetBranch }, { branch: "ALL" }, { branch: null }],
        },
      });
      if (!warehouse) {
        return NextResponse.json({ error: `Vị trí/Kho ${warehouseCode} không hợp lệ hoặc không thuộc chi nhánh ${targetBranch}` }, { status: 400 });
      }
    }

    const asset = await prismaRaw.$transaction(async (tx) => {
      const validatedCode = codeChanged ? await assertAssetCodeAvailable(tx, nextCode, id) : current.code;
      return tx.assetRecord.update({ where: { id }, data: {
        ...(codeChanged ? { code: validatedCode } : {}),
        ...(body.name !== undefined ? { name: cleanText(body.name) } : {}),
        ...(body.branchCode !== undefined ? { branchCode: targetBranch } : {}),
        ...(body.departmentCode !== undefined ? { departmentCode: cleanText(body.departmentCode) || null } : {}),
        ...(body.assetGroup !== undefined ? { assetGroup: cleanText(body.assetGroup) } : {}),
        ...(body.imageUrl !== undefined ? { imageUrl: cleanText(body.imageUrl) || null } : {}),
        ...(warehouseCode !== undefined ? { location: warehouseCode || null, warehouseCode: warehouseCode || null } : {}),
        ...(body.quantity !== undefined ? { quantity: toAmount(body.quantity) || 1 } : {}),
        ...(body.purchaseDate !== undefined ? { purchaseDate: new Date(String(body.purchaseDate)) } : {}),
        ...(body.originalCost !== undefined ? { originalCost: toAmount(body.originalCost) } : {}),
        ...(body.currentValue !== undefined ? { currentValue: toAmount(body.currentValue) } : {}),
        ...(body.usefulLifeMonths !== undefined ? { usefulLifeMonths: Math.floor(toAmount(body.usefulLifeMonths)) || null } : {}),
        ...(body.depreciationStartDate !== undefined ? { depreciationStartDate: body.depreciationStartDate ? new Date(String(body.depreciationStartDate)) : null } : {}),
        ...(body.residualValue !== undefined ? { residualValue: toAmount(body.residualValue) } : {}),
        ...(body.supplierCode !== undefined ? { supplierCode: cleanText(body.supplierCode) || null } : {}),
        ...(body.supplierName !== undefined ? { supplierName: cleanText(body.supplierName) || null } : {}),
        ...(body.status !== undefined ? { status: cleanText(body.status) || "IN_USE" } : {}),
        ...(body.note !== undefined ? { note: cleanText(body.note) || null } : {}),
      } });
    });

    await writeAuditLog({
      session: auth.session,
      module: auditModule,
      action: "UPDATE_ASSET",
      entityType: "AssetRecord",
      entityId: asset.id,
      entityCode: asset.code,
      branchCode: asset.branchCode,
      metadata: {
        changedFields: Object.keys(body).filter((field) => field !== "id" && field !== "action"),
        depreciationCount,
        ...(codeChanged ? { oldCode: current.code, newCode: asset.code } : {}),
      },
    });

    return NextResponse.json(asset);
  } catch (error) {
    if (error instanceof AssetCodeError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (typeof error === "object" && error && "code" in error && error.code === "P2002") {
      return NextResponse.json({ error: "Mã tài sản đã tồn tại. Vui lòng dùng mã khác." }, { status: 409 });
    }
    console.error("Error updating asset:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

/**
 * Xoá mềm tài sản.
 * query: ?id=<assetId>&type=ASSET&reason=<lý do>
 */
export async function DELETE(request: Request) {
  try {
    const auth = requireMenuAction(request, "/assets", "delete");
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const type = (cleanText(searchParams.get("type")) || cleanText(searchParams.get("entity")) || "ASSET").toUpperCase();
    const id = cleanText(searchParams.get("id"));
    const reason = cleanText(searchParams.get("reason"));

    if (!["ASSET", "ASSETRECORD", "ASSET_RECORD"].includes(type)) {
      return NextResponse.json({ error: `Loại dữ liệu "${type}" không được hỗ trợ ở màn hình tài sản` }, { status: 400 });
    }
    if (!id) return NextResponse.json({ error: "Thiếu ID tài sản cần xoá" }, { status: 400 });

    const current = await prisma.assetRecord.findUnique({ where: { id } });
    if (!current) return NextResponse.json({ error: "Không tìm thấy tài sản" }, { status: 404 });

    try {
      assertBranchAccess(auth.session, current.branchCode);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Lỗi phân quyền chi nhánh" }, { status: 403 });
    }

    if (isDisposedAsset(current)) {
      return NextResponse.json(
        { error: `Tài sản ${current.code} đã thanh lý nên không thể xoá. Hồ sơ thanh lý cần được lưu để đối chiếu sổ sách.` },
        { status: 400 },
      );
    }

    const depreciationCount = await prisma.assetDepreciation.count({ where: { assetId: id } });
    if (depreciationCount > 0) {
      return NextResponse.json(
        { error: `Tài sản ${current.code} đã trích khấu hao ${depreciationCount} kỳ nên không thể xoá. Hãy thanh lý tài sản thay vì xoá.` },
        { status: 400 },
      );
    }

    const [debtCount, journalCount] = await Promise.all([
      prismaRaw.debtRecord.count({ where: { sourceType: "ASSET", sourceId: id, deletedAt: null } }),
      prismaRaw.journalEntry.count({ where: { sourceType: "ASSET_ACQUISITION", sourceId: id, deletedAt: null } }),
    ]);
    if (debtCount > 0 || journalCount > 0) {
      return NextResponse.json({ error: `Tài sản ${current.code} đã phát sinh công nợ/bút toán kế toán nên không thể xóa` }, { status: 409 });
    }

    const result = await softDeleteRecord({
      model: "AssetRecord",
      id,
      session: auth.session,
      reason: reason || null,
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof SoftDeleteError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Error deleting asset:", error);
    return NextResponse.json({ error: "Không xoá được tài sản" }, { status: 500 });
  }
}
