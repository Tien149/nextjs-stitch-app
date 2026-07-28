"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ModuleFrame } from "@/components/ModuleFrame";
import { DateInput } from "@/components/DateInput";
import { displayRoleName, storeLabel, storeOptions } from "@/lib/branch-labels";
import { SESSION_KEY, type DemoSession } from "@/lib/auth-demo";

type AuditLog = {
  id: string;
  occurredAt: string;
  actorId: string | null;
  actorName: string | null;
  actorRole: string | null;
  branchCode: string | null;
  module: string;
  action: string;
  entityType: string;
  entityId: string | null;
  entityCode: string | null;
  status: string;
  message: string | null;
  metadataJson: string | null;
};

export default function AuditLogsPage() {
  const router = useRouter();
  const [user, setUser] = useState<DemoSession | null>(null);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  // Filters state
  const [branchCode, setBranchCode] = useState("ALL");
  const [moduleFilter, setModuleFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  // Modal detail log state
  const [selectedLog, setSelectedLog] = useState<AuditLog | null>(null);

  const loadLogs = async () => {
    try {
      setLoading(true);
      setMessage("");
      const params = new URLSearchParams();
      params.set("branchCode", branchCode);
      params.set("module", moduleFilter);
      if (search.trim()) params.set("search", search.trim());
      if (startDate) params.set("startDate", startDate);
      if (endDate) params.set("endDate", endDate);

      const res = await fetch(`/api/audit-logs?${params.toString()}`);
      if (res.ok) {
        const data = (await res.json()) as AuditLog[];
        setLogs(data);
      } else {
        setMessage("Lỗi không tải được nhật ký thao tác");
      }
    } catch (e) {
      console.error(e);
      setMessage("Không thể kết nối đến máy chủ");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) {
      router.push("/login?next=/audit-logs");
      return;
    }

    try {
      const parsed = JSON.parse(raw) as DemoSession;
      if (parsed.role !== "Admin") {
        router.push("/");
        return;
      }
      window.setTimeout(() => {
        setUser(parsed);
        setIsCheckingAuth(false);
      }, 0);
    } catch {
      localStorage.removeItem(SESSION_KEY);
      router.push("/login?next=/audit-logs");
    }
  }, [router]);

  useEffect(() => {
    if (!isCheckingAuth) {
      window.setTimeout(() => void loadLogs(), 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCheckingAuth, branchCode, moduleFilter, startDate, endDate]);

  if (isCheckingAuth) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-slate-100">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
      </div>
    );
  }

  const criticalCount = logs.filter((l) =>
    ["DELETE", "REOPEN_PERIOD", "REJECT_REQUEST", "CLOSE_PERIOD"].some((term) =>
      l.action.toUpperCase().includes(term)
    )
  ).length;

  return (
    <ModuleFrame
      title="Nhật ký Hệ thống"
      subtitle="GĐ3 - Xem lịch sử thao tác của các tài khoản (Chỉ dành cho Admin/Master)"
      role={user?.role}
    >
      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500">Tổng số log hiển thị</span>
            <span className="material-symbols-outlined text-blue-500 text-xl">history</span>
          </div>
          <p className="text-lg font-bold text-slate-800 mt-1">{logs.length} dòng</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500">Thao tác Mua hàng & Tài sản</span>
            <span className="material-symbols-outlined text-indigo-500 text-xl">shopping_cart</span>
          </div>
          <p className="text-lg font-bold text-indigo-600 mt-1">
            {logs.filter((l) => ["PROCUREMENT", "ASSETS"].includes(l.module)).length} dòng
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500">Thao tác Kho & Sổ quỹ</span>
            <span className="material-symbols-outlined text-emerald-500 text-xl">inventory_2</span>
          </div>
          <p className="text-lg font-bold text-emerald-600 mt-1">
            {logs.filter((l) => ["INVENTORY", "FINANCE_OPERATIONS"].includes(l.module)).length} dòng
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500">Hành động trọng yếu</span>
            <span className="material-symbols-outlined text-rose-500 text-xl">warning</span>
          </div>
          <p className="text-lg font-bold text-rose-600 mt-1">{criticalCount} dòng</p>
        </div>
      </div>

      {/* Main Filter & Panel */}
      <section className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden flex flex-col mb-5">
        {/* Filters Toolbar */}
        <div className="p-4 border-b border-slate-200 bg-slate-50/70 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-bold text-slate-900 text-base">Tra cứu hoạt động</h2>
            <button
              onClick={() => void loadLogs()}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50 transition-colors inline-flex items-center gap-1.5"
            >
              <span className="material-symbols-outlined text-base">refresh</span>
              Tải lại
            </button>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-2.5">
            <div>
              <label className="text-[11px] font-semibold text-slate-500 block mb-1">Cửa hàng / Chi nhánh</label>
              <select
                value={branchCode}
                onChange={(e) => setBranchCode(e.target.value)}
                className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs bg-white focus:border-blue-500 outline-none"
              >
                <option value="ALL">Tất cả chi nhánh</option>
                {storeOptions.map((opt) => (
                  <option key={opt.code} value={opt.code}>
                    {storeLabel(opt.code)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-[11px] font-semibold text-slate-500 block mb-1">Phân hệ</label>
              <select
                value={moduleFilter}
                onChange={(e) => setModuleFilter(e.target.value)}
                className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs bg-white focus:border-blue-500 outline-none"
              >
                <option value="ALL">Tất cả phân hệ</option>
                <option value="PROCUREMENT">Mua hàng (PR/PO)</option>
                <option value="ASSETS">Tài sản & Khấu hao</option>
                <option value="INVENTORY">Kho & Định lượng</option>
                <option value="FINANCE_OPERATIONS">Vận hành Sổ quỹ</option>
                <option value="WORK_MANAGEMENT">Quản lý Công việc</option>
                <option value="REPORTS">Báo cáo & Target</option>
              </select>
            </div>

            <div>
              <label className="text-[11px] font-semibold text-slate-500 block mb-1">Từ ngày</label>
              <DateInput
                value={startDate}
                onChange={setStartDate}
                className="w-full"
                ariaLabel="Từ ngày"
              />
            </div>

            <div>
              <label className="text-[11px] font-semibold text-slate-500 block mb-1">Đến ngày</label>
              <DateInput
                value={endDate}
                onChange={setEndDate}
                className="w-full"
                ariaLabel="Đến ngày"
              />
            </div>

            <div className="col-span-2 md:col-span-1">
              <label className="text-[11px] font-semibold text-slate-500 block mb-1">Từ khóa tìm kiếm</label>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void loadLogs();
                }}
                placeholder="Tên, mã, hành động..."
                className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs focus:border-blue-500 outline-none"
              />
            </div>
          </div>
        </div>

        {/* Message Error */}
        {message && <p className="p-3 text-sm text-red-700 bg-red-50 border-b border-red-100">{message}</p>}

        {/* Table logs */}
        <div className="overflow-x-auto overflow-y-auto max-h-[580px] custom-scrollbar">
          <table className="w-full text-left text-xs min-w-[900px]">
            <thead className="bg-slate-50 text-slate-500 uppercase font-bold border-b border-slate-200 sticky top-0 z-10 shadow-sm">
              <tr>
                <th className="px-4 py-3">Thời gian</th>
                <th className="px-3 py-3">Tài khoản</th>
                <th className="px-3 py-3">Chi nhánh</th>
                <th className="px-3 py-3">Phân hệ</th>
                <th className="px-3 py-3">Hành động</th>
                <th className="px-3 py-3">Đối tượng</th>
                <th className="px-3 py-3">Thông điệp</th>
                <th className="px-4 py-3 text-right">Chi tiết</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-slate-400">
                    Đang tải nhật ký thao tác...
                  </td>
                </tr>
              ) : logs.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-slate-400">
                    Không tìm thấy dữ liệu nhật ký phù hợp.
                  </td>
                </tr>
              ) : (
                logs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-4 py-3">
                      {new Date(log.occurredAt).toLocaleString("vi-VN")}
                    </td>
                    <td className="px-3 py-3">
                      <b>{log.actorName || "Hệ thống"}</b>
                      <p className="text-[10px] text-slate-400">{displayRoleName(log.actorRole)}</p>
                    </td>
                    <td className="px-3 py-3 font-semibold text-slate-600">
                      {log.branchCode ? storeLabel(log.branchCode) : "Hệ thống"}
                    </td>
                    <td className="px-3 py-3">
                      <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-slate-100 text-slate-700">
                        {log.module}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <b
                        className={
                          log.action.includes("DELETE") || log.action.includes("REJECT")
                            ? "text-rose-700 font-bold"
                            : log.action.includes("APPROVE") || log.action.includes("POST")
                            ? "text-emerald-700 font-bold"
                            : "text-slate-700"
                        }
                      >
                        {log.action}
                      </b>
                    </td>
                    <td className="px-3 py-3">
                      <b>{log.entityType}</b>
                      {log.entityCode && <p className="text-[11px] font-semibold text-blue-600">{log.entityCode}</p>}
                    </td>
                    <td className="px-3 py-3 max-w-[200px] truncate text-slate-500" title={log.message || ""}>
                      {log.message || "-"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {log.metadataJson && (
                        <button
                          onClick={() => setSelectedLog(log)}
                          className="text-xs font-bold text-blue-600 hover:text-blue-800 hover:underline"
                        >
                          Xem JSON
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* JSON Metadata Detail Modal */}
      {selectedLog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white border border-slate-200 rounded-xl max-w-2xl w-full max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
              <div>
                <h3 className="font-bold text-slate-900 text-base">Chi tiết dữ liệu Log</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Mã Log: {selectedLog.id} · Đối tượng: {selectedLog.entityType}
                </p>
              </div>
              <button
                onClick={() => setSelectedLog(null)}
                className="h-8 w-8 rounded-lg hover:bg-slate-200 flex items-center justify-center text-slate-500"
              >
                <span className="material-symbols-outlined text-lg">close</span>
              </button>
            </div>
            <div className="p-5 overflow-y-auto flex-1 bg-slate-950 text-slate-200 font-mono text-xs max-h-[500px]">
              <pre className="whitespace-pre-wrap">
                {(() => {
                  try {
                    return JSON.stringify(JSON.parse(selectedLog.metadataJson || "{}"), null, 2);
                  } catch {
                    return selectedLog.metadataJson;
                  }
                })()}
              </pre>
            </div>
            <div className="p-4 border-t border-slate-100 flex justify-end bg-slate-50">
              <button
                onClick={() => setSelectedLog(null)}
                className="rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 text-xs font-bold transition-colors shadow-sm"
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}
    </ModuleFrame>
  );
}
