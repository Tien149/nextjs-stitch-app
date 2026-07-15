"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { appMenuItems, canAccessMenu, type DemoSession, SESSION_KEY } from "@/lib/auth-demo";

type PreviewRow = {
  rowNumber: number;
  values: Record<string, string | number | null>;
  errors: string[];
};

type PreviewPayload = {
  headers: string[];
  mapping: Record<string, string>;
  rows: PreviewRow[];
  totalRows: number;
  validRows: number;
  errorRows: number;
};

type Batch = {
  id: string;
  fileName: string;
  status: string;
  totalRows: number;
  validRows: number;
  errorRows: number;
  uploadedBy: string | null;
  createdAt: string;
};

type ImportUploadPageProps = {
  title: string;
  subtitle: string;
  menuHref: string;
  apiPath: string;
  templatePath: string;
  templateCode: string;
  primaryFields: string[];
};

function getSessionFromStorage(): DemoSession | null {
  const rawSession = localStorage.getItem(SESSION_KEY);
  if (!rawSession) return null;
  try {
    return JSON.parse(rawSession) as DemoSession;
  } catch {
    return null;
  }
}

export default function ImportUploadPage({
  title,
  subtitle,
  menuHref,
  apiPath,
  templatePath,
  templateCode,
  primaryFields,
}: ImportUploadPageProps) {
  const router = useRouter();
  const [user, setUser] = useState<DemoSession | null>(null);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewPayload | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [message, setMessage] = useState("");
  const [isUploading, setIsUploading] = useState(false);

  useEffect(() => {
    const session = getSessionFromStorage();
    const menu = appMenuItems.find((item) => item.href === menuHref);
    if (!session) {
      router.push(`/login?next=${menuHref}`);
      return;
    }
    if (!menu || !canAccessMenu(session.role, menu)) {
      router.push("/");
      return;
    }
    window.setTimeout(() => {
      setUser(session);
      setIsCheckingAuth(false);
    }, 0);
  }, [menuHref, router]);

  const errorRows = useMemo(() => preview?.rows.filter((row) => row.errors.length > 0) || [], [preview]);

  const loadBatches = async () => {
    const response = await fetch(apiPath);
    if (response.ok) setBatches((await response.json()) as Batch[]);
  };

  useEffect(() => {
    if (!isCheckingAuth) {
      window.setTimeout(() => {
        loadBatches();
      }, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCheckingAuth]);

  const upload = async (mode: "preview" | "commit") => {
    if (!file) {
      setMessage("Vui lòng chọn file Excel trước.");
      return;
    }

    setIsUploading(true);
    setMessage("");
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("templateCode", templateCode);

      const response = await fetch(`${apiPath}?mode=${mode}`, {
        method: "POST",
        body: formData,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Không xử lý được file import");

      setPreview(payload.preview);
      setMessage(mode === "preview" ? "Đã đọc file, vui lòng kiểm tra preview." : "Đã commit dữ liệu import.");
      if (mode === "commit") await loadBatches();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Có lỗi khi import file");
    } finally {
      setIsUploading(false);
    }
  };

  if (isCheckingAuth) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-slate-100">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-800">
      <header className="sticky top-0 z-20 bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push("/")}
            className="h-9 w-9 rounded-lg bg-slate-100 hover:bg-slate-200 flex items-center justify-center"
            title="Về dashboard"
          >
            <span className="material-symbols-outlined text-lg">arrow_back</span>
          </button>
          <div>
            <h1 className="text-xl font-bold">{title}</h1>
            <p className="text-xs text-slate-500">{subtitle}</p>
          </div>
        </div>
        <div className="hidden sm:block text-right">
          <p className="text-xs font-bold">{user?.name}</p>
          <p className="text-[11px] text-slate-500">{user?.role}</p>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6 space-y-6">
        <section className="grid grid-cols-1 lg:grid-cols-[420px_1fr] gap-6">
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-5 space-y-4 h-fit">
            <div>
              <p className="text-xs font-bold text-blue-600 uppercase">Import flexible</p>
              <h2 className="font-bold text-lg mt-1">Upload file Excel</h2>
              <p className="text-sm text-slate-500 mt-2">
                Dùng template mẫu trước. Sau này nếu khách đổi tên cột, chỉ chỉnh mapping alias/config.
              </p>
            </div>

            <a
              href={templatePath}
              className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm font-bold hover:bg-slate-50"
            >
              <span className="material-symbols-outlined text-blue-600">download</span>
              Tải file mẫu
            </a>

            <label className="block text-xs font-bold text-slate-600">
              File Excel
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={(event) => setFile(event.target.files?.[0] || null)}
                className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </label>

            {file && <p className="text-xs text-slate-500">Đã chọn: {file.name}</p>}

            <div className="flex gap-2">
              <button
                onClick={() => upload("preview")}
                disabled={isUploading}
                className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white rounded-lg py-2.5 text-sm font-bold"
              >
                Preview
              </button>
              <button
                onClick={() => upload("commit")}
                disabled={isUploading || !preview || preview.errorRows > 0}
                className="flex-1 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg py-2.5 text-sm font-bold"
              >
                Commit
              </button>
            </div>

            {message && <p className="text-sm rounded-lg bg-blue-50 border border-blue-100 text-blue-700 px-3 py-2">{message}</p>}
          </div>

          <section className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
            <div className="p-5 border-b border-slate-200">
              <h2 className="font-bold">Preview dữ liệu</h2>
              <p className="text-xs text-slate-500 mt-1">
                Hệ thống tự nhận header theo alias. Dòng lỗi sẽ bị chặn khi commit.
              </p>
            </div>

            {preview ? (
              <>
                <div className="grid grid-cols-3 gap-3 p-5 border-b border-slate-100">
                  <div className="rounded-lg bg-slate-50 p-3">
                    <p className="text-xs text-slate-500">Tổng dòng</p>
                    <p className="text-xl font-bold">{preview.totalRows}</p>
                  </div>
                  <div className="rounded-lg bg-emerald-50 p-3">
                    <p className="text-xs text-emerald-700">Hợp lệ</p>
                    <p className="text-xl font-bold text-emerald-700">{preview.validRows}</p>
                  </div>
                  <div className="rounded-lg bg-rose-50 p-3">
                    <p className="text-xs text-rose-700">Lỗi</p>
                    <p className="text-xl font-bold text-rose-700">{preview.errorRows}</p>
                  </div>
                </div>

                {errorRows.length > 0 && (
                  <div className="p-5 border-b border-slate-100 bg-rose-50 text-sm text-rose-800">
                    <p className="font-bold">Dòng lỗi đầu tiên:</p>
                    <p className="mt-1">
                      Dòng {errorRows[0].rowNumber}: {errorRows[0].errors.join("; ")}
                    </p>
                  </div>
                )}

                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                      <tr>
                        <th className="px-4 py-3">Dòng</th>
                        {primaryFields.map((field) => (
                          <th key={field} className="px-4 py-3">{field}</th>
                        ))}
                        <th className="px-4 py-3">Lỗi</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {preview.rows.slice(0, 20).map((row) => (
                        <tr key={row.rowNumber} className="hover:bg-slate-50">
                          <td className="px-4 py-3 font-bold">{row.rowNumber}</td>
                          {primaryFields.map((field) => (
                            <td key={field} className="px-4 py-3 whitespace-nowrap">
                              {String(row.values[field] ?? "-")}
                            </td>
                          ))}
                          <td className="px-4 py-3 text-rose-700">{row.errors.join("; ") || "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <div className="px-4 py-16 text-center text-slate-400 text-sm">Chưa có dữ liệu preview.</div>
            )}
          </section>
        </section>

        <section className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          <div className="p-5 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h2 className="font-bold">Lịch sử import</h2>
              <p className="text-xs text-slate-500 mt-1">20 batch gần nhất.</p>
            </div>
            <button onClick={loadBatches} className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-bold hover:bg-slate-50">
              Tải lại
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                <tr>
                  <th className="px-4 py-3">File</th>
                  <th className="px-4 py-3">Trạng thái</th>
                  <th className="px-4 py-3">Dòng</th>
                  <th className="px-4 py-3">Người upload</th>
                  <th className="px-4 py-3">Ngày tạo</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {batches.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-10 text-center text-slate-400">Chưa có batch import.</td>
                  </tr>
                ) : (
                  batches.map((batch) => (
                    <tr key={batch.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 font-bold">{batch.fileName}</td>
                      <td className="px-4 py-3">{batch.status}</td>
                      <td className="px-4 py-3">{batch.validRows}/{batch.totalRows}</td>
                      <td className="px-4 py-3">{batch.uploadedBy || "-"}</td>
                      <td className="px-4 py-3">{new Date(batch.createdAt).toLocaleString("vi-VN")}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
