import { NextResponse } from "next/server";
import { getRequestSession, requireMenuAction } from "@/lib/api-auth";
import { assertBranchAccess, getAllowedBranches } from "@/lib/accounting";
import { prisma } from "@/lib/prisma";

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
    group: "Tien mat",
    branch: "HCM",
    status: "ACTIVE",
  },
  {
    type: "MONEY_SOURCE",
    code: "VCB_HCM",
    name: "Vietcombank Cua hang 1",
    group: "Ngan hang",
    branch: "HCM",
    accountNo: "0071000012345",
    status: "ACTIVE",
  },
  {
    type: "MONEY_SOURCE",
    code: "POS_HN",
    name: "POS/Vi dien tu Cua hang 2",
    group: "Vi/POS",
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
    group: "Nguon doanh thu",
    note: "Dung phan loai doanh thu import tu POS",
    status: "ACTIVE",
  },
  {
    type: "REVENUE_EXPENSE_CATEGORY",
    code: "COGS_FOOD",
    name: "Gia von nguyen vat lieu va bao bi",
    group: "Gia von",
    note: "Dung cho COGS nguyen vat lieu",
    status: "ACTIVE",
  },
  {
    type: "REVENUE_EXPENSE_CATEGORY",
    code: "OPEX_RENT",
    name: "Chi phi thue mat bang",
    group: "OPEX",
    note: "Chi phi van hanh",
    status: "ACTIVE",
  },
  {
    type: "REVENUE_EXPENSE_CATEGORY",
    code: "CAPEX_EQUIPMENT",
    name: "Mua sam thiet bi quay",
    group: "CAPEX",
    note: "Chi phi dau tu tai san",
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

async function ensureSeedData() {
  for (const item of defaultMasterData) {
    await prisma.masterDataItem.upsert({
      where: {
        type_code: {
          type: item.type,
          code: item.code,
        },
      },
      update: item,
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
    const allowedBranches = getAllowedBranches(auth.session);

    const items = await prisma.masterDataItem.findMany({
      where: {
        ...(type ? { type } : {}),
        ...(status ? { status } : {}),
        ...(type && ["WAREHOUSE", "MONEY_SOURCE", "DEPARTMENT"].includes(type) && allowedBranches.length === 1
          ? { OR: [{ branch: allowedBranches[0] }, { branch: "ALL" }, { branch: null }] }
          : {}),
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

function validateMasterData(type: string, group: string | null, branch: string | null, partnerGroup?: string | null) {
  if (type === "PARTNER") {
    if (!group || !["CUSTOMER", "SUPPLIER", "BOTH", "EMPLOYEE", "OTHER_PARTNER"].includes(group.toUpperCase())) {
      throw new Error("Loại đối tác bắt buộc là CUSTOMER, SUPPLIER, BOTH, EMPLOYEE hoặc OTHER_PARTNER.");
    }
    if (partnerGroup && !["EXTERNAL", "INTERNAL"].includes(partnerGroup.toUpperCase())) {
      throw new Error("Nhóm đối tượng bắt buộc là EXTERNAL hoặc INTERNAL.");
    }
  }
  if (type === "WAREHOUSE") {
    if (!branch || !["HCM", "HN"].includes(branch.toUpperCase())) {
      throw new Error("Cửa hàng của kho bắt buộc là Cửa hàng 1 hoặc Cửa hàng 2.");
    }
  }
  if (type === "MONEY_SOURCE") {
    if (!group || !["CASH", "BANK", "WALLET"].includes(group.toUpperCase())) {
      throw new Error("Nhóm nguồn tiền bắt buộc là CASH, BANK hoặc WALLET.");
    }
    if (!branch || !["HCM", "HN", "ALL"].includes(branch.toUpperCase())) {
      throw new Error("Cửa hàng của nguồn tiền bắt buộc là Cửa hàng 1, Cửa hàng 2 hoặc Admin / Tất cả cửa hàng.");
    }
  }
  if (type === "REVENUE_EXPENSE_CATEGORY" && group && !["OPEX", "CAPEX", "COGS", "REVENUE_SOURCE"].includes(group.toUpperCase())) {
    throw new Error("Nhóm Thu/Chi bắt buộc là OPEX, CAPEX, COGS hoặc REVENUE_SOURCE.");
  }
  if (type === "ACCOUNTING_PERIOD" && group && !["OPEN", "LOCKED", "CLOSED"].includes(group.toUpperCase())) {
    throw new Error("Trạng thái kỳ kế toán bắt buộc là OPEN, LOCKED hoặc CLOSED.");
  }
  if (type === "DOCUMENT_TYPE" && group && !["RECEIPT", "PAYMENT", "DEPOSIT", "TRANSFER"].includes(group.toUpperCase())) {
    throw new Error("Nhóm loại chứng từ bắt buộc là RECEIPT, PAYMENT, DEPOSIT hoặc TRANSFER.");
  }
}

export async function POST(request: Request) {
  try {
    const auth = requireMenuAction(request, "/settings", "config");
    if (!auth.ok) return auth.response;

    const body = await request.json();
    const type = cleanText(body.type);
    const code = cleanText(body.code).toUpperCase();
    const name = cleanText(body.name);
    const group = cleanText(body.group) || null;
    const branch = cleanText(body.branch) || null;
    const partnerType = type === "PARTNER" ? (cleanText(body.partnerType) || group || "").toUpperCase() : null;
    const partnerGroup = type === "PARTNER" ? (cleanText(body.partnerGroup) || "EXTERNAL").toUpperCase() : null;

    if (!type || !code || !name) {
      return NextResponse.json({ error: "Loại danh mục, mã và tên là bắt buộc" }, { status: 400 });
    }

    try {
      validateMasterData(type, partnerType || group, branch, partnerGroup);
      if (branch && ["WAREHOUSE", "MONEY_SOURCE", "DEPARTMENT"].includes(type)) {
        assertBranchAccess(auth.session, branch);
      }
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Dữ liệu không hợp lệ" }, { status: 400 });
    }

    const item = await prisma.masterDataItem.create({
      data: {
        type,
        code,
        name,
        group: type === "PARTNER" ? partnerType : group,
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

    const group = body.group !== undefined ? cleanText(body.group) || null : current.group;
    const branch = body.branch !== undefined ? cleanText(body.branch) || null : current.branch;
    const partnerType = current.type === "PARTNER"
      ? (body.partnerType !== undefined ? cleanText(body.partnerType) || null : current.partnerType || group)
      : null;
    const partnerGroup = current.type === "PARTNER"
      ? (body.partnerGroup !== undefined ? cleanText(body.partnerGroup) || null : current.partnerGroup || "EXTERNAL")
      : null;

    try {
      validateMasterData(current.type, partnerType || group, branch, partnerGroup);
      if (branch && ["WAREHOUSE", "MONEY_SOURCE", "DEPARTMENT"].includes(current.type)) {
        assertBranchAccess(auth.session, branch);
      }
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Dữ liệu không hợp lệ" }, { status: 400 });
    }

    const item = await prisma.masterDataItem.update({
      where: { id },
      data: {
        ...(body.code !== undefined ? { code: cleanText(body.code).toUpperCase() } : {}),
        ...(body.name !== undefined ? { name: cleanText(body.name) } : {}),
        group: current.type === "PARTNER" ? partnerType : group,
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
