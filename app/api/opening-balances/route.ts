import { NextResponse } from "next/server";
import { isAdmin, requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { assertBranchAccess, branchFilterForSession } from "@/lib/accounting";
import { prisma } from "@/lib/prisma";

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function toAmount(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function addPeriod(period: string, monthsToAdd: number): string {
  const [yearStr, monthStr] = period.split("-");
  let year = parseInt(yearStr, 10);
  let month = parseInt(monthStr, 10) + monthsToAdd - 1;
  year += Math.floor(month / 12);
  month = (month % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

export async function GET(request: Request) {
  try {
    const auth = requireMenuAccess(request, "/opening-balances");
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status") || undefined;
    const balanceType = searchParams.get("balanceType") || undefined;
    const branchFilter = branchFilterForSession(auth.session, searchParams.get("branchCode") || "ALL");

    const balances = await prisma.openingBalance.findMany({
      where: {
        ...branchFilter,
        ...(status && status !== "ALL" ? { status } : {}),
        ...(balanceType && balanceType !== "ALL" ? { balanceType } : {}),
      },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    });

    return NextResponse.json(balances);
  } catch (error) {
    console.error("Error fetching opening balances:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const auth = requireMenuAction(request, "/opening-balances", "config");
    if (!auth.ok) return auth.response;

    const body = await request.json();
    const period = cleanText(body.period);
    const branchCode = cleanText(body.branchCode);
    const balanceType = cleanText(body.balanceType);
    const amount = toAmount(body.amount);
    const status = cleanText(body.status) || "DRAFT";

    if (!period || !branchCode || !balanceType) {
      return NextResponse.json({ error: "Kỳ, chi nhánh và loại số dư là bắt buộc" }, { status: 400 });
    }

    try {
      assertBranchAccess(auth.session, branchCode);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Không có quyền chi nhánh" }, { status: 403 });
    }

    if (!["DRAFT", "CONFIRMED"].includes(status)) {
      return NextResponse.json({ error: "Trạng thái số dư không hợp lệ" }, { status: 400 });
    }

    const isSourceType = ["CASH", "BANK", "WALLET_POS"].includes(balanceType);
    const isObjectType = ["AR", "AP", "DEPOSIT"].includes(balanceType);
    const isInventoryType = balanceType === "INVENTORY";
    const isAssetType = balanceType === "ASSET";
    const isPrepaidType = balanceType === "PREPAID_EXPENSE";

    const moneySourceCode = cleanText(body.moneySourceCode);
    const objectCode = cleanText(body.objectCode);
    const objectName = cleanText(body.objectName);
    const warehouseCode = cleanText(body.warehouseCode);
    const departmentCode = cleanText(body.departmentCode);
    const allocationMonths = Math.floor(toAmount(body.allocationMonths));
    const allocationStartPeriod = cleanText(body.allocationStartPeriod);

    if (isSourceType && !moneySourceCode) {
      return NextResponse.json({ error: "Đối với số dư quỹ/ngân hàng/ví, bắt buộc phải chọn Nguồn tiền" }, { status: 400 });
    }

    if (isObjectType && !objectCode) {
      return NextResponse.json({ error: "Đối với số dư công nợ/tiền cọc, bắt buộc phải chọn Đối tượng" }, { status: 400 });
    }

    if (isInventoryType && (!objectCode || !warehouseCode)) {
      return NextResponse.json({ error: "Đối với tồn kho đầu kỳ, bắt buộc có Mã hàng và Kho" }, { status: 400 });
    }

    if (isAssetType && (!objectCode || !objectName)) {
      return NextResponse.json({ error: "Đối với tài sản/CCDC đầu kỳ, bắt buộc có Mã và Tên tài sản" }, { status: 400 });
    }

    if (isPrepaidType && (!objectCode || allocationMonths <= 1 || !allocationStartPeriod)) {
      return NextResponse.json({ error: "Chi phí phân bổ đầu kỳ cần mã chi phí, số kỳ > 1 và kỳ bắt đầu" }, { status: 400 });
    }

    // Verify master data status
    const activeBranch = await prisma.masterDataItem.findUnique({
      where: { type_code: { type: "BRANCH", code: branchCode } }
    });
    if (!activeBranch || activeBranch.status !== "ACTIVE") {
      return NextResponse.json({ error: `Cửa hàng [${branchCode}] không tồn tại hoặc ngưng hoạt động` }, { status: 400 });
    }

    if (isSourceType && moneySourceCode) {
      const activeSource = await prisma.masterDataItem.findUnique({
        where: { type_code: { type: "MONEY_SOURCE", code: moneySourceCode } }
      });
      if (!activeSource || activeSource.status !== "ACTIVE") {
        return NextResponse.json({ error: `Nguồn tiền [${moneySourceCode}] không tồn tại hoặc ngưng hoạt động` }, { status: 400 });
      }
    }

    if (isObjectType && objectCode) {
      const activePartner = await prisma.masterDataItem.findUnique({
        where: { type_code: { type: "PARTNER", code: objectCode } }
      });
      if (!activePartner || activePartner.status !== "ACTIVE") {
        return NextResponse.json({ error: `Đối tác [${objectCode}] không tồn tại hoặc ngưng hoạt động` }, { status: 400 });
      }
    }

    const balance = await prisma.openingBalance.create({
      data: {
        period,
        branchCode,
        balanceType,
        objectCode: isObjectType || isInventoryType || isAssetType || isPrepaidType ? objectCode : null,
        objectName: isObjectType || isAssetType || isPrepaidType ? objectName : null,
        moneySourceCode: isSourceType ? moneySourceCode : null,
        warehouseCode: warehouseCode || null,
        departmentCode: departmentCode || null,
        quantity: body.quantity !== undefined && body.quantity !== null ? toAmount(body.quantity) : null,
        unitCost: body.unitCost !== undefined && body.unitCost !== null ? toAmount(body.unitCost) : null,
        allocationMonths: allocationMonths || null,
        allocationStartPeriod: allocationStartPeriod || null,
        amount,
        note: cleanText(body.note) || null,
        status,
      },
    });

    return NextResponse.json(balance, { status: 201 });
  } catch (error) {
    console.error("Error creating opening balance:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const auth = requireMenuAction(request, "/opening-balances", "config");
    if (!auth.ok) return auth.response;

    const body = await request.json();
    const id = cleanText(body.id);

    if (!id) {
      return NextResponse.json({ error: "Thieu ID so du" }, { status: 400 });
    }

    const current = await prisma.openingBalance.findUnique({
      where: { id },
    });

    if (!current) {
      return NextResponse.json({ error: "Khong tim thay so du dau ky" }, { status: 404 });
    }

    try {
      assertBranchAccess(auth.session, current.branchCode);
      if (body.branchCode !== undefined) assertBranchAccess(auth.session, cleanText(body.branchCode));
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Không có quyền chi nhánh" }, { status: 403 });
    }

    const requestedStatus = body.status !== undefined ? cleanText(body.status) : undefined;
    const isReopenRequest = current.status === "CONFIRMED" && requestedStatus === "DRAFT";
    const isConfirmRequest = current.status === "DRAFT" && requestedStatus === "CONFIRMED";

    if (isReopenRequest && !isAdmin(auth.session.role)) {
      return NextResponse.json({ error: "Chi Admin duoc mo lai so du da chot" }, { status: 403 });
    }

    if (current.status === "CONFIRMED" && !isReopenRequest) {
      return NextResponse.json({ error: "Khong the chinh sua so du dau ky da chot" }, { status: 400 });
    }

    if (requestedStatus && !["DRAFT", "CONFIRMED"].includes(requestedStatus)) {
      return NextResponse.json({ error: "Trang thai so du khong hop le" }, { status: 400 });
    }

    const balance = await prisma.$transaction(async (tx) => {
      // 1. Perform side effects
      if (isConfirmRequest) {
        if (current.balanceType === "INVENTORY") {
          const item = await tx.inventoryItem.findUnique({ where: { code: current.objectCode || "" } });
          if (!item) throw new Error(`Mặt hàng ${current.objectCode} không tồn tại`);
          
          // Verify warehouse exists
          const wh = await tx.masterDataItem.findUnique({
            where: { type_code: { type: "WAREHOUSE", code: current.warehouseCode || "" } }
          });
          if (!wh) throw new Error(`Kho ${current.warehouseCode} không tồn tại`);
          if (wh.branch !== current.branchCode) throw new Error(`Kho ${current.warehouseCode} không thuộc chi nhánh ${current.branchCode}`);

          await tx.inventoryBalance.upsert({
            where: { itemId_warehouseCode: { itemId: item.id, warehouseCode: current.warehouseCode || "" } },
            update: {
              quantity: current.quantity || 0,
              averageCost: current.unitCost || 0,
            },
            create: {
              itemId: item.id,
              warehouseCode: current.warehouseCode || "",
              quantity: current.quantity || 0,
              averageCost: current.unitCost || 0,
            }
          });
        } else if (current.balanceType === "ASSET") {
          // Check duplicate code
          const dup = await tx.assetRecord.findUnique({ where: { code: current.objectCode || "" } });
          if (dup) throw new Error(`Tài sản mã ${current.objectCode} đã tồn tại trong hệ thống`);

          await tx.assetRecord.create({
            data: {
              code: current.objectCode || "",
              name: current.objectName || "",
              branchCode: current.branchCode,
              departmentCode: current.departmentCode || null,
              assetGroup: current.moneySourceCode || "ASSET",
              location: current.warehouseCode ? `Kho ${current.warehouseCode}` : "Văn phòng",
              quantity: current.quantity || 1,
              purchaseDate: current.allocationStartPeriod ? new Date(current.allocationStartPeriod + "-01T00:00:00Z") : new Date(),
              originalCost: current.unitCost || current.amount,
              currentValue: current.amount,
              usefulLifeMonths: current.allocationMonths || 12,
              depreciationStartDate: current.allocationStartPeriod ? new Date(current.allocationStartPeriod + "-01T00:00:00Z") : null,
              residualValue: 0,
              supplierName: "Nhà cung cấp số dư đầu kỳ",
              status: "IN_USE",
              note: current.note || "Khởi tạo từ số dư đầu kỳ",
            }
          });
        } else if (current.balanceType === "PREPAID_EXPENSE") {
          const code = `PB-DK-${(current.objectCode || "").toUpperCase()}`;
          // Check duplicate code
          const dup = await tx.accrual.findUnique({ where: { code } });
          if (dup) throw new Error(`Chi phí phân bổ mã ${current.objectCode} đã tồn tại trong hệ thống (dưới dạng ${code})`);

          const accrual = await tx.accrual.create({
            data: {
              code,
              name: current.objectName || code,
              branchCode: current.branchCode,
              categoryCode: current.moneySourceCode || "OPEX",
              totalAmount: current.amount,
              startPeriod: current.allocationStartPeriod || current.period,
              numberOfPeriods: current.allocationMonths || 1,
              actualAmount: current.amount,
              status: "ACTIVE",
              note: current.note || "Khởi tạo từ số dư đầu kỳ",
            }
          });
          
          const amountPerPeriod = current.amount / (current.allocationMonths || 1);
          const schedules = [];
          const startPeriod = current.allocationStartPeriod || current.period;
          for (let i = 0; i < (current.allocationMonths || 1); i++) {
            schedules.push({
              accrualId: accrual.id,
              period: addPeriod(startPeriod, i),
              amount: amountPerPeriod,
              status: "PLANNED",
            });
          }
          await tx.accrualSchedule.createMany({
            data: schedules,
          });
        }
      } else if (isReopenRequest) {
        if (current.balanceType === "INVENTORY") {
          const item = await tx.inventoryItem.findUnique({ where: { code: current.objectCode || "" } });
          if (item) {
            await tx.inventoryBalance.updateMany({
              where: { itemId: item.id, warehouseCode: current.warehouseCode || "" },
              data: { quantity: 0, averageCost: 0 }
            });
          }
        } else if (current.balanceType === "ASSET") {
          await tx.assetRecord.deleteMany({
            where: { code: current.objectCode || "", branchCode: current.branchCode }
          });
        } else if (current.balanceType === "PREPAID_EXPENSE") {
          const code = `PB-DK-${(current.objectCode || "").toUpperCase()}`;
          await tx.accrual.deleteMany({
            where: { code, branchCode: current.branchCode }
          });
        }
      }

      // 2. Perform the update itself
      return await tx.openingBalance.update({
        where: { id },
        data: isReopenRequest
          ? { status: "DRAFT" }
          : {
              ...(body.period !== undefined ? { period: cleanText(body.period) } : {}),
              ...(body.branchCode !== undefined ? { branchCode: cleanText(body.branchCode) } : {}),
              ...(body.balanceType !== undefined ? { balanceType: cleanText(body.balanceType) } : {}),
              ...(body.objectCode !== undefined ? { objectCode: cleanText(body.objectCode) || null } : {}),
              ...(body.objectName !== undefined ? { objectName: cleanText(body.objectName) || null } : {}),
              ...(body.moneySourceCode !== undefined
                ? { moneySourceCode: cleanText(body.moneySourceCode) || null }
                : {}),
              ...(body.warehouseCode !== undefined ? { warehouseCode: cleanText(body.warehouseCode) || null } : {}),
              ...(body.departmentCode !== undefined ? { departmentCode: cleanText(body.departmentCode) || null } : {}),
              ...(body.quantity !== undefined ? { quantity: toAmount(body.quantity) || null } : {}),
              ...(body.unitCost !== undefined ? { unitCost: toAmount(body.unitCost) || null } : {}),
              ...(body.allocationMonths !== undefined ? { allocationMonths: Math.floor(toAmount(body.allocationMonths)) || null } : {}),
              ...(body.allocationStartPeriod !== undefined ? { allocationStartPeriod: cleanText(body.allocationStartPeriod) || null } : {}),
              ...(body.amount !== undefined ? { amount: toAmount(body.amount) } : {}),
              ...(body.note !== undefined ? { note: cleanText(body.note) || null } : {}),
              ...(requestedStatus !== undefined ? { status: requestedStatus || "DRAFT" } : {}),
            },
      });
    });

    return NextResponse.json(balance);
  } catch (error) {
    console.error("Error updating opening balance:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Internal Server Error" }, { status: 500 });
  }
}
