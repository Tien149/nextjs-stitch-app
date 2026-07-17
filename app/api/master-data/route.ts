import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getRequestSession, requireMenuAction } from "@/lib/api-auth";
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
    name: "Chi nhanh TP. HCM",
    group: "Branch",
    status: "ACTIVE",
  },
  {
    type: "BRANCH",
    code: "HN",
    name: "Chi nhanh Ha Noi",
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
    name: "Kho nguyen vat lieu HCM",
    group: "Nguyen vat lieu/Bao bi",
    branch: "HCM",
    status: "ACTIVE",
  },
  {
    type: "WAREHOUSE",
    code: "KHO_HN",
    name: "Kho nguyen vat lieu Ha Noi",
    group: "Nguyen vat lieu/Bao bi",
    branch: "HN",
    status: "ACTIVE",
  },
  {
    type: "MONEY_SOURCE",
    code: "TM_HCM",
    name: "Quy tien mat HCM",
    group: "Tien mat",
    branch: "HCM",
    status: "ACTIVE",
  },
  {
    type: "MONEY_SOURCE",
    code: "VCB_HCM",
    name: "Vietcombank HCM",
    group: "Ngan hang",
    branch: "HCM",
    accountNo: "0071000012345",
    status: "ACTIVE",
  },
  {
    type: "MONEY_SOURCE",
    code: "POS_HN",
    name: "POS/Vi dien tu Ha Noi",
    group: "Vi/POS",
    branch: "HN",
    status: "ACTIVE",
  },
  {
    type: "PARTNER",
    code: "KH_ABC",
    name: "Cong ty TNHH ABC",
    group: "Khach hang",
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
    group: "Nha cung cap",
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
    name: "Kho hang trung tam HCM",
    group: "Kho chinh",
    branch: "HCM",
    status: "ACTIVE",
    note: "Kho luu tru thuc pham va nguyen vat lieu",
  },
  {
    type: "WAREHOUSE",
    code: "KHO_HN",
    name: "Kho hang chi nhanh Ha Noi",
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

export async function GET(request: Request) {
  try {
    const auth = getRequestSession(request);
    if (!auth.ok) return auth.response;

    await ensureSeedData();

    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type") || undefined;
    const status = searchParams.get("status") || undefined;
    const search = searchParams.get("search")?.trim();

    const items = await prisma.masterDataItem.findMany({
      where: {
        ...(type ? { type } : {}),
        ...(status ? { status } : {}),
        ...(search
          ? {
              OR: [
                { code: { contains: search } },
                { name: { contains: search } },
                { group: { contains: search } },
                { branch: { contains: search } },
                { taxCode: { contains: search } },
              ],
            }
          : {}),
      },
      orderBy: [{ type: "asc" }, { createdAt: "desc" }],
    });

    return NextResponse.json(items);
  } catch (error) {
    console.error("Error fetching master data:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
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

    if (!type || !code || !name) {
      return NextResponse.json({ error: "Loai danh muc, ma va ten la bat buoc" }, { status: 400 });
    }

    const item = await prisma.masterDataItem.create({
      data: {
        type,
        code,
        name,
        group: cleanText(body.group) || null,
        branch: cleanText(body.branch) || null,
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
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ error: "Ma danh muc da ton tai trong nhom nay" }, { status: 409 });
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
      return NextResponse.json({ error: "Thieu ID danh muc" }, { status: 400 });
    }

    const item = await prisma.masterDataItem.update({
      where: { id },
      data: {
        ...(body.code !== undefined ? { code: cleanText(body.code).toUpperCase() } : {}),
        ...(body.name !== undefined ? { name: cleanText(body.name) } : {}),
        ...(body.group !== undefined ? { group: cleanText(body.group) || null } : {}),
        ...(body.branch !== undefined ? { branch: cleanText(body.branch) || null } : {}),
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
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ error: "Ma danh muc da ton tai trong nhom nay" }, { status: 409 });
    }
    console.error("Error updating master data:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
