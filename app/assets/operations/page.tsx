"use client";

import { useEffect, useState } from "react";
import { ModuleFrame, ModuleTabs } from "@/components/ModuleFrame";
import { DateInput, MonthInput } from "@/components/DateInput";
import { canPerformMenuAction } from "@/lib/auth-demo";
import { useModuleAuth } from "@/lib/use-module-auth";

type Asset = { id: string; code: string; name: string; branchCode: string; originalCost: number; currentValue: number; residualValue: number; usefulLifeMonths: number | null; depreciationStartDate: string | null };
type Depreciation = { id: string; period: string; depreciationAmount: number; accumulatedDepreciation: number; remainingValue: number; asset: Asset };
type Maintenance = { id: string; maintenanceType: string; scheduledDate: string; completedDate: string | null; supplierName: string | null; cost: number; status: string; asset: Asset };
type Damage = { id: string; code: string; severity: string; description: string; status: string; repairCost: number; repairTreatment: string | null; asset: Asset };
type Data = { assets: Asset[]; depreciations: Depreciation[]; maintenances: Maintenance[]; damageReports: Damage[] };
const money = (value: number) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(value);

export default function AssetOperationsPage() {
  const href = "/assets";
  const { user, loading } = useModuleAuth(href);
  const [active, setActive] = useState("depreciation");
  const [data, setData] = useState<Data>({ assets: [], depreciations: [], maintenances: [], damageReports: [] });
  const [message, setMessage] = useState("");
  const [assetId, setAssetId] = useState("");
  const [config, setConfig] = useState({ usefulLifeMonths: "60", depreciationStartDate: new Date().toISOString().slice(0, 10), residualValue: "0" });
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [maintenance, setMaintenance] = useState({ maintenanceType: "Bảo trì định kỳ", scheduledDate: new Date().toISOString().slice(0, 10), supplierName: "", cost: "0", note: "" });
  const [damage, setDamage] = useState({ severity: "MEDIUM", description: "", note: "" });
  const canCreate = user ? canPerformMenuAction(user.role, href, "create") : false;
  const canEdit = user ? canPerformMenuAction(user.role, href, "edit") : false;

  const loadData = async () => {
    const response = await fetch("/api/assets/operations");
    if (!response.ok) return;
    const payload = await response.json() as Data;
    setData(payload);
    setAssetId((value) => value || payload.assets[0]?.id || "");
  };
  useEffect(() => { if (!loading) window.setTimeout(() => void loadData(), 0); }, [loading]);

  const send = async (body: object, success: string) => {
    const response = await fetch("/api/assets/operations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json();
    setMessage(response.ok ? success : payload.error || "Không thực hiện được thao tác");
    if (response.ok) await loadData();
  };

  if (loading) return <div className="h-screen grid place-items-center bg-slate-100">Đang tải...</div>;
  return <ModuleFrame title="Vận hành tài sản" subtitle="GĐ3 - khấu hao, bảo trì, hư hỏng và sửa chữa" role={user?.role}>
    <ModuleTabs active={active} onChange={setActive} tabs={[{ id: "depreciation", label: "Khấu hao", icon: "trending_down" }, { id: "maintenance", label: "Bảo trì", icon: "build" }, { id: "damage", label: "Báo hỏng", icon: "report_problem" }]} />
    {message && <p className="mb-4 px-4 py-3 rounded-lg border border-blue-100 bg-blue-50 text-sm text-blue-700">{message}</p>}
    {data.assets.length === 0 && <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-4 text-sm">Cần tạo hồ sơ tài sản ở màn hình Tài sản trước khi chạy nghiệp vụ.</div>}

    {active === "depreciation" && <div className="space-y-5"><div className="grid lg:grid-cols-2 gap-5">{canEdit && <form onSubmit={(e) => { e.preventDefault(); void send({ action: "CONFIGURE_DEPRECIATION", assetId, ...config }, "Đã cập nhật cấu hình khấu hao."); }} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4"><h2 className="font-bold">Cấu hình tài sản</h2><AssetSelect assets={data.assets} value={assetId} onChange={setAssetId} /><div className="grid grid-cols-3 gap-3"><Field label="Số tháng"><input type="number" className="control" value={config.usefulLifeMonths} onChange={(e) => setConfig({ ...config, usefulLifeMonths: e.target.value })} /></Field><Field label="Bắt đầu"><DateInput className="mt-1.5" value={config.depreciationStartDate} onChange={(depreciationStartDate) => setConfig({ ...config, depreciationStartDate })} ariaLabel="Ngày bắt đầu khấu hao" /></Field><Field label="Giá trị còn lại"><input type="number" className="control" value={config.residualValue} onChange={(e) => setConfig({ ...config, residualValue: e.target.value })} /></Field></div><button className="secondary-button w-full">Lưu cấu hình</button></form>}{canEdit && <form onSubmit={(e) => { e.preventDefault(); void send({ action: "RUN_DEPRERED", period, branchCode: "ALL" }, "Đã chạy khấu hao cho các tài sản hợp lệ."); }} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 h-fit"><h2 className="font-bold">Chạy khấu hao tháng</h2><Field label="Kỳ kế toán"><MonthInput className="mt-1.5" value={period} onChange={setPeriod} ariaLabel="Kỳ khấu hao" /></Field><p className="text-xs text-slate-500">Hệ thống bỏ qua tài sản đã chạy trong kỳ và không khấu hao thấp hơn giá trị còn lại.</p><button className="primary-button w-full"><span className="material-symbols-outlined text-lg">play_arrow</span>Chạy khấu hao</button></form>}</div><section className="table-panel"><Panel title="Lịch sử khấu hao" reload={loadData} /><Table headers={[{ label: "Kỳ" }, { label: "Tài sản" }, { label: "Khấu hao tháng", align: "right" }, { label: "Lũy kế", align: "right" }, { label: "Giá trị còn lại", align: "right" }]}>{data.depreciations.map((row) => <tr key={row.id} className="border-t border-slate-100"><Cell>{row.period}</Cell><Cell><b>{row.asset.code} - {row.asset.name}</b></Cell><Cell right>{money(row.depreciationAmount)} đ</Cell><Cell right>{money(row.accumulatedDepreciation)} đ</Cell><Cell right><b>{money(row.remainingValue)} đ</b></Cell></tr>)}</Table></section></div>}

    {active === "maintenance" && <div className="grid lg:grid-cols-[380px_1fr] gap-5">{canCreate && <form onSubmit={(e) => { e.preventDefault(); void send({ action: "SCHEDULE_MAINTENANCE", assetId, ...maintenance }, "Đã tạo lịch bảo trì."); }} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 h-fit"><h2 className="font-bold">Lập lịch bảo trì</h2><AssetSelect assets={data.assets} value={assetId} onChange={setAssetId} /><Field label="Nội dung"><input className="control" value={maintenance.maintenanceType} onChange={(e) => setMaintenance({ ...maintenance, maintenanceType: e.target.value })} /></Field><Field label="Ngày dự kiến"><DateInput className="mt-1.5" value={maintenance.scheduledDate} onChange={(scheduledDate) => setMaintenance({ ...maintenance, scheduledDate })} ariaLabel="Ngày bảo trì dự kiến" /></Field><Field label="Nhà cung cấp"><input className="control" value={maintenance.supplierName} onChange={(e) => setMaintenance({ ...maintenance, supplierName: e.target.value })} /></Field><button className="primary-button w-full">Tạo lịch</button></form>}<section className="table-panel"><Panel title="Lịch bảo trì" reload={loadData} /><Table headers={[{ label: "Tài sản" }, { label: "Nội dung" }, { label: "Ngày dự kiến" }, { label: "Chi phí", align: "right" }, { label: "Trạng thái" }, { label: "Thao tác", align: "right" }]}>{data.maintenances.map((row) => <tr key={row.id} className="border-t border-slate-100"><Cell><b>{row.asset.code}</b><small>{row.asset.name}</small></Cell><Cell>{row.maintenanceType}</Cell><Cell>{new Date(row.scheduledDate).toLocaleDateString("vi-VN")}</Cell><Cell right>{money(row.cost)} đ</Cell><Cell><span className="status bg-slate-100">{row.status}</span></Cell><Cell right>{canEdit && row.status === "SCHEDULED" && <button className="action-link text-emerald-700" onClick={() => void send({ action: "COMPLETE_MAINTENANCE", id: row.id, completedDate: new Date().toISOString(), cost: row.cost }, "Đã hoàn thành bảo trì.")}>Hoàn thành</button>}</Cell></tr>)}</Table></section></div>}

    {active === "damage" && <div className="grid lg:grid-cols-[380px_1fr] gap-5">{canCreate && <form onSubmit={(e) => { e.preventDefault(); void send({ action: "REPORT_DAMAGE", assetId, ...damage }, "Đã gửi báo hỏng."); }} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 h-fit"><h2 className="font-bold">Báo cáo hư hỏng</h2><AssetSelect assets={data.assets} value={assetId} onChange={setAssetId} /><Field label="Mức độ"><select className="control" value={damage.severity} onChange={(e) => setDamage({ ...damage, severity: e.target.value })}><option value="LOW">Thấp</option><option value="MEDIUM">Trung bình</option><option value="HIGH">Nghiêm trọng</option></select></Field><Field label="Mô tả"><textarea className="control h-24 resize-none" value={damage.description} onChange={(e) => setDamage({ ...damage, description: e.target.value })} required /></Field><button className="primary-button w-full">Gửi báo hỏng</button></form>}<section className="table-panel"><Panel title="Phiếu báo hỏng" reload={loadData} /><Table headers={[{ label: "Phiếu" }, { label: "Tài sản" }, { label: "Mức độ" }, { label: "Mô tả" }, { label: "Xử lý" }, { label: "Thao tác", align: "right" }]}>{data.damageReports.map((row) => <tr key={row.id} className="border-t border-slate-100"><Cell><b>{row.code}</b><small>{row.status}</small></Cell><Cell>{row.asset.code} - {row.asset.name}</Cell><Cell><span className="status bg-amber-50 text-amber-700">{row.severity}</span></Cell><Cell>{row.description}</Cell><Cell>{row.repairTreatment || "-"}<small>{row.repairCost ? `${money(row.repairCost)} đ` : ""}</small></Cell><Cell right>{canEdit && row.status !== "COMPLETED" && <button className="action-link text-blue-700" onClick={() => { const input = window.prompt("Chi phí sửa chữa", "1000000"); if (input) void send({ action: "RESOLVE_DAMAGE", id: row.id, repairCost: input, repairTreatment: "EXPENSE", resolvedAt: new Date().toISOString() }, "Đã hoàn tất xử lý, ghi nhận vào chi phí kỳ."); }}>Xử lý</button>}</Cell></tr>)}</Table></section></div>}
  </ModuleFrame>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block text-xs font-bold text-slate-600">{label}{children}</label>; }
function AssetSelect({ assets, value, onChange }: { assets: Asset[]; value: string; onChange: (value: string) => void }) { return <Field label="Tài sản"><select className="control" value={value} onChange={(e) => onChange(e.target.value)}><option value="">Chọn tài sản</option>{assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.code} - {asset.name}</option>)}</select></Field>; }
function Panel({ title, reload }: { title: string; reload: () => void }) { return <div className="p-5 flex justify-between"><h2 className="font-bold">{title}</h2><button type="button" title="Tải lại" onClick={reload} className="icon-button"><span className="material-symbols-outlined text-lg">refresh</span></button></div>; }

function Table({ headers, children }: { headers: { label: string; align?: "left" | "right" }[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs text-slate-500 uppercase border-b border-slate-200">
          <tr>
            {headers.map((header, i) => (
              <th
                key={i}
                className={`px-4 py-3 font-bold ${header.align === "right" ? "text-right" : "text-left"}`}
              >
                {header.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Cell({ children, right = false }: { children: React.ReactNode; right?: boolean }) { return <td className={`cell ${right ? "text-right" : ""}`}>{children}</td>; }
