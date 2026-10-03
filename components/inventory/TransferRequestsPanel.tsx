"use client";

import { useState } from "react";
import CopyableText from "@/components/CopyableText";
import { storeLabel } from "@/lib/branch-labels";
import { quantity as qty } from "@/lib/format-number";

/**
 * Khung "Phiếu điều chuyển chờ duyệt" ở tab Điều chuyển (khách chốt 03/10/2026) — xem
 * lib/inventory-transfer-request.ts. Nhà hàng chuyển lập phiếu; nhà hàng nhận đếm hàng rồi Duyệt
 * nhận (sửa được số thực nhận, chọn ngày nhận) hoặc Trả lại kèm lý do. Bên chuyển sửa / huỷ phiếu
 * chưa duyệt. Máy chủ gửi sẵn cờ canApprove / canEdit theo quyền cửa hàng + kho của người xem.
 */
export type TransferRequestLine = {
  itemId: string;
  itemCode: string;
  itemName: string;
  unit: string;
  inputQuantity: number;
  inputUnitCode: string | null;
  receivedQuantity?: number | null;
};
export type TransferRequest = {
  id: string;
  code: string;
  status: string;
  requestDate: string;
  branchCode: string;
  warehouseCode: string;
  toBranchCode: string;
  toWarehouseCode: string;
  referenceCode: string | null;
  note: string | null;
  lines: TransferRequestLine[];
  createdBy: string | null;
  returnedBy: string | null;
  returnedReason: string | null;
  canApprove: boolean;
  canEdit: boolean;
};

type Props = {
  requests: TransferRequest[];
  warehouseName: (code: string) => string;
  /** POST /api/inventory; trang tự báo thành công + tải lại. Lỗi trả về để hiện ngay trong hộp thoại. */
  onAction: (body: object, success: string) => Promise<{ ok: boolean; error?: string }>;
};

const today = () => new Date().toISOString().slice(0, 10);
const lineUnit = (line: TransferRequestLine) => line.inputUnitCode || line.unit;

type Dialog =
  | { kind: "approve"; request: TransferRequest; date: string; received: string[] }
  | { kind: "return"; request: TransferRequest; reason: string }
  | { kind: "edit"; request: TransferRequest; date: string; note: string; referenceCode: string; quantities: string[] };

