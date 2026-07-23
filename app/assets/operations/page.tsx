"use client";

import { useEffect, useMemo, useState } from "react";
import { ModuleFrame, ModuleTabs } from "@/components/ModuleFrame";
import { DateInput, MonthInput } from "@/components/DateInput";
import { canPerformMenuAction } from "@/lib/auth-demo";
import { useModuleAuth } from "@/lib/use-module-auth";

type Asset = {
  id: string;
  code: string;
  name: string;
  branchCode: string;
  departmentCode?: string | null;
  originalCost: number;
  currentValue: number;
  residualValue: number;
  usefulLifeMonths: number | null;
  depreciationStartDate: string | null;
  supplierName?: string | null;
  supplierCode?: string | null;
  status?: string;
  disposalAmount?: number | null;
};

type Depreciation = {
  id: string;
  period: string;
  depreciationAmount: number;
  accumulatedDepreciation: number;
  remainingValue: number;
  asset: Asset;
};

type Maintenance = {
  id: string;
  maintenanceType: string;
  scheduledDate: string;
  completedDate: string | null;
  supplierName: string | null;
  cost: number;
  recurrenceRule?: string | null;
  linkedWorkItemId?: string | null;
  status: string;
  asset: Asset;
};

type Damage = {
  id: string;
  code: string;
  severity: string;
  description: string;
  status: string;
  repairCost: number;
  repairTreatment: string | null;
  linkedWorkItemId?: string | null;
  asset: Asset;
};

type Data = {
  assets: Asset[];
  depreciations: Depreciation[];
  maintenances: Maintenance[];
  damageReports: Damage[];
};

const money = (value: number) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(value || 0);

