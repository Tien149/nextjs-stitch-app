"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { DateInput } from "@/components/DateInput";
import { appMenuItems, canAccessMenu, canPerformAction, type DemoSession, SESSION_KEY } from "@/lib/auth-demo";

type Voucher = {
  id: string;
  code: string;
  voucherType: string;
  voucherDate: string;
  partnerCode: string | null;
  partnerName: string;
  branchCode: string;
  moneySourceCode: string;
  categoryCode: string | null;
  amount: number;
  description: string;
  status: string;
};

const emptyForm = {
  voucherType: "RECEIPT",
  voucherDate: new Date().toISOString().slice(0, 10),
  partnerCode: "KH_ABC",
  partnerName: "Công ty TNHH ABC",
  branchCode: "HCM",
  moneySourceCode: "VCB_HCM",
  categoryCode: "REV_FOOD",
  amount: "50000000",
  description: "Thu tiền công nợ / thanh toán đối tác",
  status: "DRAFT",
};

export default function VouchersPage() {
  const router = useRouter();
  const [user, setUser] = useState<DemoSession | null>(null);
  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const raw = localStorage.getItem(SESSION_KEY);
    const menu = appMenuItems.find((item) => item.href === "/vouchers");
    if (!raw) {
      router.push("/login?next=/vouchers");
      return;
    }
    const session = JSON.parse(raw) as DemoSession;
    if (!menu || !canAccessMenu(session.role, menu)) {
      router.push("/");
      return;
    }
    window.setTimeout(() => {
      setUser(session);
      setLoading(false);
    }, 0);
  }, [router]);

  const canCreate = user ? canPerformAction(user.role, "create") : false;
  const canApprove = user ? canPerformAction(user.role, "approve") : false;
  const money = (value: number) => new Intl.NumberFormat("vi-VN").format(value);

  const loadVouchers = async () => {
    const response = await fetch("/api/vouchers");
    if (response.ok) setVouchers((await response.json()) as Voucher[]);
  };

  useEffect(() => {
    if (!loading) {
      window.setTimeout(() => {
        void loadVouchers();
      }, 0);
    }
  }, [loading]);

  const createVoucher = async (event: React.FormEvent) => {
    event.preventDefault();
    setMessage("");
    const response = await fetch("/api/vouchers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const payload = await response.json();
    if (!response.ok) {
      setMessage(payload.error || "Không tạo được chứng từ");
      return;
    }
    setForm(emptyForm);
    setMessage("Đã tạo chứng từ.");
    await loadVouchers();
  };

  const approveVoucher = async (id: string) => {
    const response = await fetch("/api/vouchers", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status: "APPROVED" }),
    });
    if (response.ok) await loadVouchers();
  };

  const cancelVoucher = async (id: string) => {
    const response = await fetch("/api/vouchers", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status: "CANCELLED" }),
    });
    const payload = await response.json();
    if (!response.ok) {
      setMessage(payload.error || "Không hủy được chứng từ");
      return;
    }
    setMessage("Đã hủy chứng từ.");
    await loadVouchers();
  };

  if (loading) return <div className="h-screen grid place-items-center bg-slate-100">Đang tải...</div>;

  return (
    <div className="min-h-screen bg-slate-100 text-slate-800">
      <header className="sticky top-0 z-20 bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <button onClick={() => router.push("/")} className="h-9 w-9 rounded-lg bg-slate-100 hover:bg-slate-200 flex items-center justify-center">
            <span className="material-symbols-outlined text-lg">arrow_back</span>
          </button>
          <div>
            <h1 className="text-xl font-bold">Phiếu Thu / Chi</h1>
            <p className="text-xs text-slate-500">GĐ2 - 6.3: lập chứng từ và mở bản in.</p>
          </div>
        </div>
        <p className="text-xs font-bold text-slate-500">{user?.role}</p>
      </header>

      <main className="max-w-7xl mx-auto p-6 grid xl:grid-cols-[400px_1fr] gap-6">
        {canCreate && (
          <form onSubmit={createVoucher} className="bg-white border border-slate-200 rounded-xl shadow-sm p-5 space-y-4 h-fit">
            <div>
              <p className="text-xs font-bold text-blue-600 uppercase">6.3 Receipt / Payment</p>
              <h2 className="font-bold text-lg mt-1">Tạo phiếu thu/chi</h2>
            </div>
            
            <label className="text-xs font-bold text-slate-600 block">
              Loại phiếu
              <select value={form.voucherType} onChange={(event) => setForm((value) => ({ ...value, voucherType: event.target.value }))} className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500">
                <option value="RECEIPT">Phiếu thu</option>
                <option value="PAYMENT">Phiếu chi</option>
              </select>
            </label>
            
            <label className="text-xs font-bold text-slate-600 block">
              Ngày chứng từ
              <DateInput value={form.voucherDate} onChange={(voucherDate) => setForm((value) => ({ ...value, voucherDate }))} className="mt-1" required ariaLabel="Ngày chứng từ" />
            </label>
            
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs font-bold text-slate-600 block">
                Mã đối tác
                <input
                  type="text"
                  value={form.partnerCode}
                  onChange={(event) => setForm((value) => ({ ...value, partnerCode: event.target.value }))}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                />
              </label>
              
              <label className="text-xs font-bold text-slate-600 block">
                Tên đối tác *
                <input
                  type="text"
                  value={form.partnerName}
                  onChange={(event) => setForm((value) => ({ ...value, partnerName: event.target.value }))}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  required
                />
              </label>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs font-bold text-slate-600 block">
                Chi nhánh *
                <select
                  value={form.branchCode}
                  onChange={(event) => setForm((value) => ({ ...value, branchCode: event.target.value }))}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  required
                >
                  <option value="HCM">Chi nhánh HCM</option>
                  <option value="HN">Chi nhánh Hà Nội</option>
                </select>
              </label>
              
              <label className="text-xs font-bold text-slate-600 block">
                Nguồn tiền *
                <select
                  value={form.moneySourceCode}
                  onChange={(event) => setForm((value) => ({ ...value, moneySourceCode: event.target.value }))}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  required
                >
                  <option value="CASH_HCM">Tiền mặt HCM</option>
                  <option value="CASH_HN">Tiền mặt HN</option>
                  <option value="VCB_HCM">Vietcombank HCM</option>
                  <option value="VCB_HN">Vietcombank HN</option>
                  <option value="MOMO_POS">Momo POS</option>
                </select>
              </label>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs font-bold text-slate-600 block">
                Nhóm thu/chi *
                <select
                  value={form.categoryCode}
                  onChange={(event) => setForm((value) => ({ ...value, categoryCode: event.target.value }))}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  required
                >
                  <option value="REV_FOOD">Doanh thu ẩm thực</option>
                  <option value="REV_OTHER">Doanh thu khác</option>
                  <option value="EXP_RENT">Chi phí thuê mặt bằng</option>
                  <option value="EXP_SALARY">Chi phí lương nhân viên</option>
                  <option value="EXP_MARKETING">Chi phí Marketing</option>
                  <option value="EXP_OTHER">Chi phí khác</option>
                </select>
              </label>

              <label className="text-xs font-bold text-slate-600 block">
                Số tiền (đ) *
                <input
                  type="number"
                  value={form.amount}
                  onChange={(event) => setForm((value) => ({ ...value, amount: event.target.value }))}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-bold focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  required
                />
              </label>
            </div>

            <label className="text-xs font-bold text-slate-600 block">
              Diễn giải *
              <textarea
                value={form.description}
                onChange={(event) => setForm((value) => ({ ...value, description: event.target.value }))}
                className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm h-20 resize-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                required
              />
            </label>

            {message && <p className="text-sm rounded-lg bg-blue-50 border border-blue-100 text-blue-700 px-3 py-2">{message}</p>}
            <button className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded-lg py-2.5 text-sm font-bold transition-colors">Tạo chứng từ</button>
          </form>
        )}

        <section className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          <div className="p-5 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h2 className="font-bold text-slate-800">Danh sách phiếu</h2>
              <p className="text-xs text-slate-500 mt-1">Dùng nút In để mở print view/PDF browser.</p>
            </div>
            <button onClick={loadVouchers} className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-bold hover:bg-slate-50">Tải lại</button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs uppercase border-b border-slate-200">
                <tr>
                  <th className="px-4 py-3 text-left">Chứng từ</th>
                  <th className="px-4 py-3 text-left">Đối tác</th>
                  <th className="px-4 py-3 text-right">Số tiền</th>
                  <th className="px-4 py-3 text-left">Trạng thái</th>
                  <th className="px-4 py-3 text-right">Thao tác</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {vouchers.length === 0 ? (
                  <tr><td colSpan={5} className="px-4 py-10 text-center text-slate-400">Chưa có chứng từ.</td></tr>
                ) : vouchers.map((voucher) => (
                  <tr key={voucher.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3"><b>{voucher.code}</b><p className="text-xs text-slate-500">{voucher.voucherType === "RECEIPT" ? "Phiếu thu" : "Phiếu chi"} · {new Date(voucher.voucherDate).toLocaleDateString("vi-VN")}</p></td>
                    <td className="px-4 py-3"><b>{voucher.partnerName}</b><p className="text-xs text-slate-500">{voucher.description}</p></td>
                    <td className="px-4 py-3 text-right font-bold">{money(voucher.amount)} đ</td>
                    <td className="px-4 py-3"><span className="text-xs font-bold bg-slate-100 rounded px-2 py-1">{voucher.status}</span></td>
                    <td className="px-4 py-3 text-right space-x-2">
                      {canApprove && voucher.status === "DRAFT" && <button onClick={() => approveVoucher(voucher.id)} className="text-xs font-bold text-emerald-700 hover:underline">Duyệt</button>}
                      {canApprove && voucher.status === "DRAFT" && <button onClick={() => cancelVoucher(voucher.id)} className="text-xs font-bold text-rose-700 hover:underline">Hủy</button>}
                      <button onClick={() => window.open(`/vouchers/${voucher.id}/print`, "_blank")} className="text-xs font-bold text-blue-700 hover:underline">In</button>
                    </td>
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