export default function TransferRequestsPanel({ requests, warehouseName, onAction }: Props) {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState<TransferRequest | null>(null);
  const [error, setError] = useState("");

  if (requests.length === 0) return null;
  const waitingForMe = requests.filter((request) => request.canApprove && request.status === "PENDING").length;

  const run = async (body: object, success: string) => {
    setBusy(true);
    setError("");
    const result = await onAction(body, success);
    setBusy(false);
    if (result.ok) {
      setDialog(null);
      setConfirmCancel(null);
    } else {
      setError(result.error || "Không thực hiện được thao tác");
    }
    return result.ok;
  };
  const openDialog = (next: Dialog) => {
    setError("");
    setDialog(next);
  };

  const submitDialog = async () => {
    if (!dialog) return;
    if (dialog.kind === "approve") {
      await run({ action: "APPROVE_TRANSFER_REQUEST", id: dialog.request.id, receivedDate: dialog.date, receivedQuantities: dialog.received }, `Đã duyệt nhận phiếu ${dialog.request.code} — tồn kho hai bên đã cập nhật.`);
    } else if (dialog.kind === "return") {
      await run({ action: "RETURN_TRANSFER_REQUEST", id: dialog.request.id, reason: dialog.reason }, `Đã trả lại phiếu ${dialog.request.code} cho bên chuyển.`);
    } else {
      const lines = dialog.request.lines
        .map((line, index) => ({ itemId: line.itemId, inputQuantity: dialog.quantities[index], inputUnitCode: line.inputUnitCode || undefined }))
        .filter((line) => Number(line.inputQuantity) > 0);
      await run({
        action: "UPDATE_TRANSFER_REQUEST",
        id: dialog.request.id,
        transactionDate: dialog.date,
        note: dialog.note,
        referenceCode: dialog.referenceCode,
        lines,
      }, `Đã sửa và gửi lại phiếu ${dialog.request.code} — chờ bên nhận duyệt.`);
    }
  };

  return (
    <section className="table-panel shadow-sm border-amber-200">
      <div className="p-5 pb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-bold text-slate-800">
            Phiếu điều chuyển chờ duyệt <span className="text-amber-700">({requests.length})</span>
          </h2>
          <p className="text-xs text-slate-500 mt-1 max-w-2xl">
            Hàng đang đi đường: chưa trừ kho chuyển, chưa cộng kho nhận. Nhà hàng nhận đếm hàng rồi <b>Duyệt nhận</b> (sửa được số thực nhận)
            hoặc <b>Trả lại</b> kèm lý do; bên chuyển sửa rồi gửi lại.
          </p>
        </div>
        {waitingForMe > 0 && (
          <span className="status bg-amber-100 text-amber-800">{waitingForMe} phiếu chờ bạn duyệt nhận</span>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500 uppercase border-y border-slate-200">
            <tr>
              <th className="px-4 py-3 text-left font-bold">Phiếu</th>
              <th className="px-4 py-3 text-left font-bold">Tuyến</th>
              <th className="px-4 py-3 text-left font-bold">Mặt hàng</th>
              <th className="px-4 py-3 text-left font-bold">Trạng thái</th>
              <th className="px-4 py-3 text-right font-bold">Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((request) => (
              <tr key={request.id} className="border-t border-slate-100 align-top">
                <td className="cell whitespace-nowrap">
                  <CopyableText value={request.code}><b>{request.code}</b></CopyableText>
                  <small className="block text-slate-500">Chuyển {new Date(request.requestDate).toLocaleDateString("vi-VN")}{request.createdBy ? ` · ${request.createdBy}` : ""}</small>
                </td>
                <td className="cell">
                  <b>{request.warehouseCode} → {request.toWarehouseCode}</b>
                  <small className="block text-slate-500">{storeLabel(request.branchCode)} → {storeLabel(request.toBranchCode)}</small>
                </td>
                <td className="cell min-w-[220px]">
                  {request.lines.map((line) => (
                    <span key={line.itemId} className="block">{line.itemName}: <b>{qty(line.inputQuantity)}</b> {lineUnit(line)}</span>
                  ))}
                  {request.note && <small className="block text-slate-500 mt-1">Ghi chú: {request.note}</small>}
                </td>
                <td className="cell">
                  {request.status === "RETURNED" ? (
                    <>
                      <span className="status bg-rose-100 text-rose-700">Bị trả lại</span>
                      <small className="block text-rose-700 mt-1">{request.returnedReason}{request.returnedBy ? ` — ${request.returnedBy}` : ""}</small>
                    </>
                  ) : (
                    <span className="status bg-amber-100 text-amber-800">Chờ duyệt nhận</span>
                  )}
                </td>
                <td className="cell">
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {request.canApprove && request.status === "PENDING" && (
                      <>
                        <button
                          type="button"
                          onClick={() => openDialog({ kind: "approve", request, date: today(), received: request.lines.map((line) => String(line.inputQuantity)) })}
                          className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-bold text-emerald-700 hover:bg-emerald-100"
                        >
                          Duyệt nhận
                        </button>
                        <button
                          type="button"
                          onClick={() => openDialog({ kind: "return", request, reason: "" })}
                          className="rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-[11px] font-bold text-rose-700 hover:bg-rose-100"
                        >
                          Trả lại
                        </button>
                      </>
                    )}
                    {request.canEdit && (
                      <>
                        <button
                          type="button"
                          onClick={() => openDialog({
                            kind: "edit",
                            request,
                            date: String(request.requestDate).slice(0, 10),
                            note: request.note || "",
                            referenceCode: request.referenceCode || "",
                            quantities: request.lines.map((line) => String(line.inputQuantity)),
                          })}
                          className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-bold text-slate-700 hover:bg-slate-100"
                        >
                          {request.status === "RETURNED" ? "Sửa & gửi lại" : "Sửa"}
                        </button>
                        <button
                          type="button"
                          onClick={() => { setError(""); setConfirmCancel(request); }}
                          className="rounded-full border border-slate-200 px-2.5 py-1 text-[11px] font-bold text-slate-400 hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600"
                        >
                          Huỷ phiếu
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {dialog && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <form
            onSubmit={(event) => { event.preventDefault(); void submitDialog(); }}
            className="bg-white rounded-xl w-full max-w-2xl shadow-xl max-h-[92vh] overflow-y-auto"
          >
            <div className="p-5 border-b border-slate-200">
              <h3 className="font-bold text-slate-900">
                {dialog.kind === "approve" ? "Duyệt nhận" : dialog.kind === "return" ? "Trả lại" : "Sửa"} phiếu {dialog.request.code}
              </h3>
              <p className="text-xs text-slate-500 mt-1">
                {warehouseName(dialog.request.warehouseCode)} ({storeLabel(dialog.request.branchCode)}) → {warehouseName(dialog.request.toWarehouseCode)} ({storeLabel(dialog.request.toBranchCode)})
              </p>
            </div>

            <div className="p-5 space-y-4 text-sm">
              {dialog.kind === "return" ? (
                <label className="block text-xs font-bold text-slate-500">
                  Lý do trả lại *
                  <textarea
                    className="control mt-1 min-h-[90px]"
                    value={dialog.reason}
                    onChange={(event) => setDialog({ ...dialog, reason: event.target.value })}
                    placeholder="VD: hàng chưa tới, sai mặt hàng, thiếu số lượng..."
                    required
                  />
                </label>
              ) : (
                <>
                  <div className="grid sm:grid-cols-2 gap-3">
                    <label className="block text-xs font-bold text-slate-500">
                      {dialog.kind === "approve" ? "Ngày nhận hàng" : "Ngày điều chuyển"}
                      <input type="date" className="control mt-1" value={dialog.date} onChange={(event) => setDialog({ ...dialog, date: event.target.value })} required />
                    </label>
                    {dialog.kind === "edit" && (
                      <label className="block text-xs font-bold text-slate-500">
                        Tham chiếu
                        <input className="control mt-1" value={dialog.referenceCode} onChange={(event) => setDialog({ ...dialog, referenceCode: event.target.value })} />
                      </label>
                    )}
                  </div>
                  {dialog.kind === "approve" && (
                    <p className="text-xs text-slate-500">
                      Phiếu kho ghi theo <b>ngày nhận</b> và <b>số thực nhận</b>: trừ kho chuyển, cộng kho nhận, liên nhà hàng thì sinh công nợ nội bộ.
                      Dòng thực nhận 0 sẽ bị bỏ.
                    </p>
                  )}
                  <table className="w-full text-sm">
                    <thead className="text-xs text-slate-500 uppercase border-b border-slate-200">
                      <tr>
                        <th className="py-2 text-left">Mặt hàng</th>
                        <th className="py-2 text-right">{dialog.kind === "approve" ? "SL chuyển" : "ĐVT"}</th>
                        <th className="py-2 text-right w-36">{dialog.kind === "approve" ? "SL thực nhận" : "Số lượng"}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dialog.request.lines.map((line, index) => {
                        const values = dialog.kind === "approve" ? dialog.received : dialog.quantities;
                        const differs = dialog.kind === "approve" && Number(values[index]) !== line.inputQuantity;
                        return (
                          <tr key={line.itemId} className="border-b border-slate-100">
                            <td className="py-2 pr-2">{line.itemName}<small className="block text-slate-400">{line.itemCode}</small></td>
                            <td className="py-2 pr-2 text-right tabular-nums">{dialog.kind === "approve" ? `${qty(line.inputQuantity)} ${lineUnit(line)}` : lineUnit(line)}</td>
                            <td className="py-2 text-right">
                              <input
                                type="number"
                                step="any"
                                min="0"
                                className={`control text-right ${differs ? "border-amber-400 bg-amber-50" : ""}`}
                                value={values[index]}
                                onChange={(event) => {
                                  const next = [...values];
                                  next[index] = event.target.value;
                                  setDialog(dialog.kind === "approve" ? { ...dialog, received: next } : { ...dialog, quantities: next });
                                }}
                                required
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {dialog.kind === "edit" && (
                    <>
                      <p className="text-xs text-slate-500">Nhập 0 để bỏ dòng. Đổi kho hoặc thêm mặt hàng thì huỷ phiếu và lập phiếu mới.</p>
                      <label className="block text-xs font-bold text-slate-500">
                        Ghi chú
                        <input className="control mt-1" value={dialog.note} onChange={(event) => setDialog({ ...dialog, note: event.target.value })} />
                      </label>
                    </>
                  )}
                </>
              )}
            </div>

            {error && <p className="mx-5 mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
            <div className="p-5 border-t border-slate-200 flex justify-end gap-2">
              <button type="button" onClick={() => setDialog(null)} className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50">Đóng</button>
              <button
                type="submit"
                disabled={busy}
                className={`rounded-lg px-4 py-2 text-sm font-bold text-white disabled:opacity-60 ${dialog.kind === "return" ? "bg-rose-600 hover:bg-rose-700" : dialog.kind === "approve" ? "bg-emerald-600 hover:bg-emerald-700" : "bg-blue-600 hover:bg-blue-700"}`}
              >
                {busy ? "Đang xử lý..." : dialog.kind === "approve" ? "Duyệt nhận" : dialog.kind === "return" ? "Trả lại" : "Lưu & gửi lại"}
              </button>
            </div>
          </form>
        </div>
      )}

      {confirmCancel && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-md shadow-xl p-5 space-y-4">
            <h3 className="font-bold text-slate-900">Huỷ phiếu {confirmCancel.code}?</h3>
            <p className="text-sm text-slate-600">Phiếu chưa duyệt nên tồn kho không đổi. Hàng đã gửi đi thì lập phiếu mới.</p>
            {error && <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => { setConfirmCancel(null); setError(""); }} className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50">Không</button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run({ action: "CANCEL_TRANSFER_REQUEST", id: confirmCancel.id }, `Đã huỷ phiếu ${confirmCancel.code}.`)}
                className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-bold text-white hover:bg-rose-700"
              >
                Huỷ phiếu
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
