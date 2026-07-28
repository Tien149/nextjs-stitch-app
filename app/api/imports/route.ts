import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { assertBranchAccess, requestedBranch } from "@/lib/accounting";
import { commitImport, isUniqueConstraintError, rollbackImportBatch } from "@/lib/import-commit";
import { getImportTemplate, type ImportType } from "@/lib/import-templates";
import { parseImportFile } from "@/lib/import-parser";
import { validateImportResult } from "@/lib/import-validation";
import { prisma } from "@/lib/prisma";

const menuHref = "/imports";
const maxFileSize = 10 * 1024 * 1024;

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function getUploadFile(formData: FormData) {
  const file = formData.get("file");
  return file instanceof File ? file : null;
}

function parseMapping(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    throw new Error("Mapping cột không đúng định dạng");
  }
}

function validateFile(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (!extension || !["xlsx", "xls", "csv"].includes(extension)) {
    throw new Error("Chỉ hỗ trợ file .xlsx, .xls hoặc .csv");
  }
  if (file.size <= 0) throw new Error("File import đang rỗng");
  if (file.size > maxFileSize) throw new Error("File import vượt quá giới hạn 10 MB");
}

function templateExample(templateCode: string) {
  const examples: Record<string, Record<string, string | number | Date>> = {
    CUSTOMER_RECEIPT_V1: {
      voucher_date: new Date("2026-07-01T00:00:00Z"),
      source_scope: "Bên ngoài",
      category_code: "REV_FOOD",
      description: "Thu tiền khách hàng",
      amount: 12500000,
      money_source_code: "VCB_HCM",
      external_ref: "GD-THU-0001",
      counterparty_account_no: "0123456789",
      counterparty_account_name: "CONG TY ABC",
      partner_code: "KH_ABC",
      partner_name: "Công ty ABC",
      deposit_action: "Thu tiền cọc",
    },
    CUSTOMER_PAYMENT_V1: {
      voucher_date: new Date("2026-07-02T00:00:00Z"),
      source_scope: "Bên ngoài",
      category_code: "OPEX_RENT",
      description: "Thanh toán chi phí vận hành",
      amount: 8500000,
      money_source_code: "VCB_HCM",
      external_ref: "GD-CHI-0001",
      partner_code: "NCC_FOOD",
      partner_name: "Nhà cung cấp thực phẩm",
      allocation_months: 3,
      allocation_start_period: "2026-07",
    },
    INTERNAL_TRANSFER_STANDARD_V1: {
      transfer_date: new Date("2026-07-03T00:00:00Z"),
      from_money_source_code: "VCB_HCM",
      to_money_source_code: "TM_HCM",
      amount: 20000000,
      external_ref: "CTNB-0001",
      description: "Rút ngân hàng nhập quỹ tiền mặt",
    },
    DEBT_OPENING_STANDARD_V1: {
      debt_type: "PAYABLE",
      partner_group: "EXTERNAL",
      document_date: new Date("2026-06-30T00:00:00Z"),
      document_code: "CN-NCC-0001",
      category_code: "OPEX_RENT",
      partner_code: "NCC_FOOD",
      partner_name: "Nhà cung cấp thực phẩm",
      description: "Công nợ đầu kỳ",
      amount: 18500000,
      due_date: new Date("2026-07-15T00:00:00Z"),
    },
    DEBT_RECEIVABLE_EXTERNAL_V1: {
      document_date: new Date("2026-06-30T00:00:00Z"),
      document_code: "CN-KH-0001",
      category_code: "REV_FOOD",
      partner_code: "KH_ABC",
      partner_name: "Công ty ABC",
      description: "Phải thu khách hàng đầu kỳ",
      amount: 12500000,
      due_date: new Date("2026-07-15T00:00:00Z"),
    },
    DEBT_PAYABLE_EXTERNAL_V1: {
      document_date: new Date("2026-06-30T00:00:00Z"),
      document_code: "CN-NCC-0001",
      category_code: "OPEX_RENT",
      partner_code: "NCC_FOOD",
      partner_name: "Nhà cung cấp thực phẩm",
      description: "Phải trả nhà cung cấp đầu kỳ",
      amount: 18500000,
      due_date: new Date("2026-07-15T00:00:00Z"),
      allocation_months: 3,
      allocation_start_period: "2026-07",
    },
    DEBT_INTERNAL_V1: {
      debt_type: "RECEIVABLE",
      document_date: new Date("2026-06-30T00:00:00Z"),
      document_code: "CN-NB-0001",
      category_code: "REV_FOOD",
      partner_code: "KH_ABC",
      partner_name: "Công ty ABC",
      description: "Công nợ nội bộ đầu kỳ",
      amount: 5000000,
      due_date: new Date("2026-07-15T00:00:00Z"),
    },
  };
  return examples[templateCode] || {};
}

