"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PurchaseOrderSheet } from "@/components/PurchaseOrderSheet";
import { purchaseOrderMessage, type SharedPurchaseOrder } from "@/lib/purchase-order-share";

type SendableOrder = { id: string; code: string; status: string; shareToken: string | null; supplierName: string };
type Contact = { phone?: string | null; email?: string | null };

/** Số điện thoại chỉ giữ chữ số (và dấu + đầu số quốc tế) để ghép link zalo.me / sms:. */
const phoneDigits = (value: string) => value.replace(/[^\d+]/g, "");

/**
 * Gửi đơn mua hàng cho nhà cung cấp ngay trên màn Mua hàng, không phải mở phiếu rồi tự chép.
 *
 * Nội dung gửi đi LUÔN là phiếu theo mẫu của khách (components/PurchaseOrderSheet): ảnh phiếu
 * dán thẳng vào Zalo, hoặc tin nhắn chữ cùng bố cục kèm link xem phiếu có QR. Không có tích hợp
 * Zalo OA / máy chủ mail nên "gửi thẳng" nghĩa là mở sẵn đúng cuộc trò chuyện (zalo.me/<sđt>),
 * soạn sẵn email/SMS, hoặc bảng chia sẻ của điện thoại — người đặt chỉ việc bấm Gửi.
 */
