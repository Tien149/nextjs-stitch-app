"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { displayRoleName } from "@/lib/branch-labels";
import { demoUsers, SESSION_KEY } from "@/lib/auth-demo";

export default function Login() {
  const router = useRouter();
  const [userId, setUserId] = useState("admin");
  const [password, setPassword] = useState("123456");
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: userId, password }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Sai tài khoản hoặc mật khẩu. Mật khẩu mặc định là: 123456");
      }

      const session = await response.json();
      const sessionValue = JSON.stringify(session);
      localStorage.setItem(SESSION_KEY, sessionValue);
      document.cookie = `${SESSION_KEY}=${encodeURIComponent(sessionValue)}; path=/; max-age=${
        rememberMe ? 86400 * 7 : 3600
      }; SameSite=Lax`;

      const next = new URLSearchParams(window.location.search).get("next");
      router.push(next || "/");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Có lỗi xảy ra");
      setLoading(false);
    }
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
              <p className="text-xl font-bold tracking-wide">FIN ERP</p>
              <p className="text-sm text-slate-400">Tài chính, POS và công nợ</p>
            </div>
          </div>

          <div className="mt-14 space-y-5">
            <div className="border-l-4 border-blue-500 pl-4">
              <p className="text-sm text-slate-400">Môi trường demo</p>
              <h1 className="text-3xl font-bold mt-1">
                Quản trị doanh thu, tiền cọc, số dư và import dữ liệu
              </h1>
            </div>
            <p className="text-slate-300 leading-7">
              Dùng để test nhanh các vai trò trong chuỗi vận hành: admin,
              kế toán tổng hợp, kế toán công nợ, chủ cửa hàng và viewer chỉ xem.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 text-xs text-slate-300 mt-10">
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-3">
            <b className="text-white">Admin</b>
            <br />
            Cấu hình toàn bộ hệ thống
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-3">
            <b className="text-white">Kế toán</b>
            <br />
            Danh mục, số dư, import POS
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-3">
            <b className="text-white">Công nợ</b>
            <br />
            Tiền cọc, đối tác, sao kê
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-3">
            <b className="text-white">Chủ cửa hàng</b>
            <br />
            Xem tình hình vận hành
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
                    {user.name} - {displayRoleName(user.role)}
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
                Admin cấu hình danh mục, kho, nguồn tiền và quy tắc mã.
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-3">
                Kế toán tổng hợp import doanh thu POS và sao kê ngân hàng.
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