export default function AssetOperationsPage() {
  const href = "/assets";
  const { user, loading } = useModuleAuth(href);
  const [active, setActive] = useState("depreciation");
  const [data, setData] = useState<Data>({ assets: [], depreciations: [], maintenances: [], damageReports: [] });
  const [message, setMessage] = useState("");
  const [assetId, setAssetId] = useState("");
  const [config, setConfig] = useState({
    usefulLifeMonths: "60",
    depreciationStartDate: new Date().toISOString().slice(0, 10),
    residualValue: "0",
  });
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [maintenance, setMaintenance] = useState({
    maintenanceType: "Bảo trì định kỳ",
    scheduledDate: new Date().toISOString().slice(0, 10),
    supplierName: "",
    cost: "0",
    recurrenceRule: "NONE",
    recurrenceInterval: "1",
    recurrenceEndDate: "",
    assigneeName: "",
    createWorkTask: true,
    note: "",
  });
  const [damage, setDamage] = useState({
    severity: "MEDIUM",
    description: "",
    assigneeName: "",
    dueDate: "",
    note: "",
  });
  const [resolveDamage, setResolveDamage] = useState({
    id: "",
    repairCost: "1000000",
    repairTreatment: "EXPENSE",
    numberOfPeriods: "6",
    moneySourceCode: "",
    categoryCode: "REPAIR",
    supplierName: "",
    supplierCode: "",
    dueDate: "",
    note: "",
  });
  const [disposalForm, setDisposalForm] = useState({
    assetId: "",
    disposalDate: new Date().toISOString().slice(0, 10),
    disposalAmount: "0",
    moneySourceCode: "",
    disposalNote: "",
  });

  const canCreate = user ? canPerformMenuAction(user.role, href, "create") : false;
  const canEdit = user ? canPerformMenuAction(user.role, href, "edit") : false;

  const loadData = async () => {
    const response = await fetch("/api/assets/operations");
    if (!response.ok) return;
    const payload = await response.json() as Data;
    setData(payload);
    setAssetId((value) => value || payload.assets[0]?.id || "");
  };

  useEffect(() => {
    if (!loading) window.setTimeout(() => void loadData(), 0);
  }, [loading]);

  const send = async (body: object, success: string) => {
    const response = await fetch("/api/assets/operations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    setMessage(response.ok ? success : payload.error || "Không thực hiện được thao tác");
    if (response.ok) await loadData();
  };

  const getTreatmentLabel = (treatment?: string | null, cost?: number | null) => {
    if (!treatment) return "-";
    const amountStr = cost ? ` (${money(cost)} đ)` : "";
    switch (treatment) {
      case "EXPENSE":
        return <span className="status bg-blue-50 text-blue-800">Chi phí ngay{amountStr}</span>;
      case "DEBT":
        return <span className="status bg-purple-50 text-purple-800">Ghi nợ NCC{amountStr}</span>;
      case "ALLOCATE":
        return <span className="status bg-amber-50 text-amber-800">Phân bổ nhiều kỳ{amountStr}</span>;
      case "CAPITALIZE":
        return <span className="status bg-emerald-50 text-emerald-800">Tăng nguyên giá{amountStr}</span>;
      default:
        return <span>{treatment}{amountStr}</span>;
    }
  };

  if (loading) return <div className="h-screen grid place-items-center bg-slate-100">Đang tải...</div>;

  return (
    <ModuleFrame title="Vận hành tài sản" subtitle="Khấu hao, bảo trì cố định, sửa chữa phát sinh và thanh lý tài sản" role={user?.role}>
      <ModuleTabs
        active={active}
        onChange={setActive}
        tabs={[
          { id: "depreciation", label: "Khấu hao", icon: "trending_down" },
          { id: "maintenance", label: "Bảo trì", icon: "build" },
          { id: "damage", label: "Sửa chữa", icon: "report_problem" },
          { id: "disposal", label: "Thanh lý", icon: "delete_sweep" },
        ]}
      />

      {message && <p className="mb-4 px-4 py-3 rounded-lg border border-blue-100 bg-blue-50 text-sm text-blue-700">{message}</p>}
      {data.assets.length === 0 && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-4 text-sm">
          Cần tạo hồ sơ tài sản ở màn hình Tài sản trước khi chạy nghiệp vụ.
        </div>
      )}

      {active === "depreciation" && (
        <div className="space-y-5">
          <div className="grid lg:grid-cols-2 gap-5">
            {canEdit && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void send({ action: "CONFIGURE_DEPRECIATION", assetId, ...config }, "Đã cập nhật cấu hình khấu hao.");
                }}
                className="bg-white border border-slate-200 rounded-lg p-5 space-y-4"
              >
                <h2 className="font-bold">Cấu hình tài sản</h2>
                <AssetSelect assets={data.assets} value={assetId} onChange={setAssetId} />
                <div className="grid grid-cols-3 gap-3">
                  <Field label="Số tháng">
                    <input type="number" className="control" value={config.usefulLifeMonths} onChange={(e) => setConfig({ ...config, usefulLifeMonths: e.target.value })} />
                  </Field>
                  <Field label="Bắt đầu">
                    <DateInput className="mt-1.5" value={config.depreciationStartDate} onChange={(depreciationStartDate) => setConfig({ ...config, depreciationStartDate })} ariaLabel="Ngày bắt đầu khấu hao" />
                  </Field>
                  <Field label="Giá trị còn lại">
                    <input type="number" className="control" value={config.residualValue} onChange={(e) => setConfig({ ...config, residualValue: e.target.value })} />
                  </Field>
                </div>
                <button className="secondary-button w-full">Lưu cấu hình</button>
              </form>
            )}

            {canEdit && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void send({ action: "RUN_DEPRECIATION", period, branchCode: "ALL" }, "Đã chạy khấu hao cho các tài sản hợp lệ.");
                }}
                className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 h-fit"
              >
                <h2 className="font-bold">Chạy khấu hao tháng</h2>
                <Field label="Kỳ kế toán">
                  <MonthInput className="mt-1.5" value={period} onChange={setPeriod} ariaLabel="Kỳ khấu hao" />
                </Field>
                <p className="text-xs text-slate-500">Hệ thống bỏ qua tài sản đã chạy trong kỳ và không khấu hao thấp hơn giá trị còn lại.</p>
                <button className="primary-button w-full"><span className="material-symbols-outlined text-lg">play_arrow</span>Chạy khấu hao</button>
              </form>
            )}
          </div>

          <section className="table-panel">
            <Panel title="Lịch sử khấu hao" reload={loadData} />
            <Table headers={[{ label: "Kỳ" }, { label: "Tài sản" }, { label: "Khấu hao tháng", align: "right" }, { label: "Lũy kế", align: "right" }, { label: "Giá trị còn lại", align: "right" }]}>
              {data.depreciations.map((row) => (
                <tr key={row.id} className="border-t border-slate-100">
                  <Cell>{row.period}</Cell>
                  <Cell><b>{row.asset.code} - {row.asset.name}</b></Cell>
                  <Cell right>{money(row.depreciationAmount)} đ</Cell>
                  <Cell right>{money(row.accumulatedDepreciation)} đ</Cell>
                  <Cell right><b>{money(row.remainingValue)} đ</b></Cell>
                </tr>
              ))}
            </Table>
          </section>
        </div>
      )}

      {active === "maintenance" && (
        <div className="grid lg:grid-cols-[420px_1fr] gap-5">
          {canCreate && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send({ action: "SCHEDULE_MAINTENANCE", assetId, ...maintenance }, maintenance.recurrenceRule === "NONE" ? "Đã tạo lịch bảo trì." : "Đã tạo chuỗi lịch bảo trì cố định và công việc liên quan.");
              }}
              className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 h-fit"
            >
              <h2 className="font-bold">Lập lịch bảo trì cố định</h2>
              <AssetSelect assets={data.assets} value={assetId} onChange={setAssetId} />
              <Field label="Nội dung">
                <input className="control" value={maintenance.maintenanceType} onChange={(e) => setMaintenance({ ...maintenance, maintenanceType: e.target.value })} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Ngày dự kiến">
                  <DateInput className="mt-1.5" value={maintenance.scheduledDate} onChange={(scheduledDate) => setMaintenance({ ...maintenance, scheduledDate })} ariaLabel="Ngày bảo trì dự kiến" />
                </Field>
                <Field label="Chi phí dự kiến">
                  <input type="number" className="control" value={maintenance.cost} onChange={(e) => setMaintenance({ ...maintenance, cost: e.target.value })} />
                </Field>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Kiểu lặp">
                  <select className="control" value={maintenance.recurrenceRule} onChange={(e) => setMaintenance({ ...maintenance, recurrenceRule: e.target.value })}>
                    <option value="NONE">Một lần</option>
                    <option value="MONTHLY">Hàng tháng</option>
                    <option value="QUARTERLY">Hàng quý</option>
                    <option value="YEARLY">Hàng năm</option>
                  </select>
                </Field>
                <Field label="Mỗi">
                  <input type="number" min="1" className="control" value={maintenance.recurrenceInterval} onChange={(e) => setMaintenance({ ...maintenance, recurrenceInterval: e.target.value })} />
                </Field>
                <Field label="Lặp đến">
                  <DateInput className="mt-1.5" value={maintenance.recurrenceEndDate} onChange={(recurrenceEndDate) => setMaintenance({ ...maintenance, recurrenceEndDate })} ariaLabel="Ngày kết thúc lặp bảo trì" />
                </Field>
              </div>
              <Field label="Nhà cung cấp">
                <input className="control" value={maintenance.supplierName} onChange={(e) => setMaintenance({ ...maintenance, supplierName: e.target.value })} />
              </Field>
              <Field label="Người phụ trách công việc">
                <input className="control" value={maintenance.assigneeName} onChange={(e) => setMaintenance({ ...maintenance, assigneeName: e.target.value })} placeholder="Trống = người đang đăng nhập" />
              </Field>
              <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
                <input type="checkbox" checked={maintenance.createWorkTask} onChange={(e) => setMaintenance({ ...maintenance, createWorkTask: e.target.checked })} />
                Tự tạo công việc vận hành cho lịch bảo trì
              </label>
              <button className="primary-button w-full">Tạo lịch</button>
            </form>
          )}

          <section className="table-panel">
            <Panel title="Lịch bảo trì" reload={loadData} />
            <Table headers={[{ label: "Tài sản" }, { label: "Nội dung" }, { label: "Ngày dự kiến" }, { label: "Lặp" }, { label: "Task" }, { label: "Chi phí", align: "right" }, { label: "Trạng thái" }, { label: "Thao tác", align: "right" }]}>
              {data.maintenances.map((row) => (
                <tr key={row.id} className="border-t border-slate-100">
                  <Cell><b>{row.asset.code}</b><small>{row.asset.name}</small></Cell>
                  <Cell>{row.maintenanceType}</Cell>
                  <Cell>{new Date(row.scheduledDate).toLocaleDateString("vi-VN")}</Cell>
                  <Cell>{row.recurrenceRule || "-"}</Cell>
                  <Cell>{row.linkedWorkItemId ? <span className="status bg-blue-50 text-blue-700">Đã tạo</span> : "-"}</Cell>
                  <Cell right>{money(row.cost)} đ</Cell>
                  <Cell><span className="status bg-slate-100">{row.status}</span></Cell>
                  <Cell right>
                    {canEdit && row.status === "SCHEDULED" && (
                      <button className="action-link text-emerald-700" onClick={() => void send({ action: "COMPLETE_MAINTENANCE", id: row.id, completedDate: new Date().toISOString(), cost: row.cost }, "Đã hoàn thành bảo trì và đóng công việc liên quan.")}>
                        Hoàn thành
                      </button>
                    )}
                  </Cell>
                </tr>
              ))}
            </Table>
          </section>
        </div>
      )}

      {active === "damage" && (
        <div className="grid lg:grid-cols-[420px_1fr] gap-5">
          {canCreate && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send({ action: "REPORT_DAMAGE", assetId, ...damage }, "Đã gửi báo hỏng và tạo công việc sửa chữa.");
              }}
              className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 h-fit"
            >
              <h2 className="font-bold">Sửa chữa phát sinh</h2>
              <AssetSelect assets={data.assets} value={assetId} onChange={setAssetId} />
              <Field label="Mức độ">
                <select className="control" value={damage.severity} onChange={(e) => setDamage({ ...damage, severity: e.target.value })}>
                  <option value="LOW">Thấp</option>
                  <option value="MEDIUM">Trung bình</option>
                  <option value="HIGH">Nghiêm trọng</option>
                </select>
              </Field>
              <Field label="Mô tả">
                <textarea className="control h-24 resize-none" value={damage.description} onChange={(e) => setDamage({ ...damage, description: e.target.value })} required />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Người phụ trách">
                  <input className="control" value={damage.assigneeName} onChange={(e) => setDamage({ ...damage, assigneeName: e.target.value })} placeholder="Trống = người đăng nhập" />
                </Field>
                <Field label="Hạn xử lý">
                  <DateInput className="mt-1.5" value={damage.dueDate} onChange={(dueDate) => setDamage({ ...damage, dueDate })} ariaLabel="Hạn xử lý sửa chữa" />
                </Field>
              </div>
              <button className="primary-button w-full">Gửi báo hỏng</button>
            </form>
          )}

          <div className="space-y-4">
            {resolveDamage.id && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void send({ action: "RESOLVE_DAMAGE", ...resolveDamage, resolvedAt: new Date().toISOString() }, resolveDamage.repairTreatment === "EXPENSE" ? "Đã xử lý và tạo phiếu chi chờ duyệt." : resolveDamage.repairTreatment === "DEBT" ? "Đã ghi nhận công nợ nhà cung cấp." : "Đã hoàn tất xử lý báo hỏng.");
                  setResolveDamage({ id: "", repairCost: "1000000", repairTreatment: "EXPENSE", numberOfPeriods: "6", moneySourceCode: "", categoryCode: "REPAIR", supplierName: "", supplierCode: "", dueDate: "", note: "" });
                }}
                className="bg-blue-50 border border-blue-100 rounded-lg p-4 grid md:grid-cols-3 gap-3 items-end"
              >
                <Field label="Cách xử lý">
                  <select className="control" value={resolveDamage.repairTreatment} onChange={(e) => setResolveDamage({ ...resolveDamage, repairTreatment: e.target.value })}>
                    <option value="EXPENSE">Chi phí ngay (Tạo phiếu chi)</option>
                    <option value="DEBT">Ghi nợ NCC (Công nợ trả)</option>
                    <option value="ALLOCATE">Phân bổ nhiều kỳ</option>
                    <option value="CAPITALIZE">Tăng nguyên giá tài sản</option>
                  </select>
                </Field>
                <Field label="Chi phí sửa chữa (đ)">
                  <input type="number" className="control" value={resolveDamage.repairCost} onChange={(e) => setResolveDamage({ ...resolveDamage, repairCost: e.target.value })} required />
                </Field>
                {resolveDamage.repairTreatment === "ALLOCATE" && (
                  <Field label="Số kỳ phân bổ">
                    <input type="number" min="2" className="control" value={resolveDamage.numberOfPeriods} onChange={(e) => setResolveDamage({ ...resolveDamage, numberOfPeriods: e.target.value })} />
                  </Field>
                )}
                {resolveDamage.repairTreatment === "EXPENSE" && (
                  <Field label="Nguồn tiền">
                    <input className="control" value={resolveDamage.moneySourceCode} onChange={(e) => setResolveDamage({ ...resolveDamage, moneySourceCode: e.target.value })} placeholder="Trống = tự chọn" />
                  </Field>
                )}
                {(resolveDamage.repairTreatment === "DEBT" || resolveDamage.repairTreatment === "EXPENSE") && (
                  <Field label="Nhà cung cấp sửa chữa">
                    <input className="control" value={resolveDamage.supplierName} onChange={(e) => setResolveDamage({ ...resolveDamage, supplierName: e.target.value })} />
                  </Field>
                )}
                {resolveDamage.repairTreatment === "DEBT" && (
                  <>
                    <Field label="Mã NCC">
                      <input className="control" value={resolveDamage.supplierCode} onChange={(e) => setResolveDamage({ ...resolveDamage, supplierCode: e.target.value })} />
                    </Field>
                    <Field label="Hạn thanh toán">
                      <DateInput className="mt-1.5" value={resolveDamage.dueDate} onChange={(dueDate) => setResolveDamage({ ...resolveDamage, dueDate })} ariaLabel="Hạn thanh toán công nợ" />
                    </Field>
                  </>
                )}
                <Field label="Nhóm chi phí">
                  <input className="control" value={resolveDamage.categoryCode} onChange={(e) => setResolveDamage({ ...resolveDamage, categoryCode: e.target.value })} />
                </Field>
                <div className="flex gap-2">
                  <button className="primary-button flex-1">Lưu xử lý</button>
                  <button type="button" onClick={() => setResolveDamage({ id: "", repairCost: "1000000", repairTreatment: "EXPENSE", numberOfPeriods: "6", moneySourceCode: "", categoryCode: "REPAIR", supplierName: "", supplierCode: "", dueDate: "", note: "" })} className="secondary-button">Hủy</button>
                </div>
              </form>
            )}

            <section className="table-panel">
              <Panel title="Phiếu báo hỏng & sửa chữa" reload={loadData} />
              <Table headers={[{ label: "Phiếu" }, { label: "Tài sản" }, { label: "Mức độ" }, { label: "Mô tả" }, { label: "Task" }, { label: "Xử lý" }, { label: "Thao tác", align: "right" }]}>
                {data.damageReports.map((row) => (
                  <tr key={row.id} className="border-t border-slate-100">
                    <Cell><b>{row.code}</b><small>{row.status}</small></Cell>
                    <Cell>{row.asset.code} - {row.asset.name}</Cell>
                    <Cell><span className="status bg-amber-50 text-amber-700">{row.severity}</span></Cell>
                    <Cell>{row.description}</Cell>
                    <Cell>{row.linkedWorkItemId ? <span className="status bg-blue-50 text-blue-700">Đã tạo</span> : "-"}</Cell>
                    <Cell>{getTreatmentLabel(row.repairTreatment, row.repairCost)}</Cell>
                    <Cell right>
                      {canEdit && row.status !== "COMPLETED" && (
                        <button className="action-link text-blue-700" onClick={() => setResolveDamage({ ...resolveDamage, id: row.id, supplierName: row.asset.supplierName || "" })}>Xử lý</button>
                      )}
                    </Cell>
                  </tr>
                ))}
              </Table>
            </section>
          </div>
        </div>
      )}

      {active === "disposal" && (
        <div className="grid lg:grid-cols-[420px_1fr] gap-5">
          {canEdit && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send({ action: "DISPOSE_ASSET", ...disposalForm }, "Đã thực hiện thanh lý tài sản thành công.");
                setDisposalForm({ assetId: "", disposalDate: new Date().toISOString().slice(0, 10), disposalAmount: "0", moneySourceCode: "", disposalNote: "" });
              }}
              className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 h-fit"
            >
              <h2 className="font-bold text-rose-700 flex items-center gap-2">
                <span className="material-symbols-outlined">delete_sweep</span>
                Thực hiện thanh lý tài sản
              </h2>
              <AssetSelect assets={data.assets.filter((a) => a.status !== "DISPOSED")} value={disposalForm.assetId} onChange={(assetIdValue) => setDisposalForm({ ...disposalForm, assetId: assetIdValue })} />
              <Field label="Ngày thanh lý *">
                <DateInput className="mt-1.5" value={disposalForm.disposalDate} onChange={(disposalDate) => setDisposalForm({ ...disposalForm, disposalDate })} ariaLabel="Ngày thanh lý tài sản" required />
              </Field>
              <Field label="Số tiền thu từ thanh lý (đ)">
                <input type="number" min="0" className="control" value={disposalForm.disposalAmount} onChange={(e) => setDisposalForm({ ...disposalForm, disposalAmount: e.target.value })} />
              </Field>
              {Number(disposalForm.disposalAmount) > 0 && (
                <Field label="Tài khoản nhận tiền">
                  <input className="control" value={disposalForm.moneySourceCode} onChange={(e) => setDisposalForm({ ...disposalForm, moneySourceCode: e.target.value })} placeholder="Mã nguồn tiền" />
                </Field>
              )}
              <Field label="Lý do / ghi chú thanh lý">
                <textarea className="control h-20 resize-none" value={disposalForm.disposalNote} onChange={(e) => setDisposalForm({ ...disposalForm, disposalNote: e.target.value })} />
              </Field>
              <button className="primary-button bg-rose-600 hover:bg-rose-700 w-full">Xác nhận thanh lý</button>
            </form>
          )}

          <section className="table-panel">
            <Panel title="Danh sách tài sản đã thanh lý" reload={loadData} />
            <Table headers={[{ label: "Mã & tên tài sản" }, { label: "Nguyên giá", align: "right" }, { label: "Tiền thu thanh lý", align: "right" }, { label: "Trạng thái" }]}>
              {data.assets.filter((a) => a.status === "DISPOSED").length === 0 ? (
                <tr><td colSpan={4} className="px-4 py-8 text-center text-slate-400">Chưa có tài sản nào được thanh lý.</td></tr>
              ) : (
                data.assets.filter((a) => a.status === "DISPOSED").map((row) => (
                  <tr key={row.id} className="border-t border-slate-100">
                    <Cell><b>{row.code}</b><small className="block text-slate-600">{row.name}</small></Cell>
                    <Cell right>{money(row.originalCost)} đ</Cell>
                    <Cell right><b className="text-emerald-700">{money(row.disposalAmount || 0)} đ</b></Cell>
                    <Cell><span className="status bg-rose-100 text-rose-800">Đã thanh lý</span></Cell>
                  </tr>
                ))
              )}
            </Table>
          </section>
        </div>
      )}
    </ModuleFrame>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-xs font-bold text-slate-600">{label}{children}</label>;
}

