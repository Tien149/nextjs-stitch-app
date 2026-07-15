import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { commitImport, isUniqueConstraintError } from "@/lib/import-commit";
import { getImportTemplate } from "@/lib/import-templates";
import { parseImportFile } from "@/lib/import-parser";
import { prisma } from "@/lib/prisma";

const importType = "BANK_STATEMENT" as const;
const menuHref = "/imports/bank-statements";

function getUploadFile(formData: FormData) {
  const file = formData.get("file");
  return file instanceof File ? file : null;
}

export async function GET(request: Request) {
  try {
    const auth = requireMenuAccess(request, menuHref);
    if (!auth.ok) return auth.response;

    const batches = await prisma.importBatch.findMany({
      where: { importType },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: {
        _count: {
          select: { bankTransactions: true },
        },
      },
    });

    return NextResponse.json(batches);
  } catch (error) {
    console.error("Error fetching bank import batches:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const auth = requireMenuAction(request, menuHref, "create");
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const mode = searchParams.get("mode") || "preview";
    const formData = await request.formData();
    const file = getUploadFile(formData);
    const template = getImportTemplate(importType, String(formData.get("templateCode") || ""));

    if (!file) {
      return NextResponse.json({ error: "Thiếu file import" }, { status: 400 });
    }

    if (!template) {
      return NextResponse.json({ error: "Không tìm thấy template import" }, { status: 400 });
    }

    const parsed = await parseImportFile(file, template);

    if (mode === "commit") {
      if (parsed.errorRows > 0) {
        return NextResponse.json(
          { error: "File còn dòng lỗi, vui lòng sửa trước khi commit", preview: parsed },
          { status: 400 },
        );
      }

      const batch = await commitImport({
        importType,
        templateCode: template.code,
        fileName: file.name,
        uploadedBy: auth.session.name,
        mapping: parsed.mapping,
        rows: parsed.rows,
      });

      return NextResponse.json({ batch, preview: parsed }, { status: 201 });
    }

    return NextResponse.json({ template, preview: parsed });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return NextResponse.json({ error: "File có giao dịch trùng với dữ liệu đã import" }, { status: 409 });
    }
    console.error("Error importing bank statements:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Internal Server Error" }, { status: 500 });
  }
}
