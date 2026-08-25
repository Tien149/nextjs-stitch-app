import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { prisma } from "@/lib/prisma";
import { isReachableFromOtherDevices, publicBaseUrl } from "@/lib/public-url";

/**
 * Phiếu đặt hàng công khai cho NHÀ CUNG CẤP: tra bằng shareToken, KHÔNG cần đăng nhập
 * (cùng tiền lệ với /api/branding). Chỉ trả đúng những trường in trên phiếu — không kèm
 * công nợ, giá vốn hay dữ liệu nội bộ khác. Thu hồi link (shareToken = null) là 404 ngay.
 */
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    if (!token || token.length < 16) {
      return NextResponse.json({ error: "Link không hợp lệ" }, { status: 404 });
    }

    const order = await prisma.purchaseOrder.findUnique({
      where: { shareToken: token },
      include: {
        lines: { include: { item: { select: { code: true, name: true, unit: true } } } },
        request: { select: { code: true, neededDate: true } },
      },
    });
    if (!order) {
      return NextResponse.json({ error: "Phiếu không tồn tại hoặc link đã bị thu hồi" }, { status: 404 });
    }

    const [branch, warehouse, supplier, creators] = await Promise.all([
      prisma.masterDataItem.findFirst({ where: { type: "BRANCH", code: order.branchCode } }),
      prisma.masterDataItem.findFirst({ where: { type: "WAREHOUSE", code: order.warehouseCode } }),
      prisma.masterDataItem.findFirst({ where: { type: "PARTNER", code: order.supplierCode } }),
      // PO chỉ lưu TÊN người tạo, mà tên nhân viên không duy nhất. Hai người trùng tên thì tra
      // theo tên sẽ in email/điện thoại của NGƯỜI KHÁC lên phiếu gửi ra ngoài — chỉ đưa liên hệ
      // khi chắc chắn duy nhất một người khớp.
      order.createdBy ? prisma.user.findMany({ where: { name: order.createdBy }, select: { email: true, phone: true }, take: 2 }) : [],
    ]);
    const creator = creators.length === 1 ? creators[0] : null;

    // QR trên phiếu trỏ về chính link công khai này để NCC/nhân viên quét mở lại phiếu.
    // Không lấy origin của request: người đặt mở bằng "localhost" thì QR cũng ra localhost,
    // quét trên điện thoại là trỏ vào chính cái điện thoại đó (xem lib/public-url.ts).
    const publicUrl = `${publicBaseUrl(request)}/po/${token}`;
    const qrDataUrl = await QRCode.toDataURL(publicUrl, { margin: 1, width: 240 });

    return NextResponse.json({
      code: order.code,
      status: order.status,
      orderDate: order.orderDate,
      expectedDate: order.expectedDate || order.request?.neededDate || null,
      supplierName: supplier?.name || order.supplierName,
      supplierCode: order.supplierCode,
      supplierPhone: supplier?.phone || null,
      branchName: branch?.name || order.branchCode,
      warehouseName: warehouse?.name || order.warehouseCode,
      note: order.note,
      createdBy: order.createdBy,
      createdByEmail: creator?.email || null,
      createdByPhone: creator?.phone || null,
      totalAmount: order.totalAmount,
      lines: order.lines.map((line) => ({
        itemCode: line.item.code,
        itemName: line.item.name,
        unit: line.item.unit,
        quantity: line.orderedQuantity,
        unitCost: line.unitCost,
        totalCost: line.totalCost,
      })),
      publicUrl,
      qrDataUrl,
      /** false = link chỉ mở được trên chính máy chủ, gửi ra ngoài sẽ không vào được. */
      shareable: isReachableFromOtherDevices(publicUrl),
    });
  } catch {
    return NextResponse.json({ error: "Không tải được phiếu đặt hàng" }, { status: 500 });
  }
}
