"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Bấm mã chứng từ ở bất kỳ màn nào → /open/<mã> → mở đúng màn, đúng phiếu (khách 27/10/2026, cùng
 * tab). Luật "mã nào mở màn nào" ở /api/doc-link; trang này chỉ chuyển hướng (replace để nút Back
 * quay thẳng về màn trước).
 */
export default function OpenDocumentPage() {
  const params = useParams<{ code: string }>();
  const router = useRouter();
  const code = decodeURIComponent(params.code || "");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/doc-link?code=${encodeURIComponent(code)}`)
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as { href?: string; error?: string };
        if (cancelled) return;
        if (response.status === 401) router.replace(`/login?next=${encodeURIComponent(`/open/${code}`)}`);
        else if (response.ok && payload.href) router.replace(payload.href);
        else setError(payload.error || `Không mở được chứng từ ${code}.`);
      })
      .catch(() => { if (!cancelled) setError("Mất kết nối tới máy chủ — thử lại."); });
    return () => { cancelled = true; };
  }, [code, router]);

  return (
    <main className="min-h-screen grid place-items-center bg-slate-100 p-6 text-center">
      {error ? (
        <div className="space-y-3">
          <p className="text-sm text-slate-700">{error}</p>
          <button type="button" onClick={() => router.back()} className="text-sm font-bold text-blue-700 hover:underline">← Quay lại</button>
          <span className="mx-2 text-slate-300">·</span>
          <Link href="/" className="text-sm font-bold text-blue-700 hover:underline">Trang chủ</Link>
        </div>
      ) : (
        <p className="text-sm text-slate-500">Đang mở {code}...</p>
      )}
    </main>
  );
}
