"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { PurchaseOrderSheet } from "@/components/PurchaseOrderSheet";
import type { SharedPurchaseOrder as PublicOrder } from "@/lib/purchase-order-share";

/**
 * Phiếu đặt hàng gửi NHÀ CUNG CẤP — mở bằng link công khai (không cần đăng nhập),
 * bố cục theo phiếu mẫu của khách: tiêu đề + QR, khối Thông tin đặt hàng, Danh sách hàng hóa.
 * Mặc định KHÔNG hiện đơn giá (như phiếu mẫu); người gửi bật thêm nếu muốn.
 */
export default function PublicPurchaseOrderPage() {
  const params = useParams<{ token: string }>();
  const [order, setOrder] = useState<PublicOrder | null>(null);
  const [error, setError] = useState("");
  const [showPrices, setShowPrices] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch(`/api/public/purchase-orders/${params.token}`).then(async (response) => {
      const payload = await response.json();
      if (response.ok) setOrder(payload as PublicOrder);
      else setError(payload.error || "Không tải được phiếu đặt hàng");
    }).catch(() => setError("Không kết nối được máy chủ"));
  }, [params.token]);

  const copyLink = async () => {
    if (!order) return;
    try {
      await navigator.clipboard.writeText(order.publicUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Sao chép link phiếu:", order.publicUrl);
    }
  };

  const shareLink = async () => {
    if (!order) return;
    if (navigator.share) {
      try {
        await navigator.share({ title: `Đơn đặt hàng ${order.code}`, text: `Đơn đặt hàng tới ${order.supplierName}`, url: order.publicUrl });
        return;
      } catch {
        // Người dùng huỷ chia sẻ — không cần làm gì thêm.
      }
    }
    await copyLink();
  };

  if (error) {
    return (
      <main className="min-h-screen bg-slate-100 grid place-items-center p-6">
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-8 text-center max-w-sm">
          <span className="material-symbols-outlined text-4xl text-slate-400">link_off</span>
          <p className="mt-3 font-bold text-slate-800">{error}</p>
          <p className="mt-1 text-sm text-slate-500">Liên hệ người gửi phiếu để nhận link mới.</p>
        </div>
      </main>
    );
  }

  if (!order) return <main className="min-h-screen bg-slate-100 grid place-items-center p-6 text-slate-500">Đang tải phiếu...</main>;

  return (
    <main className="min-h-screen bg-slate-100 print:bg-white py-4 px-3 sm:py-8 print:p-0">
      <div className="max-w-xl mx-auto">
        {/* Thanh thao tác — không in ra giấy */}
        <div className="print:hidden mb-3 flex flex-wrap gap-2 justify-end">
          <button onClick={() => setShowPrices((current) => !current)} className="secondary-button !min-h-11 text-xs">
            <span className="material-symbols-outlined text-lg">{showPrices ? "visibility_off" : "payments"}</span>
            {showPrices ? "Ẩn đơn giá" : "Hiện đơn giá"}
          </button>
          <button onClick={copyLink} className="secondary-button !min-h-11 text-xs">
            <span className="material-symbols-outlined text-lg">{copied ? "check" : "content_copy"}</span>
            {copied ? "Đã sao chép" : "Sao chép link"}
          </button>
          <button onClick={shareLink} className="secondary-button !min-h-11 text-xs">
            <span className="material-symbols-outlined text-lg">share</span>Chia sẻ
          </button>
          <button onClick={() => window.print()} className="primary-button !min-h-11 text-xs">
            <span className="material-symbols-outlined text-lg">print</span>In phiếu
          </button>
        </div>

        <div className="bg-white rounded-xl print:rounded-none border border-slate-200 print:border-0 shadow-sm print:shadow-none overflow-hidden">
          <PurchaseOrderSheet order={order} showPrices={showPrices} />
          <div className="px-5 sm:px-7 pb-5">
          {/* Link để gõ tay/kiểm tra nhanh khi QR không quét được — ẩn khi in ra giấy */}
          <p className="print:hidden text-[11px] text-center break-all text-slate-400">{order.publicUrl}</p>

          {!order.shareable && (
            <p className="print:hidden mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
              Link này đang trỏ về <b>localhost</b> nên chỉ mở được trên chính máy chạy phần mềm — quét QR bằng điện thoại sẽ báo không kết nối được.
              Khi chạy thật trên máy chủ có tên miền thì link tự đúng; muốn cố định, khai <b>APP_PUBLIC_URL</b> trong tệp <b>.env</b>.
            </p>
          )}
          </div>
        </div>
      </div>
    </main>
  );
}
