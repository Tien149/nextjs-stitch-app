import { NextResponse } from "next/server";
import { requireMenuAction } from "@/lib/api-auth";
import { assertBranchAccess } from "@/lib/accounting";
import { prisma } from "@/lib/prisma";
import { cleanMoneySourceName } from "@/lib/money-sources";

/**
 * Đổi tên một "Nguồn tiền tổng".
 *
 * Tên tổng không phải bản ghi riêng, nó chỉ là chuỗi ghi trên từng nguồn tiền và báo cáo gộp
 * theo đúng chuỗi đó. Vì vậy sửa tên phải cập nhật đồng loạt mọi nguồn đang mang tên cũ; sửa
 * lẻ một nguồn sẽ tách nhóm thành hai dòng trên Báo cáo nguồn tiền.
 */
export async function PATCH(request: Request) {
  try {
    const auth = requireMenuAction(request, "/settings", "config");
    if (!auth.ok) return auth.response;

    const body = await request.json();
    const currentName = String(body.currentName || "").trim();
    const nextName = cleanMoneySourceName(body.nextName);

    if (!currentName) {
      return NextResponse.json({ error: "Thiếu tên nguồn tiền tổng cần sửa" }, { status: 400 });
    }
    if (!nextName) {
      return NextResponse.json({ error: "Tên nguồn tiền tổng mới không được để trống" }, { status: 400 });
    }

    const affected = await prisma.masterDataItem.findMany({
      where: {
        type: "MONEY_SOURCE",
        summarySourceName: { equals: currentName, mode: "insensitive" },
      },
      select: { id: true, code: true, name: true, branch: true },
    });

    if (!affected.length) {
      return NextResponse.json(
        { error: `Không còn nguồn tiền nào gộp vào "${currentName}"` },
        { status: 404 },
      );
    }

    // Chặn đổi tên khi nhóm có nguồn thuộc cửa hàng ngoài phân công: sửa được một nửa thì
    // nhóm bị tách làm hai dòng, tệ hơn là không cho sửa.
    try {
      for (const item of affected) assertBranchAccess(auth.session, item.branch || "");
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "Không có quyền đổi tên nhóm này" },
        { status: 403 },
      );
    }

    await prisma.masterDataItem.updateMany({
      where: { id: { in: affected.map((item) => item.id) } },
      data: { summarySourceName: nextName },
    });

    return NextResponse.json({
      name: nextName,
      updated: affected.length,
      codes: affected.map((item) => item.code),
    });
  } catch (error) {
    console.error("Error renaming summary money source:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
