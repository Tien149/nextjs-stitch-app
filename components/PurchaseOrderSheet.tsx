import { forwardRef, type CSSProperties } from "react";
import { money } from "@/lib/format-number";
import { orderDateLabel, orderInfoRows, orderLineQuantity, type SharedOrderLine, type SharedPurchaseOrder } from "@/lib/purchase-order-share";

/**
 * Tờ phiếu đặt hàng gửi NCC theo phiếu mẫu của khách: tiêu đề + QR, "Thông tin đặt hàng",
 * "Danh sách hàng hóa". Trang công khai /po/[token] và hộp thoại Gửi NCC (xuất ảnh) cùng vẽ
 * bằng component này nên ảnh gửi Zalo và link NCC mở ra luôn giống hệt nhau.
 * Chỉ dùng màu cố định (không token theme) để ảnh xuất ra luôn nền trắng chữ đen.
 */
type SheetPage = { number: number; total: number; start: number; end: number };

/**
 * `page`: chỉ dùng khi xuất ẢNH phiếu dài thành nhiều trang (lib/purchase-order-share
 * paginateOrderLines). Trang 1 đủ phần đầu phiếu; trang sau chỉ ghi lại tên NCC + mã đơn, số thứ tự
 * hàng chạy tiếp. Không truyền = cả phiếu (trang công khai, khung xem trước).
 */
export const PurchaseOrderSheet = forwardRef<HTMLDivElement, { order: SharedPurchaseOrder; showPrices?: boolean; className?: string; style?: CSSProperties; page?: SheetPage }>(
  function PurchaseOrderSheet({ order, showPrices = false, className = "", style, page }, ref) {
    const cancelled = order.status === "CANCELLED";
    const start = page?.start ?? 0;
    const lines = page ? order.lines.slice(page.start, page.end) : order.lines;
    const isContinuation = Boolean(page && page.number > 1);
    const isLastPage = !page || page.number === page.total;
    if (isContinuation) {
      return (
        <div ref={ref} style={style} className={`bg-white text-slate-900 p-5 sm:p-7 ${className}`}>
          {cancelled && (
            <p className="mb-3 rounded-lg border-2 border-rose-300 bg-rose-50 px-3 py-2 text-center text-sm font-bold text-rose-700">ĐƠN ĐÃ HUỶ</p>
          )}
          <p className={`text-base leading-snug ${cancelled ? "line-through text-slate-400" : "text-slate-900"}`}>
            Đơn đặt hàng tới <b className="font-bold uppercase">{order.supplierName}</b>
          </p>
          <p className="text-sm text-slate-600 mt-0.5">{order.code} · {order.branchName} · <b>trang {page!.number}/{page!.total}</b></p>
          <div className="my-4 border-t-2 border-dashed border-slate-300" />
          <h2 className="text-lg font-bold text-[#1d6fa5] mb-2">Danh sách hàng hóa (tiếp)</h2>
          <SheetLines lines={lines} start={start} showPrices={showPrices} />
          {isLastPage && <SheetTotal order={order} showPrices={showPrices} />}
          <SheetFooter order={order} page={page} />
        </div>
      );
    }
    return (
      <div ref={ref} style={style} className={`bg-white text-slate-900 p-5 sm:p-7 ${className}`}>
        {cancelled && (
          <p className="mb-4 rounded-lg border-2 border-rose-300 bg-rose-50 px-3 py-2 text-center text-sm font-bold text-rose-700">
            ĐƠN ĐÃ HUỶ — vui lòng không giao hàng theo đơn này
          </p>
        )}
        <div className="flex items-start justify-between gap-4">
          <h1 className={`text-xl sm:text-2xl font-normal leading-snug ${cancelled ? "line-through text-slate-400" : "text-slate-900"}`}>
            Đơn đặt hàng tới <b className="font-bold uppercase">{order.supplierName}</b>
          </h1>
          {/* QR mở lại chính phiếu này */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={order.qrDataUrl} alt={`QR phiếu ${order.code}`} className="w-24 h-24 shrink-0 -mt-1 -mr-1" />
        </div>

        <div className="my-4 border-t-2 border-dashed border-slate-300" />

        <h2 className="text-lg font-bold text-[#1d6fa5] mb-2">Thông tin đặt hàng</h2>
        <div className="text-[15px]">
          {orderInfoRows(order).map((row) => (
            <div key={row.label} className="grid grid-cols-[130px_1fr] gap-2 py-1">
              <span className="text-slate-700">{row.label}:</span>
              <span className={`text-slate-900 ${row.upper ? "uppercase" : ""}`}>{row.value}</span>
            </div>
          ))}
        </div>

        <div className="my-4 border-t-2 border-dashed border-slate-300" />

        <h2 className="text-lg font-bold text-[#1d6fa5] mb-2">Danh sách hàng hóa</h2>
        <SheetLines lines={lines} start={start} showPrices={showPrices} />
        {isLastPage && <SheetTotal order={order} showPrices={showPrices} />}
        <SheetFooter order={order} page={page} />
      </div>
    );
  },
);

function SheetLines({ lines, start, showPrices }: { lines: SharedOrderLine[]; start: number; showPrices: boolean }) {
  return (
    <ol className="space-y-3 text-[15px]">
      {lines.map((line, offset) => (
        <li key={`${line.itemCode}-${start + offset}`}>
          {/* Tên hàng và số lượng cùng một dòng như tin nhắn: "1. Rau Tía Tô: 0,3 Kg" (khách 26/10/2026). */}
          <p className="text-slate-900">
            <b>{start + offset + 1}. {line.itemName}:</b> {orderLineQuantity(line)}
            <span className="ml-1.5 text-xs text-slate-400">{line.itemCode}</span>
            {showPrices && line.unitCost > 0 && (
              <span className="text-slate-500"> · {money(line.unitCost)} đ/{line.unit} = <b className="text-slate-700">{money(line.totalCost)} đ</b></span>
            )}
          </p>
          {line.note && <p className="text-slate-700 mt-0.5">Ghi chú: <i>{line.note}</i></p>}
        </li>
      ))}
    </ol>
  );
}

function SheetTotal({ order, showPrices }: { order: SharedPurchaseOrder; showPrices: boolean }) {
  if (!showPrices || !(order.totalAmount > 0)) return null;
  return (
    <p className="mt-4 pt-3 border-t-2 border-dashed border-slate-300 text-right text-sm">
      Tổng giá trị: <b className="text-base text-slate-900">{money(order.totalAmount)} đ</b>
    </p>
  );
}

function SheetFooter({ order, page }: { order: SharedPurchaseOrder; page?: SheetPage }) {
  return (
    <p className="mt-6 text-[11px] text-slate-400 text-center">
      {page && page.total > 1 && <b className="text-slate-500">Trang {page.number}/{page.total} · </b>}
      Ngày đặt {orderDateLabel(order.orderDate)} · Quét QR hoặc mở link để xem phiếu mới nhất.
    </p>
  );
}
