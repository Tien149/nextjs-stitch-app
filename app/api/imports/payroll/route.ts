import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { forbidden, requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { commitImport, isUniqueConstraintError } from "@/lib/import-commit";
import { getImportTemplate } from "@/lib/import-templates";
import { parseImportFile } from "@/lib/import-parser";
import { prisma } from "@/lib/prisma";

const importType = "PAYROLL" as const;
const menuHref = "/imports";

function payrollTemplateResponse() {
  const headers = ["Kỳ lương", "Mã nhân viên", "Tên nhân viên", "Chi nhánh", "Phòng ban", "Lương cơ bản", "Phụ cấp", "Thưởng", "Bảo hiểm", "Thuế TNCN", "Khấu trừ khác", "Thực nhận", "Mã tham chiếu"];
  const data = [
    headers,
    ["2026-07", "NV001", "Nguyễn Văn An", "HCM", "OPERATIONS", 9000000, 1000000, 500000, 945000, 150000, 0, 9405000, "PAY-202607-NV001"],
    ["2026-07", "NV002", "Trần Minh Anh", "HCM", "ACCOUNTING", 12000000, 1500000, 800000, 1323000, 350000, 0, 12627000, "PAY-202607-NV002"],
  ];
  const sheet = XLSX.utils.aoa_to_sheet(data);
  sheet["!cols"] = headers.map((header) => ({ wch: Math.max(14, header.length + 3) }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "BangLuong");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": "attachment; filename=mau_bang_luong.xlsx",
    },
  });
}

export async function GET(request: Request) {
  try {
    const auth = requireMenuAccess(request, menuHref);
    if (!auth.ok) return auth.response;
    if (auth.session.role === "Kế toán công nợ") return forbidden("Không có quyền truy cập Import Bảng lương");
    const { searchParams } = new URL(request.url);
    if (searchParams.get("template") === "1") return payrollTemplateResponse();
    const batchId = searchParams.get("batchId") || undefined;
    if (batchId) {
      const batch = await prisma.importBatch.findFirst({
        where: { id: batchId, importType },
        include: { payrollRows: { orderBy: [{ period: "desc" }, { employeeCode: "asc" }] } },
      });
      if (!batch) return NextResponse.json({ error: "Không tìm thấy batch import" }, { status: 404 });
      return NextResponse.json(batch);
    }
    return NextResponse.json(await prisma.importBatch.findMany({
      where: { importType },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { _count: { select: { payrollRows: true } } },
    }));
  } catch (error) {
    console.error("Error fetching payroll batches:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const auth = requireMenuAction(request, menuHref, "create");
    if (!auth.ok) return auth.response;
    if (auth.session.role === "Kế toán công nợ") return forbidden("Không có quyền Import Bảng lương");
    const mode = new URL(request.url).searchParams.get("mode") || "preview";
    const formData = await request.formData();
    const file = formData.get("file");
    const template = getImportTemplate(importType, String(formData.get("templateCode") || ""));
    if (!(file instanceof File)) return NextResponse.json({ error: "Thiếu file import" }, { status: 400 });
    if (!template) return NextResponse.json({ error: "Không tìm thấy template import" }, { status: 400 });
    const parsed = await parseImportFile(file, template);
    for (const row of parsed.rows) {
      const period = String(row.values.period || "");
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) row.errors.push("Kỳ lương phải có dạng YYYY-MM");
      const gross = Number(row.values.base_salary || 0) + Number(row.values.allowance_amount || 0) + Number(row.values.bonus_amount || 0);
      const deductions = Number(row.values.insurance_amount || 0) + Number(row.values.tax_amount || 0) + Number(row.values.deduction_amount || 0);
      const expectedNet = gross - deductions;
      if (Math.abs(expectedNet - Number(row.values.net_amount || 0)) > 1) row.errors.push("Thực nhận không khớp thu nhập trừ các khoản khấu trừ");
    }
    parsed.validRows = parsed.rows.filter((row) => row.errors.length === 0).length;
    parsed.errorRows = parsed.rows.length - parsed.validRows;
    if (mode === "commit") {
      if (parsed.errorRows > 0) return NextResponse.json({ error: "File còn dòng lỗi, vui lòng sửa trước khi commit", preview: parsed }, { status: 400 });
      const batch = await commitImport({ importType, templateCode: template.code, fileName: file.name, uploadedBy: auth.session.name, mapping: parsed.mapping, rows: parsed.rows });
      return NextResponse.json({ batch, preview: parsed }, { status: 201 });
    }
    return NextResponse.json({ template, preview: parsed });
  } catch (error) {
    if (isUniqueConstraintError(error)) return NextResponse.json({ error: "File có dữ liệu lương trùng kỳ/nhân viên/chi nhánh" }, { status: 409 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Internal Server Error" }, { status: 500 });
  }
}
