"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createDemoSession, demoUsers, findDemoUser, SESSION_KEY } from "@/lib/auth-demo";

export default function Login() {
  const router = useRouter();
  const [userId, setUserId] = useState("admin");
  const [password, setPassword] = useState("123456");
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    setLoading(true);

    window.setTimeout(() => {
      const user = findDemoUser(userId);
      if (!user || user.password !== password) {
        setError("Sai tài khoản hoặc mật khẩu. Mật khẩu demo là: 123456");
        setLoading(false);
        return;
      }

      const session = createDemoSession(user);
      const sessionValue = JSON.stringify(session);
      localStorage.setItem(SESSION_KEY, sessionValue);
      document.cookie = `${SESSION_KEY}=${encodeURIComponent(sessionValue)}; path=/; max-age=${
        rememberMe ? 86400 * 7 : 3600
      }`;

      const next = new URLSearchParams(window.location.search).get("next");
      router.push(next || "/");
    }, 350);
  };

  return (
    <main className="min-h-screen grid bg-slate-100 text-slate-800 lg:grid-cols-[480px_1fr]">
      <section className="bg-slate-950 text-white p-8 lg:p-10 flex flex-col justify-between">
        <div>
          <div className="flex items-center gap-3">
            <div className="bg-blue-600 text-white p-3 rounded-lg">
              <span className="material-symbols-outlined text-3xl">account_balance</span>
            </div>
            <div>
              <p className="text-xl font-bold tracking-wide">FIN-ERP SYSTEM</p>
              <p className="text-sm text-slate-400">Giai đoạn 1 - Auth & phân quyền</p>
            </div>
          </div>

          <div className="mt-14 space-y-5">
            <div className="border-l-4 border-blue-500 pl-4">
              <p className="text-sm text-slate-400">Mục tiêu test</p>
              <h1 className="text-3xl font-bold mt-1">
                Đăng nhập theo vai trò và kiểm tra menu quyền hạn
              </h1>
            </div>
            <p className="text-slate-300 leading-7">
              Đây là bản demo client-side để test nhanh trước khi nối backend thật. Mỗi tài khoản
              có quyền truy cập menu khác nhau theo plan Giai đoạn 1.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 text-xs text-slate-300 mt-10">
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-3">
            <b className="text-white">Admin</b>
            <br />
            Toàn quyền hệ thống
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-3">
            <b className="text-white">Kế toán</b>
            <br />
            Danh mục, cọc, số dư
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-3">
            <b className="text-white">Công nợ</b>
            <br />
            Tiền cọc và công nợ
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-3">
            <b className="text-white">Viewer</b>
            <br />
            Chỉ xem báo cáo
          </div>
        </div>
      </section>

      <section className="p-6 lg:p-10 flex items-center justify-center">
        <div className="w-full max-w-xl bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          <div className="p-6 border-b border-slate-200">
            <p className="text-sm text-blue-600 font-bold uppercase">Đăng nhập demo</p>
            <h2 className="text-2xl font-bold mt-1">Chọn tài khoản để test quyền</h2>
            <p className="text-sm text-slate-500 mt-2">
              Mật khẩu chung cho tất cả tài khoản demo: <b>123456</b>
            </p>
          </div>

          <form onSubmit={handleLogin} className="p-6 space-y-5">
            <div>
              <label className="text-sm font-bold text-slate-700">Tài khoản</label>
              <select
                value={userId}
                onChange={(event) => setUserId(event.target.value)}
                className="w-full mt-2 border border-slate-300 rounded-lg px-3 py-3 text-sm outline-none focus:ring-2 focus:ring-blue-500"
              >
                {demoUsers.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name} - {user.role}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-sm font-bold text-slate-700">Mật khẩu</label>
              <div className="relative mt-2">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="w-full border border-slate-300 rounded-lg px-3 py-3 pr-11 text-sm outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((value) => !value)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
                >
                  <span className="material-symbols-outlined text-xl">
                    {showPassword ? "visibility_off" : "visibility"}
                  </span>
                </button>
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(event) => setRememberMe(event.target.checked)}
                className="w-4 h-4 rounded border-slate-300 text-blue-600"
              />
              Ghi nhớ đăng nhập trong 7 ngày
            </label>

            {error && (
              <p className="text-sm bg-rose-50 border border-rose-200 text-rose-700 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <button
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white rounded-lg py-3 font-bold flex items-center justify-center gap-2"
            >
              <span className="material-symbols-outlined text-xl">login</span>
              {loading ? "Đang đăng nhập..." : "Đăng nhập"}
            </button>
          </form>

          <div className="bg-slate-50 border-t border-slate-200 p-5">
            <p className="text-xs font-bold text-slate-500 uppercase mb-3">Gợi ý test nhanh</p>
            <div className="grid sm:grid-cols-2 gap-2 text-xs">
              <div className="rounded-lg border border-slate-200 bg-white p-3">
                Admin thấy menu <b>Phân quyền & Người dùng</b>.
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-3">
                Viewer chỉ thấy nhóm báo cáo được phép xem.
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
