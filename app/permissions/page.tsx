"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  appMenuItems,
  canAccessMenu,
  demoUsers,
  roleActions,
  type DemoRole,
  type DemoSession,
  SESSION_KEY,
} from "@/lib/auth-demo";

const roleNames: DemoRole[] = ["Admin", "Kế toán tổng hợp", "Kế toán công nợ", "Quản lý", "Viewer"];

export default function PermissionsPage() {
  const router = useRouter();
  const [user, setUser] = useState<DemoSession | null>(null);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);

  useEffect(() => {
    const session = localStorage.getItem(SESSION_KEY);
    if (!session) {
      router.push("/login?next=/permissions");
      return;
    }

    try {
      const parsedSession = JSON.parse(session) as DemoSession;
      if (parsedSession.role !== "Admin") {
        router.push("/");
        return;
      }
      window.setTimeout(() => {
        setUser(parsedSession);
        setIsCheckingAuth(false);
      }, 0);
    } catch {
      localStorage.removeItem(SESSION_KEY);
      router.push("/login?next=/permissions");
    }
  }, [router]);

  const handleLogout = () => {
    localStorage.removeItem(SESSION_KEY);
    document.cookie = `${SESSION_KEY}=; path=/; expires=Thu, 01 Jan 1970 00:00:01 GMT;`;
    router.push("/login");
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
            <h1 className="text-xl font-bold">Phân quyền & Người dùng</h1>
            <p className="text-xs text-slate-500">Giai đoạn 1: chốt user, vai trò và quyền module</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right hidden sm:block">
            <p className="text-xs font-bold">{user?.name}</p>
            <p className="text-[11px] text-slate-500">{user?.role}</p>
          </div>
          <button
            onClick={handleLogout}
            className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold hover:bg-slate-50"
          >
            Đăng xuất
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6 space-y-6">
        <section className="grid grid-cols-1 lg:grid-cols-4 gap-5">
          {roleNames.map((role) => (
            <div key={role} className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
              <p className="text-xs text-slate-500 uppercase font-bold">Vai trò</p>
              <h2 className="font-bold mt-1">{role}</h2>
              <div className="mt-4 flex flex-wrap gap-1">
                {roleActions[role].map((action) => (
                  <span key={action} className="text-[11px] rounded bg-slate-100 px-2 py-1 font-semibold">
                    {action}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </section>

        <section className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          <div className="p-5 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h2 className="font-bold">Danh sách tài khoản demo</h2>
              <p className="text-xs text-slate-500 mt-1">Mật khẩu test chung: 123456</p>
            </div>
            <span className="text-xs bg-emerald-50 text-emerald-700 px-2 py-1 rounded font-bold">
              {demoUsers.length} tài khoản
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                <tr>
                  <th className="px-4 py-3">User</th>
                  <th className="px-4 py-3">Vai trò</th>
                  <th className="px-4 py-3">Chi nhánh</th>
                  <th className="px-4 py-3">Trạng thái</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {demoUsers.map((demoUser) => (
                  <tr key={demoUser.id}>
                    <td className="px-4 py-3">
                      <p className="font-bold">{demoUser.name}</p>
                      <p className="text-xs text-slate-500">{demoUser.email}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs font-bold bg-blue-50 text-blue-700 px-2 py-1 rounded">
                        {demoUser.role}
                      </span>
                    </td>
                    <td className="px-4 py-3">{demoUser.branch}</td>
                    <td className="px-4 py-3">
                      <span className="text-xs text-emerald-700 font-bold">Hoạt động</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          <div className="p-5 border-b border-slate-200">
            <h2 className="font-bold">Ma trận quyền theo menu</h2>
            <p className="text-xs text-slate-500 mt-1">Dùng để chốt với khách hàng trước khi nối backend.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                <tr>
                  <th className="px-4 py-3">Menu</th>
                  {roleNames.map((role) => (
                    <th key={role} className="px-4 py-3">
                      {role}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {appMenuItems.map((item) => (
                  <tr key={item.name}>
                    <td className="px-4 py-3 font-bold">
                      <span className="material-symbols-outlined text-base mr-2 align-middle">{item.icon}</span>
                      {item.name}
                    </td>
                    {roleNames.map((role) => (
                      <td key={role} className="px-4 py-3">
                        {canAccessMenu(role, item) ? (
                          <span className="text-emerald-600 font-bold">Có</span>
                        ) : (
                          <span className="text-slate-300">-</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
