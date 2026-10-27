import { NextResponse } from "next/server";
import { getRequestSession } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { cleanText } from "@/lib/phase3";
import { vnDay } from "@/lib/recipe-validity";

/**
 * Tra một MÃ chứng từ ra đường dẫn mở đúng màn + đúng phiếu (khách 27/10/2026: "mấy chỗ link nhau,
 * bấm mở qua màn khác và trỏ đúng phiếu"). Mọi chỗ hiện mã phiếu khác trỏ về /open/<mã>; luật "mã
 * nào mở màn nào" chỉ nằm ở đây. Màn đích tự kiểm quyền như khi mở bằng menu.
 *
 * Màn đích đọc `?code=` (lọc + tô sáng đúng phiếu) và `?date=` (ngày chứng từ, để bộ lọc ngày
 * của màn đó chứa phiếu thay vì tải toàn bộ lịch sử).
 */
export async function GET(request: Request) {
  const auth = getRequestSession(request);
  if (!auth.ok) return auth.response;
  const code = cleanText(new URL(request.url).searchParams.get("code"));
  if (!code) return NextResponse.json({ error: "Thiếu mã chứng từ" }, { status: 400 });
  const link = (path: string, params: Record<string, string | null | undefined>) => {
    const query = new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => Boolean(entry[1])));
    return NextResponse.json({ href: `${path}?${query.toString()}` });
  };

  const order = await prisma.purchaseOrder.findFirst({ where: { code }, select: { orderDate: true, branchCode: true } });
  if (order) return link("/procurement", { tab: "orders", code, date: vnDay(order.orderDate), branch: order.branchCode });
  const purchaseRequest = await prisma.purchaseRequest.findFirst({ where: { code }, select: { requestDate: true, branchCode: true } });
  if (purchaseRequest) return link("/procurement", { tab: "requests", code, date: vnDay(purchaseRequest.requestDate), branch: purchaseRequest.branchCode });

  const stockDoc = await prisma.inventoryTransaction.findFirst({ where: { code }, select: { transactionType: true, transactionDate: true, branchCode: true } });
  if (stockDoc) {
    const tab = stockDoc.transactionType === "DIEU_CHUYEN" ? "transfer" : stockDoc.transactionType.startsWith("XUAT_") ? "outbound" : "inbound";
    return link("/inventory", { tab, code, date: vnDay(stockDoc.transactionDate), branch: stockDoc.branchCode });
  }

  const voucher = await prisma.financialVoucher.findFirst({ where: { code }, select: { documentChannel: true, voucherDate: true, branchCode: true } });
  if (voucher) return link(voucher.documentChannel === "BANK" ? "/bank-vouchers" : "/vouchers", { code, date: vnDay(voucher.voucherDate), branch: voucher.branchCode });

  const debt = await prisma.debtRecord.findFirst({ where: { code }, select: { partnerCode: true, documentDate: true, branchCode: true } });
  if (debt) return link("/debts", { partner: debt.partnerCode, code, date: vnDay(debt.documentDate), branch: debt.branchCode });

  const deposit = await prisma.deposit.findFirst({ where: { code }, select: { code: true } });
  if (deposit) return link("/deposits", { search: code, focus: code });

  const transfer = await prisma.moneyTransfer.findFirst({ where: { code }, select: { transferDate: true, branchCode: true } });
  if (transfer) return link("/finance-operations", { tab: "cashbook", period: vnDay(transfer.transferDate).slice(0, 7), branchCode: transfer.branchCode, transfer: code });

  const accrual = await prisma.accrual.findFirst({ where: { code }, select: { branchCode: true } });
  if (accrual) return link("/finance-operations", { tab: "accruals", branchCode: accrual.branchCode, accrual: code });

  const asset = await prisma.assetRecord.findFirst({ where: { code }, select: { branchCode: true } });
  if (asset) return link("/assets", { code, branch: asset.branchCode });

  const workItem = await prisma.workItem.findFirst({ where: { code }, select: { id: true } });
  if (workItem) return NextResponse.json({ href: `/work-management/${workItem.id}` });

  const statement = await prisma.bankStatementTransaction.findFirst({ where: { transactionCode: code }, select: { transactionDate: true } });
  if (statement) {
    const day = vnDay(statement.transactionDate);
    return link("/reconciliations", { q: code, from: day, to: day });
  }

  return NextResponse.json({ error: `Không tìm thấy chứng từ ${code} (có thể đã xoá hoặc bạn chưa có quyền xem).` }, { status: 404 });
}
