"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { branchAccessLabel, branchScopeOptions, displayRoleName } from "@/lib/branch-labels";
import {
  appMenuItems,
  canAccessMenu,
  roleActions,
  type DemoRole,
  type DemoSession,
  SESSION_KEY,
} from "@/lib/auth-demo";

const roleNames: DemoRole[] = ["Admin", "Kế toán tổng hợp", "Kế toán công nợ", "Quản lý", "Viewer"];

type PermissionUser = {
  id: string;
  name: string;
  email: string;
  role: { name: string } | null;
  branchAccesses: { branchCode: string }[];
};

export default function PermissionsPage() {
  const router = useRouter();
  const [user, setUser] = useState<DemoSession | null>(null);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [usersList, setUsersList] = useState<PermissionUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);

  const loadUsers = async () => {
    try {
      setLoadingUsers(true);
      const res = await fetch("/api/permissions");
      if (res.ok) {
        const data = (await res.json()) as PermissionUser[];
        setUsersList(data);
      }
    } catch (e) {
      console.error("Error loading users:", e);
    } finally {
      setLoadingUsers(false);
    }
  };

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
        void loadUsers();
      }, 0);
    } catch {
      localStorage.removeItem(SESSION_KEY);
      router.push("/login?next=/permissions");
    }
  }, [router]);

  const updateBranchAccess = async (userId: string, val: string) => {
    try {
      const branchCodes = val === "ALL" ? ["ALL"] : [val];
      const res = await fetch("/api/permissions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, branchCodes }),
      });
      if (res.ok) {
        void loadUsers();
      } else {
        alert("Lỗi cập nhật chi nhánh");
      }
    } catch (e) {
      console.error(e);
      alert("Lỗi kết nối");
    }
  };

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
            <h1 className="text-xl font-bold text-slate-900">Phân quyền & Người dùng</h1>
            <p className="text-xs text-slate-500">Quản lý tài khoản động, vai trò và phạm vi cửa hàng</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right hidden sm:block">
            <p className="text-xs font-bold text-slate-900">{user?.name}</p>
            <p className="text-[11px] text-slate-500">{displayRoleName(user?.role)}</p>
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
        <section className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          {roleNames.map((role) => (
            <div key={role} className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
              <p className="text-xs text-slate-500 uppercase font-bold">Vai trò</p>
              <h2 className="font-bold mt-1 text-slate-900">{displayRoleName(role)}</h2>
              <div className="mt-4 flex flex-wrap gap-1">
                {roleActions[role].map((action) => (
                  <span key={action} className="text-[11px] rounded bg-slate-100 px-2 py-1 font-semibold text-slate-600">
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
              <h2 className="font-bold text-slate-900">Danh sách tài khoản hệ thống</h2>
              <p className="text-xs text-slate-500 mt-1">Mật khẩu test chung: 123456</p>
            </div>
            <span className="text-xs bg-emerald-50 text-emerald-700 px-2.5 py-1 rounded-full font-bold border border-emerald-100">
              {usersList.length} tài khoản
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs uppercase font-bold">
                <tr>
                  <th className="px-4 py-3">User</th>
                  <th className="px-4 py-3">Vai trò</th>
                  <th className="px-4 py-3">Phạm vi cửa hàng</th>
                  <th className="px-4 py-3 text-right">Hành động</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loadingUsers ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-slate-400">
                      Đang tải danh sách người dùng...
                    </td>
                  </tr>
                ) : (
                  usersList.map((dbUser) => {
                    const branches = dbUser.branchAccesses.map((branchAccess) => branchAccess.branchCode);
                    const branchesStr = branches.includes("ALL") ? "ALL" : branches.join(", ");
                    return (
                      <tr key={dbUser.id} className="hover:bg-slate-50">
                        <td className="px-4 py-3">
                          <p className="font-bold text-slate-900">{dbUser.id === "quanly" ? "Chủ cửa hàng" : dbUser.name}</p>
                          <p className="text-xs text-slate-500">{dbUser.email}</p>
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-xs font-bold bg-blue-50 text-blue-700 px-2 py-1 rounded">
                            {displayRoleName(dbUser.role?.name) || "Viewer"}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
                            branchesStr === "ALL"
                              ? "bg-slate-100 text-slate-700"
                              : branchesStr === "HCM"
                              ? "bg-indigo-50 text-indigo-700"
                              : "bg-amber-50 text-amber-700"
                          }`}>
                            {branchAccessLabel(branches)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <select
                            value={branches.includes("ALL") ? "ALL" : branches[0] || "ALL"}
                            onChange={(e) => updateBranchAccess(dbUser.id, e.target.value)}
                            className="bg-white border border-slate-300 rounded px-2 py-1 text-xs outline-none focus:border-blue-500 cursor-pointer text-slate-700"
                          >
                            {branchScopeOptions.map((option) => (
                              <option key={option.code} value={option.code}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          <div className="p-5 border-b border-slate-200">
            <h2 className="font-bold text-slate-900">Ma trận quyền theo menu</h2>
            <p className="text-xs text-slate-500 mt-1">Quyền truy cập menu chức năng theo các vai trò.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs uppercase font-bold">
                <tr>
                  <th className="px-4 py-3">Menu</th>
                  {roleNames.map((role) => (
                    <th key={role} className="px-4 py-3">
                      {role}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {appMenuItems.map((item) => (
                  <tr key={item.name} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-bold text-slate-900">
                      <span className="material-symbols-outlined text-base mr-2 align-middle text-slate-400">{item.icon}</span>
                      {item.name}
                    </td>
                    {roleNames.map((role) => (
                      <td key={role} className="px-4 py-3">
                        {canAccessMenu(role, item) ? (
                          <span className="text-emerald-600 font-bold flex items-center gap-1">
                            <span className="material-symbols-outlined text-base">check_circle</span> Có
                          </span>
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
