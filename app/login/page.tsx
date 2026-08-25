"use client";

import { useState } from "react";
import { AppBrand } from "@/components/AppBrand";
import { getDefaultRouteForRole, SESSION_KEY } from "@/lib/auth-demo";

const highlights = [
  {
    icon: "point_of_sale",
    title: "Doanh thu & POS",
    desc: "Import doanh thu, đối soát sao kê ngân hàng theo từng cửa hàng.",
  },
  {
    icon: "handshake",
    title: "Công nợ & Tiền cọc",
    desc: "Theo dõi công nợ đối tác, tiền cọc và tiến độ cấn trừ.",
  },
  {
    icon: "inventory_2",
    title: "Kho & Định lượng",
    desc: "Quản lý tồn kho, công thức định lượng và giá vốn bình quân.",
  },
  {
    icon: "monitoring",
    title: "Báo cáo & BI",
    desc: "P&L đa chiều, dòng tiền, ngân sách và bảng cân đối.",
  },
];

export default function Login() {
  const [userId, setUserId] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");

    // Đọc trực tiếp từ DOM qua FormData để bắt được cả giá trị do trình duyệt
    // tự điền (autofill) — trường hợp autofill gán value nhưng không kích hoạt
    // onChange nên React state có thể vẫn rỗng, gây lỗi "Thiếu email/mật khẩu".
    const formData = new FormData(event.currentTarget);
    const emailValue = String(formData.get("username") ?? userId).trim();
    const passwordValue = String(formData.get("password") ?? password).trim();

    if (!emailValue || !passwordValue) {
      setError("Vui lòng nhập đầy đủ email/tên đăng nhập và mật khẩu.");
      return;
    }

    // Đồng bộ lại state phòng khi giá trị đến từ autofill.
    setUserId(emailValue);
    setPassword(passwordValue);
    setLoading(true);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailValue, password: passwordValue, rememberMe }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Tài khoản hoặc mật khẩu không đúng.");
      }

      const session = await response.json();
      const sessionValue = JSON.stringify(session);
      localStorage.setItem(SESSION_KEY, sessionValue);

      // Đồng bộ chi nhánh mặc định theo phạm vi được cấp cho tài khoản
      if (session.allowedBranches?.includes("ALL")) {
        localStorage.setItem("global_branch_code", "ALL");
      } else if (session.allowedBranches?.length > 0) {
        localStorage.setItem("global_branch_code", session.allowedBranches[0]);
      } else {
        localStorage.setItem("global_branch_code", "ALL");
      }

      // Cookie phiên do /api/auth/login phát hành (httpOnly), client không tự ghi nữa.

      const next = new URLSearchParams(window.location.search).get("next");
      // Truyền cả phiên: vai trò tuỳ chỉnh không được mở Dashboard thì phải vào thẳng màn đầu
      // tiên của họ, chứ trả "/" là rơi vào bảng điều hành trắng trơn rồi đứng luôn ở đó.
      const defaultRoute = getDefaultRouteForRole(session);
      const targetRoute = next && (next !== "/" || defaultRoute === "/") ? next : defaultRoute;
      window.location.href = targetRoute;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không thể đăng nhập. Vui lòng thử lại.");
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen grid grid-rows-[auto_1fr] bg-slate-100 text-slate-800 lg:grid-rows-[1fr] lg:grid-cols-[minmax(0,520px)_1fr]">
      <section className="relative overflow-hidden bg-slate-950 text-white p-8 lg:p-10 flex flex-col justify-between">
        <div className="pointer-events-none absolute -top-32 -left-24 h-80 w-80 rounded-full bg-blue-600/20 blur-3xl" />
        <div className="pointer-events-none absolute bottom-0 right-0 h-72 w-72 translate-x-1/3 translate-y-1/3 rounded-full bg-indigo-500/10 blur-3xl" />

        <div className="relative">
          <AppBrand />

          <div className="mt-6 lg:mt-10 max-w-md">
            <h1 className="text-2xl lg:text-4xl font-bold leading-tight">
              Nền tảng quản trị tài chính &amp; vận hành chuỗi
            </h1>
            <p className="hidden lg:block text-slate-300 leading-7 mt-4">
              Hợp nhất doanh thu, chi phí, công nợ, kho và tài sản trên một hệ thống duy nhất — số liệu
              được kiểm soát theo từng cửa hàng và từng kỳ kế toán.
            </p>
          </div>
        </div>

        <div className="relative hidden lg:grid sm:grid-cols-2 gap-3 mt-8">
          {highlights.map((item) => (
            <div key={item.title} className="rounded-xl border border-white/10 bg-white/5 p-4">
              <span className="material-symbols-outlined text-blue-300 text-[22px]">{item.icon}</span>
              <p className="font-bold text-sm mt-2">{item.title}</p>
              <p className="text-xs text-slate-400 leading-5 mt-1">{item.desc}</p>
            </div>
          ))}
        </div>

        <p className="relative hidden lg:block text-xs text-slate-500 mt-6">
          Hệ thống nội bộ. Mọi truy cập đều được ghi nhận trong nhật ký hệ thống.
        </p>
      </section>

      <section className="p-6 lg:p-10 flex items-center justify-center">
        <div className="w-full max-w-md">
          <div className="mb-8">
            <h2 className="text-2xl font-bold text-slate-900">Đăng nhập</h2>
            <p className="text-sm text-slate-500 mt-1.5">
              Sử dụng tài khoản được cấp để truy cập hệ thống.
            </p>
          </div>

          <form onSubmit={handleLogin} className="space-y-5">
            <div>
              <label htmlFor="login-user" className="text-sm font-bold text-slate-700">
                Email hoặc Tên đăng nhập
              </label>
              <input
                id="login-user"
                name="username"
                type="text"
                value={userId}
                onChange={(event) => setUserId(event.target.value)}
                autoComplete="username"
                className="w-full mt-2 border border-slate-300 rounded-lg px-3 py-3 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 font-semibold"
                placeholder="Nhập email hoặc tên đăng nhập"
                required
              />
            </div>

            <div>
              <label htmlFor="login-password" className="text-sm font-bold text-slate-700">
                Mật khẩu
              </label>
              <div className="relative mt-2">
                <input
                  id="login-password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  className="w-full border border-slate-300 rounded-lg px-3 py-3 pr-11 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 font-semibold"
                  placeholder="Nhập mật khẩu"
                  required
                />
                <button
                  type="button"
                  title={showPassword ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
                  onClick={() => setShowPassword((value) => !value)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 p-1 flex items-center justify-center"
                >
                  <span className="material-symbols-outlined text-xl pointer-events-none">
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
              <p className="text-sm bg-rose-50 border border-rose-200 text-rose-700 rounded-lg px-3 py-2.5 flex items-start gap-2">
                <span className="material-symbols-outlined text-lg shrink-0">error</span>
                {error}
              </p>
            )}

            <button
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white rounded-lg py-3 font-bold flex items-center justify-center gap-2 transition-colors"
            >
              <span className="material-symbols-outlined text-xl">login</span>
              {loading ? "Đang đăng nhập..." : "Đăng nhập"}
            </button>
          </form>

          <p className="text-xs text-slate-500 mt-6 text-center">
            Quên mật khẩu hoặc cần cấp tài khoản? Vui lòng liên hệ quản trị viên hệ thống.
          </p>
        </div>
      </section>
    </main>
  );
}