function templateExampleRows(templateCode: string): Array<Record<string, string | number | Date>> {
  if (templateCode === "INVENTORY_ITEM_STANDARD_V1") {
    return [
      { code: "NVL_NUOCSUOI", name: "Nuoc suoi chai", item_type: "RAW_MATERIAL", unit: "chai", purchase_unit: "thung", conversion_rate: 24, min_stock: 120 },
      { code: "NVL_DUONG", name: "Duong cat", item_type: "RAW_MATERIAL", unit: "g", purchase_unit: "kg", conversion_rate: 1000, min_stock: 5000 },
      { code: "BTP_SOTCACHUA", name: "Sot ca chua", item_type: "SEMI_FINISHED", unit: "ml", purchase_unit: "lit", conversion_rate: 1000, min_stock: 3000 },
      { code: "SP_COMBO01", name: "Combo ban POS", item_type: "FINISHED", unit: "phan", min_stock: 0 },
    ];
  }
  if (templateCode === "OPENING_BALANCE_STANDARD_V1") {
    return [
      { period: "2026-07", branch_code: "HCM", balance_type: "BANK", money_source_code: "VCB_HCM", amount: 2500000000, note: "So du ngan hang dau ky" },
      { period: "2026-07", branch_code: "HCM", balance_type: "CASH", money_source_code: "TM_HCM", amount: 120000000, note: "Quy tien mat dau ky" },
      { period: "2026-07", branch_code: "HCM", balance_type: "DEPOSIT", object_code: "KH_ABC", object_name: "Cong ty ABC", money_source_code: "VCB_HCM", amount: 7000000, note: "Tien coc dau ky" },
      { period: "2026-07", branch_code: "HCM", balance_type: "INVENTORY", object_code: "NVL_NUOCSUOI", object_name: "Nuoc suoi chai", warehouse_code: "KHO_HCM", quantity: 50, unit_cost: 32000, amount: 1600000, note: "Ton kho dau ky" },
      { period: "2026-07", branch_code: "HCM", balance_type: "ASSET", object_code: "TS001", object_name: "Thiet bi dau ky", department_code: "STORE", quantity: 1, unit_cost: 18000000, amount: 18000000, note: "Tai san/CCDC dau ky" },
      { period: "2026-07", branch_code: "HCM", balance_type: "PREPAID_EXPENSE", object_code: "PB001", object_name: "Chi phi phan bo dau ky", money_source_code: "OPEX_RENT", allocation_months: 12, allocation_start_period: "2026-07", amount: 120000000, note: "Chi phi phan bo dau ky" },
    ];
  }
  if (templateCode === "INVENTORY_TRANSACTION_STANDARD_V1") {
    return [
      { transaction_date: new Date("2026-07-22T00:00:00Z"), transaction_type: "NHAP_MUA", branch_code: "HCM", warehouse_code: "KHO_HCM", item_code: "NVL_NUOCSUOI", quantity: 20, unit_code: "thung", unit_cost: 120000, reference_code: "PNK-0001", partner_code: "NCC_FOOD", note: "Nhap mua nuoc suoi" },
      { transaction_date: new Date("2026-07-22T00:00:00Z"), transaction_type: "XUAT_HUY", branch_code: "HCM", warehouse_code: "KHO_HCM", item_code: "NVL_NUOCSUOI", quantity: 12, unit_code: "chai", reference_code: "HH-0001", note: "Huy hang vo chai" },
      { transaction_date: new Date("2026-07-22T00:00:00Z"), transaction_type: "DIEU_CHUYEN", branch_code: "HCM", warehouse_code: "KHO_HCM", to_warehouse_code: "KHO_HN", item_code: "NVL_NUOCSUOI", quantity: 2, unit_code: "thung", reference_code: "DCK-0001", note: "Dieu chuyen noi bo" },
    ];
  }
  if (templateCode === "BOM_STANDARD_V1") {
    return [
      { product_code: "SP_COMBO01", product_name: "Combo ban POS", ingredient_code: "NVL_NUOCSUOI", quantity: 1, waste_rate: 0, effective_date: new Date("2026-07-22T00:00:00Z"), version: 1, note: "1 chai/phan" },
      { product_code: "SP_COMBO01", product_name: "Combo ban POS", ingredient_code: "NVL_DUONG", quantity: 20, waste_rate: 5, effective_date: new Date("2026-07-22T00:00:00Z"), version: 1, note: "20g duong/phan" },
      { product_code: "BTP_SOTCACHUA", product_name: "Sot ca chua", ingredient_code: "NVL_DUONG", quantity: 30, waste_rate: 3, effective_date: new Date("2026-07-22T00:00:00Z"), version: 1, note: "30g duong/lit sot" },
    ];
  }
  if (templateCode === "STOCKTAKE_STANDARD_V1") {
    return [
      { stocktake_date: new Date("2026-07-22T00:00:00Z"), branch_code: "HCM", warehouse_code: "KHO_HCM", item_code: "NVL_NUOCSUOI", actual_quantity: 505, reason: "Kiem ke thuc te" },
      { stocktake_date: new Date("2026-07-22T00:00:00Z"), branch_code: "HCM", warehouse_code: "KHO_HCM", item_code: "NVL_DUONG", actual_quantity: 9800, reason: "Kiem ke thuc te" },
    ];
  }
  const example = templateExample(templateCode);
  return Object.keys(example).length > 0 ? [example] : [];
}

