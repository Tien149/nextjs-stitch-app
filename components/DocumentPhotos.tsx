"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { compressPhoto, MAX_PHOTOS, photosPayload } from "@/components/DocumentPhotoPicker";

/**
 * Xem ảnh chứng từ trên danh sách phiếu (hủy hàng, điều chuyển — khách 28/11/2026): nút "Ảnh (n)"
 * mở khung xem; ai có quyền thì thêm / xoá ảnh ngay trong khung.
 */

export type PhotoEntityType = "InventoryTransaction" | "InventoryTransferRequest";

type PhotoMeta = { id: string; fileName: string; width: number | null; height: number | null; uploadedBy: string | null; createdAt: string };

/** Số ảnh của từng phiếu đang hiện — một lần gọi cho cả danh sách. */
export function useDocumentPhotoCounts(entityType: PhotoEntityType, ids: string[]) {
  const key = useMemo(() => [...new Set(ids)].sort().join(","), [ids]);
  const [state, setState] = useState<{ key: string; counts: Record<string, number> }>({ key: "", counts: {} });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const chunks: string[][] = [];
    const list = key.split(",");
    for (let index = 0; index < list.length; index += 200) chunks.push(list.slice(index, index + 200));
    void Promise.all(chunks.map(async (chunk) => {
      const params = new URLSearchParams({ view: "counts", entityType, ids: chunk.join(",") });
      const response = await fetch(`/api/document-images?${params.toString()}`);
      return response.ok ? ((await response.json()) as { counts: Record<string, number> }).counts : {};
    })).then((parts) => {
      if (!cancelled) setState({ key, counts: Object.assign({}, ...parts) });
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [entityType, key, version]);

  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  return { counts: state.key === key ? state.counts : null, refresh };
}

export function DocumentPhotosButton({ entityType, entityId, code, count, canAdd, canDelete, onChanged, required = true }: {
  entityType: PhotoEntityType;
  entityId: string;
  code: string;
  count: number | null | undefined;
  canAdd: boolean;
  canDelete: boolean;
  onChanged?: () => void;
  /** Phiếu bắt buộc có ảnh (hủy hàng, điều chuyển khác nhà hàng) — thiếu ảnh thì nút tô vàng. */
  required?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const missing = count === 0 && required;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={missing ? "Phiếu chưa có ảnh" : "Xem ảnh chứng từ"}
        className={`inline-flex items-center gap-1 whitespace-nowrap rounded-lg border px-2 py-1 text-[11px] font-bold ${missing ? "border-amber-200 bg-amber-50 text-amber-700" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`}
      >
        <span className="material-symbols-outlined text-sm">{missing ? "no_photography" : "photo_library"}</span>
        {count === null || count === undefined || count === 0 ? (missing ? "Chưa có ảnh" : "Ảnh") : `Ảnh (${count})`}
      </button>
      {open && (
        <PhotoGallery
          entityType={entityType}
          entityId={entityId}
          code={code}
          canAdd={canAdd}
          canDelete={canDelete}
          onClose={() => setOpen(false)}
          onChanged={onChanged}
        />
      )}
    </>
  );
}

function PhotoGallery({ entityType, entityId, code, canAdd, canDelete, onClose, onChanged }: {
  entityType: PhotoEntityType;
  entityId: string;
  code: string;
  canAdd: boolean;
  canDelete: boolean;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [photos, setPhotos] = useState<PhotoMeta[] | null>(null);
  const [zoom, setZoom] = useState<PhotoMeta | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ entityType, entityId });
    void fetch(`/api/document-images?${params.toString()}`).then(async (response) => {
      const body = (await response.json().catch(() => ({}))) as { images?: PhotoMeta[]; error?: string };
      if (cancelled) return;
      if (!response.ok) {
        setMessage(body.error || "Không tải được ảnh.");
        setPhotos([]);
        return;
      }
      setPhotos(body.images || []);
    });
    return () => {
      cancelled = true;
    };
  }, [entityId, entityType, version]);

  const addPhotos = async (files: File[]) => {
    if (files.length === 0) return;
    setBusy(true);
    setMessage("");
    try {
      const room = MAX_PHOTOS - (photos?.length || 0);
      const compressed = [];
      for (const file of files.slice(0, Math.max(0, room))) compressed.push(await compressPhoto(file));
      if (compressed.length === 0) {
        setMessage(`Phiếu đã đủ ${MAX_PHOTOS} ảnh.`);
        return;
      }
      const response = await fetch("/api/document-images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityType, entityId, images: photosPayload(compressed) }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setMessage(body.error || "Không thêm được ảnh.");
        return;
      }
      setVersion((value) => value + 1);
      onChanged?.();
    } catch {
      setMessage("Ảnh không đọc được — chụp hoặc chọn lại.");
    } finally {
      setBusy(false);
    }
  };

  const removePhoto = async (photo: PhotoMeta) => {
    if (!window.confirm("Xoá ảnh này khỏi phiếu?")) return;
    setBusy(true);
    setMessage("");
    const response = await fetch(`/api/document-images?id=${encodeURIComponent(photo.id)}`, { method: "DELETE" });
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!response.ok) {
      setMessage(body.error || "Không xoá được ảnh.");
      return;
    }
    setZoom(null);
    setVersion((value) => value + 1);
    onChanged?.();
  };

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-slate-900/50 p-2 sm:p-6" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="w-full max-w-3xl rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <h3 className="font-bold text-slate-900">Ảnh chứng từ {code}</h3>
          <button type="button" className="icon-button" title="Đóng" onClick={onClose}>
            <span className="material-symbols-outlined text-lg">close</span>
          </button>
        </div>
        <div className="space-y-3 p-4">
          {message && <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{message}</p>}
          {photos === null ? (
            <p className="py-8 text-center text-sm text-slate-500">Đang tải ảnh…</p>
          ) : photos.length === 0 ? (
            <p className="py-8 text-center text-sm text-amber-700">Phiếu chưa có ảnh{canAdd ? " — bấm “Thêm ảnh” để bổ sung." : "."}</p>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {photos.map((photo) => (
                <button key={photo.id} type="button" className="group relative aspect-square overflow-hidden rounded-lg border border-slate-200 bg-slate-100" onClick={() => setZoom(photo)}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- ảnh lấy từ API có kiểm quyền */}
                  <img src={`/api/document-images?id=${photo.id}`} alt={photo.fileName} loading="lazy" className="h-full w-full object-cover transition-transform group-hover:scale-105" />
                  <span className="absolute inset-x-0 bottom-0 truncate bg-slate-900/60 px-2 py-0.5 text-left text-[10px] text-white">
                    {photo.uploadedBy || ""} · {new Date(photo.createdAt).toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                  </span>
                </button>
              ))}
            </div>
          )}
          {canAdd && (photos?.length || 0) < MAX_PHOTOS && (
            <label className={`secondary-button cursor-pointer ${busy ? "button-disabled" : ""}`}>
              <span className={`material-symbols-outlined text-lg ${busy ? "animate-spin" : ""}`}>{busy ? "progress_activity" : "add_a_photo"}</span>
              {busy ? "Đang xử lý…" : "Thêm ảnh"}
              <input
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                disabled={busy}
                onChange={(event) => {
                  const files = Array.from(event.target.files || []);
                  event.target.value = "";
                  void addPhotos(files);
                }}
              />
            </label>
          )}
        </div>
      </div>
      {zoom && (
        <div className="fixed inset-0 z-[70] flex flex-col bg-slate-950/95" onMouseDown={(event) => { if (event.target === event.currentTarget) setZoom(null); }}>
          <div className="flex items-center justify-between gap-2 px-3 py-2 text-white">
            <span className="truncate text-sm">{zoom.fileName}</span>
            <span className="flex gap-2">
              <a className="grid h-9 w-9 place-items-center rounded-lg bg-white/10 hover:bg-white/20" href={`/api/document-images?id=${zoom.id}`} target="_blank" rel="noreferrer" title="Mở ảnh gốc">
                <span className="material-symbols-outlined text-lg">open_in_new</span>
              </a>
              {canDelete && (
                <button type="button" className="grid h-9 w-9 place-items-center rounded-lg bg-white/10 hover:bg-rose-600" title="Xoá ảnh" disabled={busy} onClick={() => void removePhoto(zoom)}>
                  <span className="material-symbols-outlined text-lg">delete</span>
                </button>
              )}
              <button type="button" className="grid h-9 w-9 place-items-center rounded-lg bg-white/10 hover:bg-white/20" title="Đóng" onClick={() => setZoom(null)}>
                <span className="material-symbols-outlined text-lg">close</span>
              </button>
            </span>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center p-2" onMouseDown={(event) => { if (event.target === event.currentTarget) setZoom(null); }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- ảnh lấy từ API có kiểm quyền */}
            <img src={`/api/document-images?id=${zoom.id}`} alt={zoom.fileName} className="max-h-full max-w-full object-contain" />
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
