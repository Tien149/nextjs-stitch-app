"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { branchAccessLabel, branchScopeOptions, displayRoleName } from "@/lib/branch-labels";
import {
  ALL_APP_ACTIONS,
  appMenuItems,
  canAccessMenu,
  type AppAction,
  type DemoSession,
  SESSION_KEY,
} from "@/lib/auth-demo";

type RoleItem = {
  id: string;
  name: string;
  actions: AppAction[];
  _count?: { users: number };
};

type PermissionUser = {
  id: string;
  name: string;
  email: string;
  phone?: string | null;
  position?: string | null;
  roleId: string | null;
  role: { id: string; name: string } | null;
  branchAccesses: { branchCode: string }[];
};

export default function PermissionsPage() {
  const router = useRouter();
  const [user, setUser] = useState<DemoSession | null>(null);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);

  // Data states
  const [rolesList, setRolesList] = useState<RoleItem[]>([]);
  const [usersList, setUsersList] = useState<PermissionUser[]>([]);
  const [loadingData, setLoadingData] = useState(true);

  // Modal State for Role Creation / Editing
  const [isRoleModalOpen, setIsRoleModalOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<RoleItem | null>(null);
  const [roleForm, setRoleForm] = useState<{ name: string; actions: AppAction[] }>({
    name: "",
    actions: ["view"],
  });
  const [savingRole, setSavingRole] = useState(false);
  const [roleFormError, setRoleFormError] = useState("");

  // Modal State for User Creation
  const [isUserModalOpen, setIsUserModalOpen] = useState(false);
  const [userForm, setUserForm] = useState({
    email: "",
    password: "",
    name: "",
    phone: "",
    position: "",
    roleId: "",
    branchCode: "ALL",
  });
  const [savingUser, setSavingUser] = useState(false);
  const [userFormError, setUserFormError] = useState("");

  const loadData = async () => {
    try {
      setLoadingData(true);
      const res = await fetch("/api/permissions");
      if (res.ok) {
        const payload = await res.json();
        setUsersList(payload.users || []);
        setRolesList(payload.roles || []);
      }
    } catch (e) {
      console.error("Error loading permissions data:", e);
    } finally {
      setLoadingData(false);
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
        void loadData();
      }, 0);
    } catch {
      localStorage.removeItem(SESSION_KEY);
      router.push("/login?next=/permissions");
    }
  }, [router]);

  // Role Modal Handlers
  const handleOpenCreateRoleModal = () => {
    setEditingRole(null);
    setRoleForm({ name: "", actions: ["view", "create"] });
    setRoleFormError("");
    setIsRoleModalOpen(true);
  };

  const handleOpenEditRoleModal = (role: RoleItem) => {
    setEditingRole(role);
    setRoleForm({ name: role.name, actions: role.actions || ["view"] });
    setRoleFormError("");
    setIsRoleModalOpen(true);
  };

  const handleToggleAction = (actionKey: AppAction) => {
    setRoleForm((prev) => {
      const exists = prev.actions.includes(actionKey);
      if (exists) {
        return { ...prev, actions: prev.actions.filter((a) => a !== actionKey) };
      } else {
        return { ...prev, actions: [...prev.actions, actionKey] };
      }
    });
  };

  const handleSelectAllActions = () => {
    setRoleForm((prev) => ({ ...prev, actions: ALL_APP_ACTIONS.map((a) => a.key) }));
  };

  const handleDeselectAllActions = () => {
    setRoleForm((prev) => ({ ...prev, actions: ["view"] }));
  };

  const handleSaveRole = async (e: React.FormEvent) => {
    e.preventDefault();
    setRoleFormError("");
    if (!roleForm.name.trim()) {
      setRoleFormError("Vui lòng nhập tên vai trò.");
      return;
    }
    if (roleForm.actions.length === 0) {
      setRoleFormError("Vui lòng tích chọn ít nhất 1 quyền trong ma trận.");
      return;
    }

    setSavingRole(true);
    try {
      const isEdit = !!editingRole;
      const res = await fetch("/api/permissions", {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isEdit
            ? { roleId: editingRole.id, name: roleForm.name, actions: roleForm.actions }
            : { action: "CREATE_ROLE", name: roleForm.name, actions: roleForm.actions }
        ),
      });

      const payload = await res.json();
      if (res.ok) {
        setIsRoleModalOpen(false);
        await loadData();
      } else {
        setRoleFormError(payload.error || "Không thể lưu vai trò.");
      }
    } catch {
      setRoleFormError("Đã xảy ra lỗi kết nối.");
    } finally {
      setSavingRole(false);
    }
  };

  const handleDeleteRole = async (role: RoleItem) => {
    if (role._count?.users && role._count.users > 0) {
      alert(`Không thể xóa vai trò "${role.name}" vì đang có ${role._count.users} người dùng được gán.`);
      return;
    }
    if (!confirm(`Bạn có chắc chắn muốn xóa vai trò "${role.name}" không?`)) return;

    try {
      const res = await fetch(`/api/permissions?roleId=${role.id}`, {
        method: "DELETE",
      });
      const payload = await res.json();
      if (res.ok) {
        await loadData();
      } else {
        alert(payload.error || "Không xóa được vai trò.");
      }
    } catch {
      alert("Lỗi kết nối máy chủ.");
    }
  };

  // User Modal Handlers
  const handleOpenCreateUserModal = () => {
    setUserForm({
      email: "",
      password: "",
      name: "",
      phone: "",
      position: "",
      roleId: rolesList[0]?.id || "",
      branchCode: "ALL",
    });
    setUserFormError("");
    setIsUserModalOpen(true);
  };

  const handleSaveUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setUserFormError("");
    if (!userForm.email.trim()) {
      setUserFormError("Vui lòng nhập Email / Tên đăng nhập.");
      return;
    }
    if (!userForm.password.trim()) {
      setUserFormError("Vui lòng nhập mật khẩu.");
      return;
    }
    if (!userForm.name.trim()) {
      setUserFormError("Vui lòng nhập Họ và tên.");
      return;
    }
    if (!userForm.roleId) {
      setUserFormError("Vui lòng chọn vai trò cho người dùng.");
      return;
    }

    setSavingUser(true);
    try {
      const res = await fetch("/api/permissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "CREATE_USER",
          email: userForm.email,
          password: userForm.password,
          name: userForm.name,
          phone: userForm.phone,
          position: userForm.position,
          roleId: userForm.roleId,
          branchCodes: userForm.branchCode === "ALL" ? ["ALL"] : [userForm.branchCode],
        }),
      });

      const payload = await res.json();
      if (res.ok) {
        setIsUserModalOpen(false);
        await loadData();
      } else {
        setUserFormError(payload.error || "Không thể tạo người dùng.");
      }
    } catch {
      setUserFormError("Đã xảy ra lỗi kết nối.");
    } finally {
      setSavingUser(false);
    }
  };

  const updateUserRole = async (userId: string, roleId: string) => {
    try {
      const res = await fetch("/api/permissions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, roleId }),
      });
      if (res.ok) {
        void loadData();
      } else {
        alert("Lỗi cập nhật vai trò người dùng");
      }
    } catch {
      alert("Lỗi kết nối");
    }
  };

  const updateBranchAccess = async (userId: string, val: string) => {
    try {
      const branchCodes = val === "ALL" ? ["ALL"] : [val];
      const res = await fetch("/api/permissions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, branchCodes }),
      });
      if (res.ok) {
        void loadData();
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
    <div className="min-h-screen bg-slate-100 text-slate-800 pb-12">
      {/* Header */}
      <header className="sticky top-0 z-20 bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push("/")}
            className="h-9 w-9 rounded-lg bg-slate-100 hover:bg-slate-200 flex items-center justify-center transition"
            title="Về dashboard"
          >
            <span className="material-symbols-outlined text-lg">arrow_back</span>
          </button>
          <div>
            <h1 className="text-xl font-bold text-slate-900">Phân quyền & Người dùng</h1>
            <p className="text-xs text-slate-500">Quản lý người dùng, vai trò động, ma trận phân quyền và phạm vi cửa hàng</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right hidden sm:block">
            <p className="text-xs font-bold text-slate-900">{user?.name}</p>
            <p className="text-[11px] text-slate-500">{displayRoleName(user?.role)}</p>
          </div>
          <button
            onClick={handleLogout}
            className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold hover:bg-slate-50 transition"
          >
            Đăng xuất
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6 space-y-6">
        {/* Dynamic Roles Cards Section */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold text-slate-900">Ma trận vai trò & Quyền hệ thống</h2>
              <p className="text-xs text-slate-500">Các vai trò có thể chỉnh sửa ma trận quyền linh hoạt theo nhu cầu</p>
            </div>
            <button
              onClick={handleOpenCreateRoleModal}
              className="bg-blue-600 hover:bg-blue-700 active:scale-95 text-white px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-2 shadow-sm transition"
            >
              <span className="material-symbols-outlined text-base">add_moderator</span>
              Tạo vai trò mới
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {loadingData ? (
              <div className="col-span-full bg-white p-6 rounded-xl text-center text-slate-400 text-xs font-bold">
                Đang tải danh sách vai trò...
              </div>
            ) : (
              rolesList.map((role) => (
                <div key={role.id} className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm flex flex-col justify-between hover:shadow-md transition relative group">
                  <div>
                    <div className="flex items-start justify-between">
                      <div>
                        <span className="text-[10px] text-slate-400 uppercase tracking-wider font-bold">VAI TRÒ</span>
                        <h3 className="font-bold text-slate-900 text-base">{displayRoleName(role.name)}</h3>
                      </div>
                      <span className="text-[11px] bg-slate-100 text-slate-600 font-bold px-2 py-0.5 rounded-full border border-slate-200">
                        {role._count?.users || 0} user
                      </span>
                    </div>

                    {/* Action tags matrix */}
                    <div className="mt-4 flex flex-wrap gap-1.5">
                      {(role.actions || []).map((act) => (
                        <span key={act} className="text-[11px] rounded bg-slate-100 px-2 py-1 font-semibold text-slate-700 border border-slate-200/60">
                          {act}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Role Card Actions */}
                  <div className="mt-5 pt-3 border-t border-slate-100 flex items-center justify-between">
                    <button
                      onClick={() => handleOpenEditRoleModal(role)}
                      className="text-xs font-bold text-blue-600 hover:text-blue-800 flex items-center gap-1 transition"
                    >
                      <span className="material-symbols-outlined text-sm">edit</span> Chỉnh sửa quyền
                    </button>
                    {(!role._count?.users || role._count.users === 0) && !["Admin"].includes(role.name) && (
                      <button
                        onClick={() => handleDeleteRole(role)}
                        className="text-xs font-bold text-rose-500 hover:text-rose-700 flex items-center gap-1 transition"
                      >
                        <span className="material-symbols-outlined text-sm">delete</span> Xóa
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        {/* User Account Assignment Table */}
        <section className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          <div className="p-5 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h2 className="font-bold text-slate-900">Danh sách người dùng & Gán vai trò</h2>
              <p className="text-xs text-slate-500 mt-1">Phân vai trò động và giới hạn chi nhánh cho từng tài khoản</p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs bg-emerald-50 text-emerald-700 px-2.5 py-1 rounded-full font-bold border border-emerald-100">
                {usersList.length} tài khoản
              </span>
              <button
                onClick={handleOpenCreateUserModal}
                className="bg-blue-600 hover:bg-blue-700 active:scale-95 text-white px-3.5 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 shadow-sm transition"
              >
                <span className="material-symbols-outlined text-base">person_add</span>
                Tạo người dùng mới
              </button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs uppercase font-bold">
                <tr>
                  <th className="px-4 py-3">Người dùng (Họ & tên)</th>
                  <th className="px-4 py-3">Chức vụ & SĐT</th>
                  <th className="px-4 py-3">Vai trò phân công</th>
                  <th className="px-4 py-3">Phạm vi cửa hàng</th>
                  <th className="px-4 py-3 text-right">Thao tác cửa hàng</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loadingData ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                      Đang tải danh sách người dùng...
                    </td>
                  </tr>
                ) : (
                  usersList.map((dbUser) => {
                    const branches = dbUser.branchAccesses.map((branchAccess) => branchAccess.branchCode);
                    const branchesStr = branches.includes("ALL") ? "ALL" : branches.join(", ");
                    return (
                      <tr key={dbUser.id} className="hover:bg-slate-50 transition">
                        <td className="px-4 py-3">
                          <p className="font-bold text-slate-900">{dbUser.name}</p>
                          <p className="text-xs text-slate-500">{dbUser.email}</p>
                        </td>
                        <td className="px-4 py-3">
                          <p className="text-xs font-bold text-slate-800">{dbUser.position || "-"}</p>
                          <p className="text-xs text-slate-500">{dbUser.phone || "-"}</p>
                        </td>
                        <td className="px-4 py-3">
                          <select
                            value={dbUser.roleId || dbUser.role?.id || ""}
                            onChange={(e) => updateUserRole(dbUser.id, e.target.value)}
                            className="bg-white border border-slate-300 rounded px-2.5 py-1.5 text-xs font-semibold text-slate-800 outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 cursor-pointer"
                          >
                            <option value="">Chưa gán vai trò</option>
                            {rolesList.map((r) => (
                              <option key={r.id} value={r.id}>
                                {displayRoleName(r.name)}
                              </option>
                            ))}
                          </select>
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
                            className="bg-white border border-slate-300 rounded px-2 py-1 text-xs outline-none focus:border-blue-500 cursor-pointer text-slate-700 font-medium"
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

        {/* Menu Access Matrix Grid */}
        <section className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          <div className="p-5 border-b border-slate-200">
            <h2 className="font-bold text-slate-900">Ma trận truy cập Menu chức năng</h2>
            <p className="text-xs text-slate-500 mt-1">Tổng quan quyền mở các trang chức năng trên thanh Sidebar</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs uppercase font-bold">
                <tr>
                  <th className="px-4 py-3">Menu</th>
                  {rolesList.map((r) => (
                    <th key={r.id} className="px-4 py-3">
                      {displayRoleName(r.name)}
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
                    {rolesList.map((r) => {
                      const standardRoles = ["Admin", "Kế toán tổng hợp", "Kế toán công nợ", "Quản lý", "Viewer"];
                      const hasAccess = item.roles.includes(r.name as any) || (!standardRoles.includes(r.name) && (r.actions || []).includes("view"));
                      return (
                        <td key={r.id} className="px-4 py-3">
                          {hasAccess ? (
                            <span className="text-emerald-600 font-bold flex items-center gap-1">
                              <span className="material-symbols-outlined text-base">check_circle</span> Có
                            </span>
                          ) : (
                            <span className="text-slate-300">-</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>

      {/* Role Permission Matrix Modal */}
      {isRoleModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-xl overflow-hidden animate-in fade-in zoom-in duration-150">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-blue-50 text-blue-600">
                  <span className="material-symbols-outlined text-xl">admin_panel_settings</span>
                </div>
                <div>
                  <h3 className="font-bold text-slate-900 text-base">
                    {editingRole ? `Sửa vai trò: ${editingRole.name}` : "Tạo vai trò mới"}
                  </h3>
                  <p className="text-xs text-slate-500">Thiết lập ma trận quyền được phép thao tác</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsRoleModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg hover:bg-slate-100 transition"
              >
                <span className="material-symbols-outlined text-xl">close</span>
              </button>
            </div>

            <form onSubmit={handleSaveRole} className="p-6 space-y-5">
              {roleFormError && (
                <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 text-xs font-bold rounded-lg flex items-center gap-2">
                  <span className="material-symbols-outlined text-base">error</span>
                  {roleFormError}
                </div>
              )}

              <div className="space-y-1.5">
                <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                  Tên vai trò <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={roleForm.name}
                  onChange={(e) => setRoleForm({ ...roleForm, name: e.target.value })}
                  placeholder="Ví dụ: Kế toán kho, Thu ngân, Giám sát..."
                  className="w-full px-3.5 py-2.5 text-sm bg-white border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition font-semibold"
                />
              </div>

              {/* Actions Permission Matrix Grid */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                    Ma trận phân quyền (Hành động cấp phép)
                  </label>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleSelectAllActions}
                      className="text-[11px] font-bold text-blue-600 hover:underline"
                    >
                      Tích tất cả
                    </button>
                    <span className="text-slate-300">|</span>
                    <button
                      type="button"
                      onClick={handleDeselectAllActions}
                      className="text-[11px] font-bold text-slate-500 hover:underline"
                    >
                      Bỏ chọn
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-h-60 overflow-y-auto pr-1">
                  {ALL_APP_ACTIONS.map((action) => {
                    const isChecked = roleForm.actions.includes(action.key);
                    return (
                      <label
                        key={action.key}
                        onClick={() => handleToggleAction(action.key)}
                        className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer select-none transition ${
                          isChecked
                            ? "bg-blue-50/70 border-blue-200 text-blue-950 shadow-xs"
                            : "bg-slate-50/50 border-slate-200 text-slate-600 hover:bg-slate-100/60"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => {}} // Handled by label click
                          className="mt-0.5 rounded text-blue-600 focus:ring-blue-500"
                        />
                        <div>
                          <p className="text-xs font-bold flex items-center gap-1.5">
                            <span className="font-mono bg-white px-1.5 py-0.5 rounded border border-slate-200 text-[11px] text-slate-700">
                              {action.label}
                            </span>
                          </p>
                          <p className="text-[11px] text-slate-500 mt-0.5">{action.desc}</p>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="pt-3 border-t border-slate-100 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setIsRoleModalOpen(false)}
                  className="px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-100 rounded-xl transition"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={savingRole}
                  className="px-5 py-2 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 active:scale-95 rounded-xl shadow-md transition flex items-center gap-2 disabled:opacity-50"
                >
                  {savingRole && <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>}
                  {editingRole ? "Cập nhật vai trò" : "Tạo vai trò"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Create User Modal */}
      {isUserModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-lg overflow-hidden animate-in fade-in zoom-in duration-150">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-blue-50 text-blue-600">
                  <span className="material-symbols-outlined text-xl">person_add</span>
                </div>
                <div>
                  <h3 className="font-bold text-slate-900 text-base">Tạo người dùng mới</h3>
                  <p className="text-xs text-slate-500">Khai báo thông tin tài khoản & gán vai trò</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsUserModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg hover:bg-slate-100 transition"
              >
                <span className="material-symbols-outlined text-xl">close</span>
              </button>
            </div>

            <form onSubmit={handleSaveUser} className="p-6 space-y-4">
              {userFormError && (
                <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 text-xs font-bold rounded-lg flex items-center gap-2">
                  <span className="material-symbols-outlined text-base">error</span>
                  {userFormError}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                    User / Email đăng nhập <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="email"
                    required
                    value={userForm.email}
                    onChange={(e) => setUserForm({ ...userForm, email: e.target.value })}
                    placeholder="VD: namtv@fin-erp.vn"
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition font-semibold"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                    Mật khẩu <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="password"
                    required
                    value={userForm.password}
                    onChange={(e) => setUserForm({ ...userForm, password: e.target.value })}
                    placeholder="Nhập mật khẩu..."
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition font-semibold"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                  Họ và tên <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={userForm.name}
                  onChange={(e) => setUserForm({ ...userForm, name: e.target.value })}
                  placeholder="VD: Trần Văn Nam"
                  className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition font-semibold"
                />
                <p className="text-[10px] text-blue-600 italic">
                  * Tên này sẽ thể hiện trên Quản lý công việc để gán phân công công việc.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">Số điện thoại</label>
                  <input
                    type="text"
                    value={userForm.phone}
                    onChange={(e) => setUserForm({ ...userForm, phone: e.target.value })}
                    placeholder="VD: 0901234567"
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition font-semibold"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">Chức vụ</label>
                  <input
                    type="text"
                    value={userForm.position}
                    onChange={(e) => setUserForm({ ...userForm, position: e.target.value })}
                    placeholder="VD: Kế toán viên, Quản lý kho"
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition font-semibold"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                    Vai trò <span className="text-rose-500">*</span>
                  </label>
                  <select
                    required
                    value={userForm.roleId}
                    onChange={(e) => setUserForm({ ...userForm, roleId: e.target.value })}
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition font-semibold cursor-pointer"
                  >
                    <option value="">-- Chọn vai trò --</option>
                    {rolesList.map((r) => (
                      <option key={r.id} value={r.id}>
                        {displayRoleName(r.name)}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                    Phạm vi Cửa hàng <span className="text-rose-500">*</span>
                  </label>
                  <select
                    value={userForm.branchCode}
                    onChange={(e) => setUserForm({ ...userForm, branchCode: e.target.value })}
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition font-semibold cursor-pointer"
                  >
                    {branchScopeOptions.map((opt) => (
                      <option key={opt.code} value={opt.code}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="pt-3 border-t border-slate-100 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setIsUserModalOpen(false)}
                  className="px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-100 rounded-xl transition"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={savingUser}
                  className="px-5 py-2 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 active:scale-95 rounded-xl shadow-md transition flex items-center gap-2 disabled:opacity-50"
                >
                  {savingUser && <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>}
                  Tạo người dùng
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