function templateResponse(importType: ImportType, templateCode?: string) {
  const template = getImportTemplate(importType, templateCode);
  if (!template) return NextResponse.json({ error: "Không tìm thấy template import" }, { status: 404 });
  const fields = template.fields.filter((field) => !field.hiddenFromMapping);
  const headers = fields.map((field) => field.label);
  const examples = templateExampleRows(template.code);
  const exampleRows = examples.length ? examples.map((example) => fields.map((field) => example[field.field] ?? "")) : [fields.map(() => "")];
  const worksheet = XLSX.utils.aoa_to_sheet([headers, ...exampleRows], { cellDates: true });
  worksheet["!cols"] = headers.map((header) => ({ wch: Math.min(Math.max(header.length + 4, 14), 34) }));
  worksheet["!autofilter"] = { ref: `A1:${XLSX.utils.encode_col(Math.max(headers.length - 1, 0))}${exampleRows.length + 1}` };
  const workbook = XLSX.utils.book_new();
  const sheetName = (template.preferredSheetNames?.[0] || "Du lieu mau").slice(0, 31);
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  const guide = XLSX.utils.aoa_to_sheet([
    ["Field", "Bắt buộc", "Kiểu dữ liệu", "Ghi chú"],
    ...template.fields.map((field) => [field.label, field.required ? "Có" : "Không", field.type, field.hiddenFromMapping ? "Hệ thống tự điền" : ""]),
  ]);
  guide["!cols"] = [{ wch: 28 }, { wch: 12 }, { wch: 16 }, { wch: 26 }];
  XLSX.utils.book_append_sheet(workbook, guide, "Huong dan");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx", compression: true });
  const safeName = template.code.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename=${safeName}.xlsx`,
    },
  });
}

function errorWorkbookResponse(batch: { id: string; fileName: string; importRows: Array<{ sourceRowNumber: number; sheetName: string; rawJson: string; normalizedJson: string; errorJson: string | null }> }) {
  const rows = batch.importRows
    .filter((row) => row.errorJson)
    .map((row) => {
      const raw = JSON.parse(row.rawJson || "{}") as Record<string, unknown>;
      const normalized = JSON.parse(row.normalizedJson || "{}") as Record<string, unknown>;
      const errors = JSON.parse(row.errorJson || "[]") as string[];
      return {
        sheet: row.sheetName,
        row_number: row.sourceRowNumber,
        errors: errors.join("; "),
        ...Object.fromEntries(Object.entries(normalized).map(([key, value]) => [`mapped_${key}`, value instanceof Date ? value.toISOString() : value])),
        ...Object.fromEntries(Object.entries(raw).map(([key, value]) => [`raw_${key}`, value instanceof Date ? value.toISOString() : value])),
      };
    });
  const worksheet = XLSX.utils.json_to_sheet(rows.length ? rows : [{ message: "Batch này không có dòng lỗi." }]);
  worksheet["!cols"] = Object.keys(rows[0] || { message: "" }).map((key) => ({ wch: Math.min(Math.max(key.length + 8, 16), 44) }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Dong loi");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx", compression: true });
  const safeName = batch.fileName.replace(/\.[^.]+$/, "").replace(/[^a-z0-9_-]+/gi, "_").toLowerCase();
  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename=${safeName}_errors.xlsx`,
    },
  });
}