export function SendPurchaseOrderDialog({
  order,
  contact,
  canApprove,
  onClose,
  onChanged,
}: {
  order: SendableOrder;
  contact: Contact;
  canApprove: boolean;
  onClose: () => void;
  /** Đơn vừa được duyệt / vừa cấp link — màn cha tải lại danh sách. */
  onChanged: () => Promise<void> | void;
}) {
  const [status, setStatus] = useState(order.status);
  const [token, setToken] = useState(order.shareToken);
  const [sheet, setSheet] = useState<SharedPurchaseOrder | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPrices, setShowPrices] = useState(false);
  const [phone, setPhone] = useState(contact.phone || "");
  const [email, setEmail] = useState(contact.email || "");
  const sheetRef = useRef<HTMLDivElement>(null);

  const patch = async (body: object) => {
    const response = await fetch("/api/procurement", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Không thực hiện được thao tác");
    return payload;
  };

  /** Cấp link công khai (lấy lại link cũ nếu đã có) rồi tải đúng dữ liệu phiếu NCC sẽ thấy. */
  const loadSheet = useCallback(async (currentToken: string | null) => {
    let shareToken = currentToken;
    if (!shareToken) {
      const payload = await patch({ action: "CREATE_SHARE_LINK", orderId: order.id });
      shareToken = payload.shareToken as string;
      setToken(shareToken);
      await onChanged();
    }
    const response = await fetch(`/api/public/purchase-orders/${shareToken}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Không tải được phiếu đặt hàng");
    setSheet(payload as SharedPurchaseOrder);
  }, [order.id, onChanged]);

  useEffect(() => {
    if (status === "DRAFT") return;
    let cancelled = false;
    // Nút gửi tự khoá tới khi có phiếu (disabled={!sheet}), không cần bật busy ở đây.
    const timer = window.setTimeout(() => {
      loadSheet(token)
        .catch((err: Error) => { if (!cancelled) setError(err.message); })
        .finally(() => { if (!cancelled) setBusy(false); });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
    // Chỉ chạy khi mở hộp thoại / khi đơn vừa được duyệt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const approveThenSend = async () => {
    setBusy(true);
    setError("");
    try {
      await patch({ action: "APPROVE_ORDER", orderId: order.id });
      await onChanged();
      setStatus("APPROVED");
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const message = sheet ? purchaseOrderMessage(sheet, { showPrices }) : "";

  const flash = (text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice((current) => (current === text ? "" : current)), 6000);
  };

  const renderImage = async () => {
    if (!sheetRef.current) throw new Error("Phiếu chưa sẵn sàng");
    const { toBlob } = await import("html-to-image");
    const blob = await toBlob(sheetRef.current, { pixelRatio: 2, backgroundColor: "#ffffff", cacheBust: true });
    if (!blob) throw new Error("Không tạo được ảnh phiếu");
    return blob;
  };

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      window.prompt("Sao chép nội dung:", text);
      return false;
    }
  };

  /** Chép ẢNH phiếu vào bộ nhớ tạm; trình duyệt không cho thì chép tin nhắn chữ. */
  const copyImageOrText = async (): Promise<"image" | "text"> => {
    try {
      const blob = await renderImage();
      if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) throw new Error("no-clipboard-image");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      return "image";
    } catch {
      await copyText(message);
      return "text";
    }
  };

  const fileName = () => `${sheet?.code || order.code}.png`;

  const sendZalo = async () => {
    if (!sheet) return;
    setBusy(true);
    try {
      // Điện thoại: bảng chia sẻ của máy gửi thẳng ẢNH phiếu vào Zalo, chọn đúng người là xong.
      const blob = await renderImage().catch(() => null);
      const file = blob ? new File([blob], fileName(), { type: "image/png" }) : null;
      const isTouch = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
      if (isTouch && file && navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file], text: message, title: `Đơn đặt hàng ${sheet.code}` });
          flash("Đã mở bảng chia sẻ — chọn Zalo rồi chọn nhà cung cấp.");
          return;
        } catch {
          // Người dùng huỷ bảng chia sẻ — rơi xuống cách mở Zalo bên dưới.
        }
      }
      const copied = await copyImageOrText();
      const digits = phoneDigits(phone);
      if (digits) window.open(`https://zalo.me/${digits}`, "_blank", "noopener");
      flash(
        `${copied === "image" ? "Đã chép ẢNH phiếu" : "Đã chép tin nhắn đặt hàng"}. ` +
          (digits ? "Zalo của nhà cung cấp vừa mở — bấm vào khung chat, dán (Ctrl+V / ⌘V) rồi gửi." : "Mở Zalo, chọn nhà cung cấp rồi dán (Ctrl+V / ⌘V). Điền số điện thoại để lần sau mở thẳng khung chat."),
      );
    } finally {
      setBusy(false);
    }
  };

  const sendEmail = () => {
    if (!sheet) return;
    const subject = `${sheet.status === "CANCELLED" ? "[HUỶ] " : ""}Đơn đặt hàng ${sheet.code} - ${sheet.branchName}`;
    window.location.href = `mailto:${encodeURIComponent(email.trim())}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`;
  };

  const sendSms = () => {
    if (!sheet) return;
    // "?&body=" chạy được cả iOS lẫn Android.
    window.location.href = `sms:${phoneDigits(phone)}?&body=${encodeURIComponent(message)}`;
  };

  const downloadImage = async () => {
    setBusy(true);
    try {
      const blob = await renderImage();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName();
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copyImage = async () => {
    setBusy(true);
    try {
      const kind = await copyImageOrText();
      flash(kind === "image" ? "Đã chép ảnh phiếu — dán vào Zalo/Messenger/email." : "Trình duyệt không cho chép ảnh, đã chép tin nhắn chữ thay thế.");
    } finally {
      setBusy(false);
    }
  };

  const cancelled = (sheet?.status || status) === "CANCELLED";

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-3 sm:p-4" onClick={onClose}>
      <div className="bg-white rounded-xl w-full max-w-4xl shadow-xl max-h-[94vh] flex flex-col" onClick={(event) => event.stopPropagation()}>
        <div className="p-4 sm:p-5 border-b border-slate-200 flex items-start justify-between gap-3">
          <div>
            <h3 className="font-bold text-slate-900">{cancelled ? "Báo huỷ đơn cho nhà cung cấp" : "Gửi đơn đặt hàng cho nhà cung cấp"}</h3>
            <p className="text-sm text-slate-500 mt-0.5">{order.code} · {order.supplierName}</p>
          </div>
          <button type="button" onClick={onClose} className="icon-button" title="Đóng"><span className="material-symbols-outlined text-lg">close</span></button>
        </div>

        {status === "DRAFT" ? (
          <div className="p-6 text-sm text-slate-700 space-y-3">
            <p>Đơn <b>{order.code}</b> còn <b>nháp</b>. Đơn phải được duyệt (chốt số lượng, đơn giá) rồi mới gửi nhà cung cấp.</p>
            {error && <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700">{error}</p>}
            {canApprove ? (
              <button type="button" disabled={busy} onClick={() => void approveThenSend()} className="primary-button">
                <span className="material-symbols-outlined text-lg">task_alt</span>Duyệt PO &amp; gửi
              </button>
            ) : (
              <p className="text-slate-500">Bạn chưa có quyền duyệt PO — nhờ người có quyền duyệt rồi mở lại.</p>
            )}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto grid md:grid-cols-[minmax(0,1fr)_300px]">
            {/* Xem trước: đúng tờ phiếu NCC sẽ nhận */}
            <div className="bg-slate-100 p-3 sm:p-5 md:border-r border-slate-200">
              {sheet ? (
                <div className="max-w-md mx-auto rounded-lg border border-slate-200 shadow-sm overflow-hidden">
                  <PurchaseOrderSheet ref={sheetRef} order={sheet} showPrices={showPrices} />
                </div>
              ) : (
                <p className="text-center text-sm text-slate-500 py-16">{error ? "" : "Đang chuẩn bị phiếu..."}</p>
              )}
            </div>

            <div className="p-4 sm:p-5 space-y-4 text-sm">
              {error && <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700">{error}</p>}
              {notice && <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-800">{notice}</p>}

              <div className="space-y-2">
                <label className="block text-xs font-bold text-slate-600">
                  Số điện thoại / Zalo NCC
                  <input value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="VD 0902301111" className="control mt-1 w-full" inputMode="tel" />
                </label>
                <label className="block text-xs font-bold text-slate-600">
                  Email NCC
                  <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="ncc@example.com" className="control mt-1 w-full" inputMode="email" />
                </label>
                {!contact.phone && !contact.email && (
                  <p className="text-[11px] text-slate-500">Nhà cung cấp chưa khai SĐT/email trong danh mục Đối tác — khai một lần để lần sau tự điền.</p>
                )}
              </div>

              <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
                <input type="checkbox" checked={showPrices} onChange={(event) => setShowPrices(event.target.checked)} />
                Kèm đơn giá (phiếu mẫu mặc định không in giá)
              </label>

              <div className="space-y-2">
                <button type="button" disabled={!sheet || busy} onClick={() => void sendZalo()} className="primary-button w-full !bg-[#0068ff] disabled:!bg-slate-300">
                  <span className="material-symbols-outlined text-lg">chat</span>Gửi qua Zalo
                </button>
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" disabled={!sheet || busy} onClick={sendEmail} className="secondary-button w-full">
                    <span className="material-symbols-outlined text-lg">mail</span>Email
                  </button>
                  <button type="button" disabled={!sheet || busy} onClick={sendSms} className="secondary-button w-full">
                    <span className="material-symbols-outlined text-lg">sms</span>SMS
                  </button>
                  <button type="button" disabled={!sheet || busy} onClick={() => void copyImage()} className="secondary-button w-full">
                    <span className="material-symbols-outlined text-lg">image</span>Chép ảnh
                  </button>
                  <button type="button" disabled={!sheet || busy} onClick={() => void downloadImage()} className="secondary-button w-full">
                    <span className="material-symbols-outlined text-lg">download</span>Tải ảnh
                  </button>
                  <button type="button" disabled={!sheet} onClick={() => void copyText(message).then((ok) => ok && flash("Đã chép tin nhắn đặt hàng."))} className="secondary-button w-full">
                    <span className="material-symbols-outlined text-lg">content_copy</span>Chép tin nhắn
                  </button>
                  <button type="button" disabled={!token} onClick={() => token && window.open(`/po/${token}`, "_blank")} className="secondary-button w-full">
                    <span className="material-symbols-outlined text-lg">open_in_new</span>Mở phiếu
                  </button>
                </div>
              </div>

              <p className="text-[11px] leading-relaxed text-slate-500">
                <b>Gửi qua Zalo</b>: trên máy tính, hệ thống chép sẵn ảnh phiếu và mở đúng khung chat của NCC — chỉ cần dán rồi gửi.
                Trên điện thoại, bảng chia sẻ mở ra để chọn Zalo. Ảnh có QR, NCC quét là mở lại phiếu mới nhất.
              </p>
              {sheet && !sheet.shareable && (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                  Link/QR đang trỏ về <b>localhost</b> — NCC sẽ không mở được link. Ảnh phiếu vẫn gửi bình thường; khai <b>APP_PUBLIC_URL</b> trong .env để link dùng được bên ngoài.
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
