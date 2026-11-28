"use client";

import { useRef, useState } from "react";

/**
 * Ô chụp / chọn ảnh chứng từ (khách 28/11/2026: phiếu hủy hàng và điều chuyển bắt buộc có hình).
 * Ảnh nén ngay trên máy (JPEG, cạnh dài ≤ 1600px) trước khi gửi — ảnh điện thoại 4–8 MB còn
 * khoảng 200–400 KB, gửi nhanh trên 4G và không vượt giới hạn máy chủ.
 */

export type PickedPhoto = { key: string; name: string; dataUrl: string; width: number; height: number };

const MAX_EDGE = 1600;
const QUALITY = 0.8;
export const MAX_PHOTOS = 10;

async function loadBitmap(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === "function") {
    try {
      // imageOrientation "from-image": ảnh dọc chụp từ điện thoại không bị xoay ngang.
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      // Trình duyệt cũ không hỗ trợ tuỳ chọn — dùng <img> bên dưới.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("decode"));
      element.src = url;
    });
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

export async function compressPhoto(file: File): Promise<PickedPhoto> {
  const bitmap = await loadBitmap(file);
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap.source, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/jpeg", QUALITY);
    const name = `${file.name.replace(/\.[^.]+$/, "") || "anh"}.jpg`;
    return { key: `${Date.now()}-${Math.random().toString(36).slice(2)}`, name, dataUrl, width, height };
  } finally {
    bitmap.close();
  }
}

/** Dữ liệu gửi kèm phiếu. */
export function photosPayload(photos: PickedPhoto[]) {
  return photos.map((photo) => ({ name: photo.name, dataUrl: photo.dataUrl, width: photo.width, height: photo.height }));
}

export default function DocumentPhotoPicker({ photos, onChange, label = "Hình ảnh", required = true, disabled = false }: {
  photos: PickedPhoto[];
  onChange: (photos: PickedPhoto[]) => void;
  label?: string;
  required?: boolean;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const addFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setError("");
    const room = MAX_PHOTOS - photos.length;
    if (room <= 0) {
      setError(`Tối đa ${MAX_PHOTOS} ảnh.`);
      return;
    }
    setBusy(true);
    const added: PickedPhoto[] = [];
    let failed = 0;
    for (const file of files.slice(0, room)) {
      try {
        added.push(await compressPhoto(file));
      } catch {
        failed += 1;
      }
    }
    setBusy(false);
    if (failed > 0) setError(`${failed} ảnh không đọc được — chụp hoặc chọn lại.`);
    else if (files.length > room) setError(`Chỉ lấy ${room} ảnh đầu (tối đa ${MAX_PHOTOS} ảnh).`);
    onChange([...photos, ...added]);
  };

  return (
    <div>
      <p className="text-xs font-semibold text-slate-600">
        {label}{required && <span className="text-rose-600"> * bắt buộc</span>}
      </p>
      <div className="mt-1.5 flex flex-wrap gap-2">
        {photos.map((photo) => (
          <div key={photo.key} className="relative h-20 w-20 overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
            {/* eslint-disable-next-line @next/next/no-img-element -- ảnh xem trước dạng data URL */}
            <img src={photo.dataUrl} alt={photo.name} className="h-full w-full object-cover" />
            {!disabled && (
              <button
                type="button"
                className="absolute right-0.5 top-0.5 grid h-6 w-6 place-items-center rounded-full bg-slate-900/70 text-white"
                title="Bỏ ảnh này"
                onClick={() => onChange(photos.filter((candidate) => candidate.key !== photo.key))}
              >
                <span className="material-symbols-outlined text-sm">close</span>
              </button>
            )}
          </div>
        ))}
        {photos.length < MAX_PHOTOS && (
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => inputRef.current?.click()}
            className={`grid h-20 w-20 place-items-center rounded-lg border-2 border-dashed text-center text-[11px] font-semibold ${photos.length === 0 && required ? "border-rose-300 bg-rose-50 text-rose-700" : "border-slate-300 bg-white text-slate-600"} hover:border-blue-400 hover:text-blue-700`}
          >
            <span>
              <span className={`material-symbols-outlined block text-2xl ${busy ? "animate-spin" : ""}`}>{busy ? "progress_activity" : "add_a_photo"}</span>
              {busy ? "Đang nén…" : "Chụp / chọn"}
            </span>
          </button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files || []);
          event.target.value = "";
          void addFiles(files);
        }}
      />
      {error && <p className="mt-1 text-xs text-rose-600">{error}</p>}
    </div>
  );
}
