"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { DateInput } from "@/components/DateInput";
import { displayRoleName, storeLabel, storeOptions } from "@/lib/branch-labels";
import { appMenuItems, canAccessMenu, canPerformAction, type DemoSession, SESSION_KEY } from "@/lib/auth-demo";

type Asset = {
  id: string;
  code: string;
  name: string;
  branchCode: string;
  assetGroup: string;
  imageUrl: string | null;
  location: string | null;
  quantity: number;
  purchaseDate: string;
  originalCost: number;
  currentValue: number;
  supplierName: string | null;
  sourcePurchaseOrderId: string | null;
  sourceReceiptId: string | null;
  status: string;
  note: string | null;
};

const emptyForm = {
  name: "Máy pha cà phê Espresso",
  branchCode: "HCM",
  assetGroup: "EQUIPMENT",
  imageUrl: "",
  location: "Kho chính",
  quantity: "1",
  purchaseDate: new Date().toISOString().slice(0, 10),
  originalCost: "85000000",
  supplierName: "NCC Thiết bị F&B",
  note: "Thiết bị chính của cửa hàng",
};

export default function AssetsPage() {
  const router = useRouter();
  const [user, setUser] = useState<DemoSession | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const raw = localStorage.getItem(SESSION_KEY);
    const menu = appMenuItems.find((item) => item.href === "/assets");
    if (!raw) {
      router.push("/login?next=/assets");
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
  const money = (value: number) => new Intl.NumberFormat("vi-VN").format(value);

  const loadAssets = async () => {
    const response = await fetch("/api/assets");
    if (response.ok) setAssets((await response.json()) as Asset[]);
  };

  useEffect(() => {
    if (!loading) {
      window.setTimeout(() => {
        void loadAssets();
      }, 0);
    }
  }, [loading]);

  const createAsset = async (event: React.FormEvent) => {
    event.preventDefault();
    setMessage("");
    const response = await fetch("/api/assets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const payload = await response.json();
    if (!response.ok) {
      setMessage(payload.error || "Không tạo được tài sản");
      return;
    }
    setMessage("Đã tạo hồ sơ tài sản.");
    setForm(emptyForm);
    await loadAssets();
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
            <h1 className="text-xl font-bold">Hồ sơ Tài sản</h1>
            <p className="text-xs text-slate-500">GĐ2 - 4.1: quản lý tài sản, nguyên giá, giá trị còn lại và trạng thái.</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => router.push("/assets/operations")} className="rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 text-sm font-bold inline-flex items-center gap-2 transition-colors">
            <span className="material-symbols-outlined text-lg">settings_suggest</span>
            Vận hành tài sản
          </button>
          <p className="hidden sm:block text-xs font-bold text-slate-500">{displayRoleName(user?.role)}</p>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6 grid xl:grid-cols-[380px_1fr] gap-6">
        {canCreate && (
          <form onSubmit={createAsset} className="bg-white border border-slate-200 rounded-xl shadow-sm p-5 space-y-4 h-fit">
            <div>
              <p className="text-xs font-bold text-blue-600 uppercase">4.1 Asset master</p>
              <h2 className="font-bold text-lg mt-1">Tạo hồ sơ tài sản</h2>
            </div>
            
            <label className="text-xs font-bold text-slate-600 block">
              Tên tài sản *
              <input
                type="text"
                value={form.name}
                onChange={(event) => setForm((value) => ({ ...value, name: event.target.value }))}
                className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                required
              />
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs font-bold text-slate-600 block">
                Cửa hàng *
                <select
                  value={form.branchCode}
                  onChange={(event) => setForm((value) => ({ ...value, branchCode: event.target.value }))}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  required
                >
                  {storeOptions.map((option) => (
                    <option key={option.code} value={option.code}>
                      {storeLabel(option.code)}
                    </option>
                  ))}
                </select>
              </label>

              <label className="text-xs font-bold text-slate-600 block">
                Nhóm tài sản *
                <select
                  value={form.assetGroup}
                  onChange={(event) => setForm((value) => ({ ...value, assetGroup: event.target.value }))}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  required
                >
                  <option value="EQUIPMENT">Máy móc thiết bị</option>
                  <option value="FURNITURE">Nội thất, decor</option>
                  <option value="VEHICLE">Phương tiện vận chuyển</option>
                  <option value="OTHER">Tài sản khác</option>
                </select>
              </label>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs font-bold text-slate-600 block">
                Ngày mua *
                <DateInput value={form.purchaseDate} onChange={(purchaseDate) => setForm((value) => ({ ...value, purchaseDate }))} className="mt-1" required ariaLabel="Ngày mua tài sản" />
              </label>

              <label className="text-xs font-bold text-slate-600 block">
                Nguyên giá (đ) *
                <input
                  type="number"
                  value={form.originalCost}
                  onChange={(event) => setForm((value) => ({ ...value, originalCost: event.target.value }))}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-bold focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  required
                />
              </label>
            </div>

            <label className="text-xs font-bold text-slate-600 block">
              URL hình ảnh
              <input
                type="text"
                value={form.imageUrl}
                onChange={(event) => setForm((value) => ({ ...value, imageUrl: event.target.value }))}
                className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                placeholder="https://... hoặc mã ảnh nội bộ"
              />
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs font-bold text-slate-600 block">
                Vị trí
                <input
                  type="text"
                  value={form.location}
                  onChange={(event) => setForm((value) => ({ ...value, location: event.target.value }))}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                />
              </label>
              <label className="text-xs font-bold text-slate-600 block">
                Số lượng
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={form.quantity}
                  onChange={(event) => setForm((value) => ({ ...value, quantity: event.target.value }))}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                />
              </label>
            </div>

            <label className="text-xs font-bold text-slate-600 block">
              Nhà cung cấp
              <input
                type="text"
                value={form.supplierName}
                onChange={(event) => setForm((value) => ({ ...value, supplierName: event.target.value }))}
                className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
            </label>

            <label className="text-xs font-bold text-slate-600 block">
              Ghi chú
              <textarea
                value={form.note}
                onChange={(event) => setForm((value) => ({ ...value, note: event.target.value }))}
                className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm h-20 resize-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
            </label>
            
            {message && <p className="text-sm rounded-lg bg-blue-50 border border-blue-100 text-blue-700 px-3 py-2">{message}</p>}
            <button className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded-lg py-2.5 text-sm font-bold transition-colors">Tạo tài sản</button>
          </form>
        )}

        <section className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          <div className="p-5 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h2 className="font-bold text-slate-800">Danh sách tài sản</h2>
              <p className="text-xs text-slate-500 mt-1">Khấu hao, bảo trì và báo hỏng nằm trong Vận hành tài sản.</p>
            </div>
            <button onClick={loadAssets} className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-bold hover:bg-slate-50">Tải lại</button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs uppercase border-b border-slate-200">
                <tr>
                  <th className="px-4 py-3 text-left">Tài sản</th>
                  <th className="px-4 py-3 text-left">Cửa hàng/Vị trí</th>
                  <th className="px-4 py-3 text-right">Nguyên giá</th>
                  <th className="px-4 py-3 text-right">Giá trị còn lại</th>
                  <th className="px-4 py-3 text-left">Trạng thái</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {assets.length === 0 ? (
                  <tr><td colSpan={5} className="px-4 py-10 text-center text-slate-400">Chưa có tài sản.</td></tr>
                ) : assets.map((asset) => (
                  <tr key={asset.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="grid h-10 w-10 place-items-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
                          {asset.imageUrl ? <span className="material-symbols-outlined text-blue-600">image</span> : <span className="material-symbols-outlined text-slate-400">precision_manufacturing</span>}
                        </div>
                        <div>
                          <b>{asset.code} - {asset.name}</b>
                          <p className="text-xs text-slate-500">{asset.assetGroup} · SL {asset.quantity} · {asset.supplierName || "-"}</p>
                          {(asset.sourcePurchaseOrderId || asset.sourceReceiptId) && <p className="text-[11px] font-bold text-blue-600">Tạo từ PO/Nhập hàng</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">{storeLabel(asset.branchCode)}<p className="text-xs text-slate-500">{asset.location || "-"}</p></td>
                    <td className="px-4 py-3 text-right font-semibold">{money(asset.originalCost)} đ</td>
                    <td className="px-4 py-3 text-right font-semibold text-indigo-950">{money(asset.currentValue)} đ</td>
                    <td className="px-4 py-3"><span className="text-xs font-bold bg-slate-100 rounded px-2 py-1">{asset.status}</span></td>
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