export async function GET(request: Request) {
  try {
    const auth = requireMenuAccess(request, menuHref);
    if (!auth.ok) return auth.response;
    const { searchParams } = new URL(request.url);
    const importType = (cleanText(searchParams.get("importType")) || "BANK_STATEMENT") as ImportType;
    const templateCode = cleanText(searchParams.get("templateCode")) || undefined;
    const template = getImportTemplate(importType, templateCode);
    if (!template) return NextResponse.json({ error: "Loại import hoặc template không hợp lệ" }, { status: 400 });
    if (searchParams.get("template") === "1") return templateResponse(importType, template.code);

    const batchId = searchParams.get("batchId") || undefined;
    const scopedBranch = requestedBranch(auth.session, "ALL");
    const branchWhere = scopedBranch === "ALL" ? {} : { branchCode: scopedBranch };
    if (batchId) {
      const batch = await prisma.importBatch.findFirst({
        where: { id: batchId, importType, ...(templateCode ? { templateCode } : {}), ...branchWhere },
        include: {
          bankTransactions: true,
          revenueRows: true,
          payrollRows: true,
          importRows: { orderBy: [{ sheetName: "asc" }, { sourceRowNumber: "asc" }] },
          vouchers: true,
          moneyTransfers: true,
          debtRecords: true,
        },
      });
      if (!batch) return NextResponse.json({ error: "Không tìm thấy batch import" }, { status: 404 });
      if (searchParams.get("download") === "errors") return errorWorkbookResponse(batch);
      return NextResponse.json(batch);
    }

    return NextResponse.json(await prisma.importBatch.findMany({
      where: { importType, ...(templateCode ? { templateCode } : {}), ...branchWhere },
      orderBy: { createdAt: "desc" },
      take: 20,
    }));
  } catch (error) {
    console.error("Error fetching import batches:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      const auth = requireMenuAction(request, menuHref, "edit");
      if (!auth.ok) return auth.response;
      const body = await request.json();
      const action = cleanText(body.action);
      if (action !== "ROLLBACK_BATCH") return NextResponse.json({ error: "Thao tác import không hợp lệ" }, { status: 400 });
      const batchId = cleanText(body.batchId);
      const note = cleanText(body.note);
      if (!batchId) return NextResponse.json({ error: "Thiếu batchId cần rollback" }, { status: 400 });

      const scopedBranch = requestedBranch(auth.session, "ALL");
      const batch = await prisma.importBatch.findFirst({
        where: { id: batchId, ...(scopedBranch === "ALL" ? {} : { branchCode: scopedBranch }) },
      });
      if (!batch) return NextResponse.json({ error: "Không tìm thấy batch import hoặc không thuộc phạm vi cửa hàng của bạn" }, { status: 404 });
      if (batch.branchCode) assertBranchAccess(auth.session, batch.branchCode);

      try {
        const rolledBack = await rollbackImportBatch({ batchId, actor: auth.session.name, note });
        return NextResponse.json(rolledBack);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Rollback batch import thất bại";
        await prisma.importBatch.update({
          where: { id: batchId },
          data: { status: "ROLLBACK_FAILED", errorJson: JSON.stringify({ rollbackError: message, failedAt: new Date().toISOString() }) },
        }).catch(() => undefined);
        return NextResponse.json({ error: message }, { status: 400 });
      }
    }

    const auth = requireMenuAction(request, menuHref, "create");
    if (!auth.ok) return auth.response;
    const importType = (cleanText(searchParams.get("importType")) || "BANK_STATEMENT") as ImportType;
    const mode = searchParams.get("mode") || "preview";
    const formData = await request.formData();
    const file = getUploadFile(formData);
    const templateCode = cleanText(formData.get("templateCode")) || cleanText(searchParams.get("templateCode"));
    const template = getImportTemplate(importType, templateCode);
    if (!file) return NextResponse.json({ error: "Thiếu file import" }, { status: 400 });
    if (!template || template.importType !== importType) return NextResponse.json({ error: "Không tìm thấy template import" }, { status: 400 });
    validateFile(file);

    const branchCode = cleanText(formData.get("branchCode")).toUpperCase();
    if (branchCode) assertBranchAccess(auth.session, branchCode);
    const mapping = parseMapping(formData.get("mappingJson"));
    const parsed = await parseImportFile(file, template, {
      mapping,
      defaultValues: branchCode ? { branch_code: branchCode } : {},
    });
    await validateImportResult(parsed, importType, auth.session);

    if (mode === "commit") {
      if (parsed.errorRows > 0) {
        return NextResponse.json({ error: "File còn dòng lỗi, vui lòng sửa trước khi commit", preview: parsed, template }, { status: 400 });
      }
      const buffer = await file.arrayBuffer();
      const fileChecksum = createHash("sha256").update(Buffer.from(buffer)).digest("hex");
      const batch = await commitImport({
        importType,
        templateCode: template.code,
        fileName: file.name,
        uploadedBy: auth.session.name,
        branchCode: branchCode || undefined,
        fileChecksum,
        mapping: parsed.mapping,
        rows: parsed.rows,
      });
      return NextResponse.json({ batch, preview: parsed, template }, { status: 201 });
    }

    return NextResponse.json({ template, preview: parsed });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return NextResponse.json({ error: "Dữ liệu bị trùng với bản ghi đã tồn tại" }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : "Internal Server Error";
    const status = /quyền|không có quyền/i.test(message) ? 403 : 400;
    console.error("Error during import process:", error);
    return NextResponse.json({ error: message }, { status });
  }
}