function AssetSelect({ assets, value, onChange }: { assets: Asset[]; value: string; onChange: (value: string) => void }) {
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return assets;
    return assets.filter((asset) => `${asset.code} ${asset.name}`.toLowerCase().includes(keyword));
  }, [assets, search]);

  return (
    <Field label="Tài sản">
      <input
        className="control mt-1.5 rounded-b-none text-xs"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Gõ mã hoặc tên tài sản để lọc"
      />
      <select className="control rounded-t-none border-t-0" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Chọn tài sản</option>
        {filtered.map((asset) => (
          <option key={asset.id} value={asset.id}>{asset.code} - {asset.name}</option>
        ))}
      </select>
    </Field>
  );
}

function Panel({ title, reload }: { title: string; reload: () => void }) {
  return (
    <div className="p-5 flex justify-between">
      <h2 className="font-bold">{title}</h2>
      <button type="button" title="Tải lại" onClick={reload} className="icon-button">
        <span className="material-symbols-outlined text-lg">refresh</span>
      </button>
    </div>
  );
}

function Table({ headers, children }: { headers: { label: string; align?: "left" | "right" }[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500">
          <tr>
            {headers.map((header) => (
              <th key={header.label} className={`px-4 py-3 ${header.align === "right" ? "text-right" : "text-left"}`}>{header.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Cell({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <td className={`px-4 py-3 align-top ${right ? "text-right" : ""}`}>{children}</td>;
}
