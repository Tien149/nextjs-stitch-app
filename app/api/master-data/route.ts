import { NextResponse } from "next/server";
import { getRequestSession, requireMenuAction } from "@/lib/api-auth";
import { assertBranchAccess, getAllowedBranches } from "@/lib/accounting";
import { prisma, prismaRaw } from "@/lib/prisma";
import { duplicatedInTrashMessage, findDeletedByUnique, softDeleteRecord } from "@/lib/soft-delete";
import { normalizeCashflowCategoryType } from "@/lib/voucher-rules";

const defaultMasterData = [
  {
    type: "BRANCH",
    code: "TC",
    name: "Van phong quan ly",
    group: "Head Office",
    status: "ACTIVE",
    note: "Don vi quan ly tai chinh va van hanh",
  },
  {
    type: "BRANCH",
    code: "HCM",
    name: "Cua hang 1",
    group: "Branch",
    status: "ACTIVE",
  },
  {
    type: "BRANCH",
    code: "HN",
    name: "Cua hang 2",
    group: "Branch",
    status: "ACTIVE",
  },
  {
    type: "DEPARTMENT",
    code: "KT",
    name: "Phong Ke toan",
    branch: "TC",
    status: "ACTIVE",
  },
  {
    type: "DEPARTMENT",
    code: "VH",
    name: "Phong Van hanh",
    branch: "TC",
    status: "ACTIVE",
  },
  {
    type: "WAREHOUSE",
    code: "KHO_HCM",
    name: "Kho nguyen vat lieu Cua hang 1",
    group: "Nguyen vat lieu/Bao bi",
    branch: "HCM",
    status: "ACTIVE",
  },
  {
    type: "WAREHOUSE",
    code: "KHO_HN",
    name: "Kho nguyen vat lieu Cua hang 2",
    group: "Nguyen vat lieu/Bao bi",
    branch: "HN",
    status: "ACTIVE",
  },
  {
    type: "MONEY_SOURCE",
    code: "TM_HCM",
    name: "Quy tien mat Cua hang 1",
    group: "CASH",
    branch: "HCM",
    status: "ACTIVE",
  },
  {
    type: "MONEY_SOURCE",
    code: "VCB_HCM",
    name: "Vietcombank Cua hang 1",
    group: "BANK",
    branch: "HCM",
    accountNo: "0071000012345",
    status: "ACTIVE",
  },
  {
    type: "MONEY_SOURCE",
    code: "POS_HN",
    name: "POS/Vi dien tu Cua hang 2",
    group: "WALLET",
    branch: "HN",
    status: "ACTIVE",
  },
  {
    type: "PARTNER",
    code: "KH_ABC",
    name: "Cong ty TNHH ABC",
    group: "CUSTOMER",
    partnerType: "CUSTOMER",
    partnerGroup: "EXTERNAL",
    taxCode: "0312345678",
    contactName: "Nguyen Van A",
    phone: "0900000001",
    email: "abc@example.com",
    status: "ACTIVE",
  },
  {
    type: "PARTNER",
    code: "KH_LE",
    name: "Khách hàng mua lẻ",
    group: "CUSTOMER",
    partnerType: "CUSTOMER",
    partnerGroup: "EXTERNAL",
    status: "ACTIVE",
    note: "Đối tượng mặc định cho tiền cọc khách lẻ",
  },
  {
    type: "PARTNER",
    code: "NCC_FOOD",
    name: "NCC Nguyen lieu",
    group: "SUPPLIER",
    partnerType: "SUPPLIER",
    partnerGroup: "EXTERNAL",
    taxCode: "0109876543",
    contactName: "Tran Thi B",
    phone: "0900000002",
    email: "coffee-supplier@example.com",
    status: "ACTIVE",
  },
  {
    type: "REVENUE_EXPENSE_CATEGORY",
    code: "REV_FOOD",
    name: "Doanh thu do uong va banh",
    group: "RECEIPT",
    note: "Dung phan loai doanh thu import tu POS",
    status: "ACTIVE",
  },
  {
    type: "REVENUE_EXPENSE_CATEGORY",
    code: "COGS_FOOD",
    name: "Gia von nguyen vat lieu va bao bi",
    group: "PAYMENT",
    note: "Dung cho COGS nguyen vat lieu",
    status: "ACTIVE",
  },
  {
    type: "REVENUE_EXPENSE_CATEGORY",
    code: "OPEX_RENT",
    name: "Chi phi thue mat bang",
    group: "PAYMENT",
    note: "Chi phi van hanh",
    status: "ACTIVE",
  },
  {
    type: "REVENUE_EXPENSE_CATEGORY",
    code: "CAPEX_EQUIPMENT",
    name: "Mua sam thiet bi quay",
    group: "PAYMENT",
    note: "Chi phi dau tu tai san",
    status: "ACTIVE",
  },
  {
    type: "ASSET_GROUP",
    code: "EQUIPMENT",
    name: "May moc thiet bi",
    group: "FIXED_ASSET",
    status: "ACTIVE",
  },
  {
    type: "ASSET_GROUP",
    code: "TOOL",
    name: "Cong cu dung cu",
    group: "CCDC",
    status: "ACTIVE",
  },
  {
    type: "ASSET_GROUP",
    code: "FURNITURE",
    name: "Noi that va decor",
    group: "FIXED_ASSET",
    status: "ACTIVE",
  },
  {
    type: "INVENTORY_ITEM_GROUP",
    code: "NVL",
    name: "Nguyen vat lieu",
    group: "RAW_MATERIAL",
    status: "ACTIVE",
  },
  {
    type: "INVENTORY_ITEM_GROUP",
    code: "BTP",
    name: "Ban thanh pham",
    group: "SEMI_FINISHED",
    status: "ACTIVE",
  },
  {
    type: "INVENTORY_ITEM_GROUP",
    code: "TP",
    name: "Thanh pham",
    group: "FINISHED",
    status: "ACTIVE",
  },
  {
    type: "INVENTORY_ITEM_GROUP",
    code: "BAOBI",
    name: "Bao bi va vat tu phu",
    group: "PACKAGING",
    status: "ACTIVE",
  },
  {
    type: "ACCOUNTING_PERIOD",
    code: "2026-07",
    name: "Ky ke toan 07/2026",
    group: "OPEN",
    note: "Trang thai mo so",
    status: "ACTIVE",
  },
  {
    type: "DOCUMENT_TYPE",
    code: "PT",
    name: "Phieu thu",
    group: "Thu",
    note: "Chung tu thu tien",
    status: "ACTIVE",
  },
  {
    type: "DOCUMENT_TYPE",
    code: "PC",
    name: "Phieu chi",
    group: "Chi",
    note: "Chung tu chi tien",
    status: "ACTIVE",
  },
  {
    type: "DOCUMENT_TYPE",
    code: "COC",
    name: "Phieu tien coc",
    group: "Tien coc",
    note: "Chung tu ghi nhan tien coc",
    status: "ACTIVE",
  },
  {
    type: "DOCUMENT_NUMBER_RULE",
    code: "RULE_PT",
    name: "Quy tac ma phieu thu",
    group: "PT",
    note: "PT-{YYYYMM}-{SEQ3}",
    status: "ACTIVE",
  },
  {
    type: "DOCUMENT_NUMBER_RULE",
    code: "RULE_PC",
    name: "Quy tac ma phieu chi",
    group: "PC",
    note: "PC-{YYYYMM}-{SEQ3}",
    status: "ACTIVE",
  },
  {
    type: "DOCUMENT_NUMBER_RULE",
    code: "RULE_COC",
    name: "Quy tac ma phieu coc",
    group: "COC",
    note: "COC-{YYYYMM}-{SEQ3}",
    status: "ACTIVE",
  },
  {
    type: "SYSTEM_PARAM",
    code: "VAT_DEFAULT",
    name: "Thue suat GTGT mac dinh",
    group: "Thue",
    note: "8%",
    status: "ACTIVE",
  },
  {
    type: "SYSTEM_PARAM",
    code: "BIZ_STATUS_OPEN",
    name: "Trang thai nghiep vu mo",
    group: "Trang thai nghiep vu",
    note: "OPEN",
    status: "ACTIVE",
  },
  {
    type: "WAREHOUSE",
    code: "KHO_HCM",
    name: "Kho hang trung tam Cua hang 1",
    group: "Kho chinh",
    branch: "HCM",
    status: "ACTIVE",
    note: "Kho luu tru thuc pham va nguyen vat lieu",
  },
  {
    type: "WAREHOUSE",
    code: "KHO_HN",
    name: "Kho hang Cua hang 2",
    group: "Kho phu",
    branch: "HN",
    status: "ACTIVE",
    note: "Kho hang phu tro",
  },
];

let seedPromise: Promise<void> | null = null;

/**
 * Nạp danh mục mẫu, CHỈ khi bảng còn trắng.
 *
 * Trước đây hàm này upsert lại toàn bộ danh sách mẫu ở MỖI lần GET. Lớp xoá mềm đặt
 * `deletedAt: null` cho mọi upsert (xem lib/prisma.ts) nên danh mục mẫu vừa bị xoá sẽ
 * sống lại ngay ở lần tải danh sách sau đó: người dùng thấy "đã xoá thành công" nhưng
 * dòng vẫn còn trên bảng.
 */
async function ensureSeedData() {
  if (!seedPromise) {
    seedPromise = (async () => {
      // prismaRaw: đếm cả bản ghi đã xoá mềm, để danh mục đã xoá không bị nạp lại.
      if ((await prismaRaw.masterDataItem.count()) > 0) return;
      for (const item of defaultMasterData) {
        await prismaRaw.masterDataItem.upsert({
          where: {
            type_code: {
              type: item.type,
              code: item.code,
            },
          },
          update: {},
          create: item,
        });
      }
    })().catch((error) => {
      seedPromise = null;
      throw error;
    });
  }
  return seedPromise;
}

async function ensureSeedDataForType(type?: string) {
  if (!type || !["ASSET_GROUP", "INVENTORY_ITEM_GROUP"].includes(type)) return;
  if ((await prismaRaw.masterDataItem.count({ where: { type } })) > 0) return;
  for (const item of defaultMasterData.filter((entry) => entry.type === type)) {
    await prismaRaw.masterDataItem.upsert({
      where: {
        type_code: {
          type: item.type,
          code: item.code,
        },
      },
      update: {},
      create: item,
    });
  }
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isUniqueConstraintError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

export async function GET(request: Request) {
  try {
    const auth = getRequestSession(request);
    if (!auth.ok) return auth.response;

    await ensureSeedData();

    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type") || undefined;
    const status = searchParams.get("status") || undefined;
    const search = searchParams.get("search")?.trim();
    const requestedMoneySourceBranch = cleanText(searchParams.get("branchCode")).toUpperCase();
    await ensureSeedDataForType(type);
    const allowedBranches = getAllowedBranches(auth.session);
    const sessionBranches = (auth.session.allowedBranches || []).map((branch) => branch.trim().toUpperCase()).filter(Boolean);
    const canAccessAllBranches = sessionBranches.includes("ALL");

    if (
      type === "MONEY_SOURCE"
      && requestedMoneySourceBranch
      && requestedMoneySourceBranch !== "ALL"
      && !canAccessAllBranches
      && !sessionBranches.includes(requestedMoneySourceBranch)
    ) {
      return NextResponse.json({ error: "Không có quyền xem nguồn tiền của cửa hàng đã chọn" }, { status: 403 });
    }

    const branchScopeFilters: Array<Record<string, unknown>> = [];
    if (type === "MONEY_SOURCE") {
      if (requestedMoneySourceBranch && requestedMoneySourceBranch !== "ALL") {
        branchScopeFilters.push({
          OR: [{ branch: requestedMoneySourceBranch }, { branch: "ALL" }, { branch: null }],
        });
      } else if (!canAccessAllBranches) {
        branchScopeFilters.push({
          OR: [{ branch: { in: sessionBranches } }, { branch: "ALL" }, { branch: null }],
        });
      }
    } else if (type === "BRANCH" && !canAccessAllBranches) {
      branchScopeFilters.push({ code: { in: sessionBranches } });
    } else if (type && ["WAREHOUSE", "DEPARTMENT"].includes(type) && allowedBranches.length === 1) {
      branchScopeFilters.push({
        OR: [{ branch: allowedBranches[0] }, { branch: "ALL" }, { branch: null }],
      });
    }

    const items = await prisma.masterDataItem.findMany({
      where: {
        ...(type ? { type } : {}),
        ...(status ? { status } : {}),
        ...(branchScopeFilters.length ? { AND: branchScopeFilters } : {}),
        ...(search
          ? {
              OR: [
                { code: { contains: search } },
                { name: { contains: search } },
                { group: { contains: search } },
                { branch: { contains: search } },
                { taxCode: { contains: search } },
                { partnerType: { contains: search } },
                { partnerGroup: { contains: search } },
              ],
            }
          : {}),
      },
      orderBy: [{ type: "asc" }, { createdAt: "desc" }],
    });

    return NextResponse.json(items);
  } catch {
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

/** Các loại danh mục có tầng cha, lưu mã cha ở cột subGroup. */
function typeSupportsSubGroup(type: string) {
  return type === "PNL_ITEM";
}

async function validateMasterData(type: string, group: string | null, branch: string | null, partnerGroup?: string | null) {
  if (type === "PARTNER") {
    if (!group || !["CUSTOMER", "SUPPLIER", "BOTH", "EMPLOYEE", "OTHER_PARTNER"].includes(group.toUpperCase())) {
      throw new Error("Loại đối tác bắt buộc là CUSTOMER, SUPPLIER, BOTH, EMPLOYEE hoặc OTHER_PARTNER.");
    }
    if (partnerGroup && !["EXTERNAL", "INTERNAL"].includes(partnerGroup.toUpperCase())) {
      throw new Error("Nhóm đối tượng bắt buộc là EXTERNAL hoặc INTERNAL.");
    }
  }
  if (type === "WAREHOUSE") {
    if (!branch) {
      throw new Error("Cửa hàng của kho là bắt buộc.");
    }
    const branchExists = await prisma.masterDataItem.findFirst({
      where: { type: "BRANCH", code: branch.toUpperCase() }
    });
    if (!branchExists) {
      throw new Error(`Cửa hàng liên kết "${branch}" không hợp lệ hoặc không tồn tại trên hệ thống.`);
    }
  }
  if (type === "MONEY_SOURCE") {
    if (!group || !["CASH", "BANK", "WALLET"].includes(group.toUpperCase())) {
      throw new Error("Nhóm nguồn tiền bắt buộc là CASH, BANK hoặc WALLET.");
    }
    if (!branch) {
      throw new Error("Cửa hàng của nguồn tiền là bắt buộc.");
    }
    if (branch.toUpperCase() !== "ALL") {
      const branchExists = await prisma.masterDataItem.findFirst({
        where: { type: "BRANCH", code: branch.toUpperCase() }
      });
      if (!branchExists) {
        throw new Error(`Cửa hàng liên kết "${branch}" không hợp lệ hoặc không tồn tại trên hệ thống.`);
      }
    }
  }
  if (type === "REVENUE_EXPENSE_CATEGORY") {
    if (!["RECEIPT", "PAYMENT"].includes(normalizeCashflowCategoryType(group) || "")) {
      throw new Error("Loại Thu/Chi bắt buộc là Thu hoặc Chi.");
    }
  }
  /** Phân cấp P&L độc lập với danh mục Thu/Chi. */
  // REVENUE_EXPENSE_SUBGROUP là tên cũ của PNL_GROUP, giữ lại để dữ liệu cũ vẫn sửa được.
  if (["PNL_GROUP", "PNL_ITEM", "REVENUE_EXPENSE_SUBGROUP"].includes(type)) {
    if (!group || !["OPEX", "CAPEX", "COGS", "REVENUE_SOURCE"].includes(group.toUpperCase())) {
      throw new Error("Nhóm lớn của hạng mục P&L bắt buộc là OPEX, CAPEX, COGS hoặc REVENUE_SOURCE.");
    }
  }
  if (type === "ASSET_GROUP") {
    if (!group || !["FIXED_ASSET", "CCDC", "TOOL", "OTHER"].includes(group.toUpperCase())) {
      throw new Error("Nhóm tài sản bắt buộc là FIXED_ASSET, CCDC, TOOL hoặc OTHER.");
    }
  }
  if (type === "INVENTORY_ITEM_GROUP") {
    if (!group || !["RAW_MATERIAL", "SEMI_FINISHED", "FINISHED", "PACKAGING", "TOOL", "ASSET", "OTHER"].includes(group.toUpperCase())) {
      throw new Error("Nhóm mặt hàng bắt buộc là RAW_MATERIAL, SEMI_FINISHED, FINISHED, PACKAGING, TOOL, ASSET hoặc OTHER.");
    }
  }
  if (type === "ACCOUNTING_PERIOD" && group && !["OPEN", "LOCKED", "CLOSED"].includes(group.toUpperCase())) {
    throw new Error("Trạng thái kỳ kế toán bắt buộc là OPEN, LOCKED hoặc CLOSED.");
  }
  if (type === "DOCUMENT_TYPE" && group && !["RECEIPT", "PAYMENT", "DEPOSIT", "TRANSFER"].includes(group.toUpperCase())) {
    throw new Error("Nhóm loại chứng từ bắt buộc là RECEIPT, PAYMENT, DEPOSIT hoặc TRANSFER.");
  }
}

const legacyGroupAliases: Record<string, Record<string, string>> = {
  REVENUE_EXPENSE_CATEGORY: {
    THU: "RECEIPT",
    INCOME: "RECEIPT",
    REVENUE_SOURCE: "RECEIPT",
    "NGUON DOANH THU": "RECEIPT",
    "NGUỒN DOANH THU": "RECEIPT",
    "DOANH THU": "RECEIPT",
    CHI: "PAYMENT",
    EXPENSE: "PAYMENT",
    OPEX: "PAYMENT",
    CAPEX: "PAYMENT",
    COGS: "PAYMENT",
    "GIA VON": "PAYMENT",
    "GIÁ VỐN": "PAYMENT",
  },
  DOCUMENT_TYPE: {
    THU: "RECEIPT",
    CHI: "PAYMENT",
    "TIEN COC": "DEPOSIT",
    "TIỀN CỌC": "DEPOSIT",
    "DIEU TIEN": "TRANSFER",
    "ĐIỀU TIỀN": "TRANSFER",
  },
};

function normalizeMasterGroup(type: string, group: string | null) {
  if (!group) return null;
  if (["PARTNER", "MONEY_SOURCE", "REVENUE_EXPENSE_CATEGORY", "ASSET_GROUP", "INVENTORY_ITEM_GROUP", "ACCOUNTING_PERIOD", "DOCUMENT_TYPE"].includes(type)) {
    const normalized = group.toUpperCase();
    return legacyGroupAliases[type]?.[normalized] || normalized;
  }
  return group;
}

export async function POST(request: Request) {
  try {
    const auth = requireMenuAction(request, "/settings", "config");
    if (!auth.ok) return auth.response;

    const body = await request.json();
    const type = cleanText(body.type);
    const code = cleanText(body.code).toUpperCase();
    const name = cleanText(body.name);
    const group = normalizeMasterGroup(type, cleanText(body.group) || null);
    const subGroup = typeSupportsSubGroup(type) ? (cleanText(body.subGroup).toUpperCase() || null) : null;
    const branch = cleanText(body.branch) || null;
    const partnerType = type === "PARTNER" ? (cleanText(body.partnerType) || group || "").toUpperCase() : null;
    const partnerGroup = type === "PARTNER" ? (cleanText(body.partnerGroup) || "EXTERNAL").toUpperCase() : null;

    if (!type || !code || !name) {
      return NextResponse.json({ error: "Loại danh mục, mã và tên là bắt buộc" }, { status: 400 });
    }

    try {
      await validateMasterData(type, partnerType || group, branch, partnerGroup);
      if (branch && ["WAREHOUSE", "MONEY_SOURCE", "DEPARTMENT"].includes(type)) {
        assertBranchAccess(auth.session, branch);
      }
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Dữ liệu không hợp lệ" }, { status: 400 });
    }

    // Mã unique là (type, code): nếu bản ghi cũ đang nằm trong thùng rác thì nói rõ,
    // tránh báo "mã đã tồn tại" trong khi người dùng không thấy dòng nào trên bảng.
    if (await findDeletedByUnique("MasterDataItem", { type, code })) {
      return NextResponse.json({ error: duplicatedInTrashMessage(code, "Danh mục") }, { status: 409 });
    }

    const item = await prisma.masterDataItem.create({
      data: {
        type,
        code,
        name,
        group: type === "PARTNER" ? partnerType : group,
        subGroup,
        partnerType,
        partnerGroup,
        branch,
        taxCode: cleanText(body.taxCode) || null,
        contactName: cleanText(body.contactName) || null,
        phone: cleanText(body.phone) || null,
        email: cleanText(body.email) || null,
        accountNo: cleanText(body.accountNo) || null,
        note: cleanText(body.note) || null,
        status: cleanText(body.status) || "ACTIVE",
      },
    });

    return NextResponse.json(item, { status: 201 });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return NextResponse.json({ error: "Mã danh mục đã tồn tại trong nhóm này" }, { status: 409 });
    }
    console.error("Error creating master data:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const auth = requireMenuAction(request, "/settings", "config");
    if (!auth.ok) return auth.response;

    const body = await request.json();
    const id = cleanText(body.id);
    if (!id) {
      return NextResponse.json({ error: "Thiếu ID danh mục" }, { status: 400 });
    }

    const current = await prisma.masterDataItem.findUnique({ where: { id } });
    if (!current) {
      return NextResponse.json({ error: "Không tìm thấy danh mục" }, { status: 404 });
    }

    // Chỉ chuyển nhóm cũ sang Thu/Chi khi người dùng thực sự gửi lại trường group.
    // Các thao tác chỉ đổi trạng thái phải giữ nguyên phân loại lịch sử.
    const group = body.group !== undefined
      ? normalizeMasterGroup(current.type, cleanText(body.group) || null)
      : current.group;
    const subGroup = typeSupportsSubGroup(current.type)
      ? (body.subGroup !== undefined ? (cleanText(body.subGroup).toUpperCase() || null) : current.subGroup)
      : null;
    const branch = body.branch !== undefined ? cleanText(body.branch) || null : current.branch;
    const partnerType = current.type === "PARTNER"
      ? normalizeMasterGroup("PARTNER", body.partnerType !== undefined ? cleanText(body.partnerType) || null : current.partnerType || group)
      : null;
    const partnerGroup = current.type === "PARTNER"
      ? (body.partnerGroup !== undefined ? cleanText(body.partnerGroup) || null : current.partnerGroup || "EXTERNAL")
      : null;

    try {
      await validateMasterData(current.type, partnerType || group, branch, partnerGroup);
      if (branch && ["WAREHOUSE", "MONEY_SOURCE", "DEPARTMENT"].includes(current.type)) {
        assertBranchAccess(auth.session, branch);
      }
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Dữ liệu không hợp lệ" }, { status: 400 });
    }

    // Bản ghi con liên kết bằng MÃ, nên đổi mã cha cũng bỏ rơi con y như xoá cha.
    const nextCode = body.code !== undefined ? cleanText(body.code).toUpperCase() : current.code;
    if (nextCode !== current.code) {
      const blocked = await describeDependents(current, "đổi mã");
      if (blocked) {
        return NextResponse.json({ error: blocked }, { status: 409 });
      }
    }

    const item = await prisma.masterDataItem.update({
      where: { id },
      data: {
        ...(body.code !== undefined ? { code: cleanText(body.code).toUpperCase() } : {}),
        ...(body.name !== undefined ? { name: cleanText(body.name) } : {}),
        group: current.type === "PARTNER" ? partnerType : group,
        subGroup,
        partnerType,
        partnerGroup,
        branch,
        ...(body.taxCode !== undefined ? { taxCode: cleanText(body.taxCode) || null } : {}),
        ...(body.contactName !== undefined ? { contactName: cleanText(body.contactName) || null } : {}),
        ...(body.phone !== undefined ? { phone: cleanText(body.phone) || null } : {}),
        ...(body.email !== undefined ? { email: cleanText(body.email) || null } : {}),
        ...(body.accountNo !== undefined ? { accountNo: cleanText(body.accountNo) || null } : {}),
        ...(body.note !== undefined ? { note: cleanText(body.note) || null } : {}),
        ...(body.status !== undefined ? { status: cleanText(body.status) || "ACTIVE" } : {}),
      },
    });

    return NextResponse.json(item);
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return NextResponse.json({ error: "Mã danh mục đã tồn tại trong nhóm này" }, { status: 409 });
    }
    console.error("Error updating master data:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

const TYPE_LABELS: Record<string, string> = {
  BRANCH: "Cửa hàng",
  DEPARTMENT: "Phòng ban",
  WAREHOUSE: "Kho hàng",
  PARTNER: "Đối tác",
  MONEY_SOURCE: "Nguồn tiền",
  REVENUE_EXPENSE_CATEGORY: "Thu / Chi",
  ACCOUNTING_PERIOD: "Kỳ kế toán",
  DOCUMENT_TYPE: "Loại chứng từ",
  DOCUMENT_NUMBER_RULE: "Quy tắc mã",
  SYSTEM_PARAM: "Tham số hệ thống",
};

function typeLabel(type: string) {
  return TYPE_LABELS[type] || type;
}

/**
 * Điều kiện tìm các danh mục khác đang trỏ vào bản ghi này.
 *
 * `validateMasterData` chỉ chặn lúc tạo/sửa, nên nếu xoá bản ghi cha thì các bản ghi con
 * (Kho/Nguồn tiền/Phòng ban trỏ vào Cửa hàng, Quy tắc mã trỏ vào Loại chứng từ) trở thành
 * mồ côi: vẫn hiển thị nhưng liên kết đến một mã không còn tồn tại.
 */
function dependentFilter(item: { type: string; code: string }): Record<string, unknown> | null {
  if (item.type === "BRANCH") {
    return { type: { in: ["WAREHOUSE", "MONEY_SOURCE", "DEPARTMENT"] }, branch: item.code };
  }
  if (item.type === "DOCUMENT_TYPE") {
    return { type: "DOCUMENT_NUMBER_RULE", group: item.code };
  }
  return null;
}

/** Mô tả các danh mục con đang chặn thao tác, hoặc null nếu không có gì chặn. */
async function describeDependents(item: { type: string; code: string }, action: "xoá" | "đổi mã") {
  const filter = dependentFilter(item);
  if (!filter) return null;

  // prisma (không phải prismaRaw): bản ghi con đã nằm trong thùng rác thì không còn chặn.
  const [dependents, total] = await Promise.all([
    prisma.masterDataItem.findMany({
      where: filter,
      select: { type: true, code: true, name: true },
      orderBy: [{ type: "asc" }, { code: "asc" }],
      take: 5,
    }),
    prisma.masterDataItem.count({ where: filter }),
  ]);
  if (total === 0) return null;

  const listed = dependents.map((row) => `${typeLabel(row.type)} ${row.code} - ${row.name}`).join("; ");
  const more = total > dependents.length ? ` và ${total - dependents.length} mục khác` : "";
  return `Không thể ${action} ${typeLabel(item.type)} "${item.code}" vì còn ${total} danh mục đang liên kết: ${listed}${more}. Hãy xoá hoặc chuyển các mục đó sang mã khác trước.`;
}

export async function DELETE(request: Request) {
  try {
    const auth = requireMenuAction(request, "/settings", "config");
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "Thiếu ID danh mục" }, { status: 400 });
    }

    const current = await prisma.masterDataItem.findUnique({ where: { id } });
    if (!current) {
      return NextResponse.json({ error: "Không tìm thấy danh mục" }, { status: 404 });
    }

    const blocked = await describeDependents(current, "xoá");
    if (blocked) {
      return NextResponse.json({ error: blocked }, { status: 409 });
    }

    await softDeleteRecord({ model: "MasterDataItem", id, session: auth.session });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Error deleting master data:", error);
    return NextResponse.json(
      { error: "Không thể xóa danh mục này do có thể đã có dữ liệu chứng từ liên kết" },
      { status: 400 }
    );
  }
}
