"use client";

import { useEffect, useMemo, useState } from "react";
import { ModuleFrame, ModuleTabs } from "@/components/ModuleFrame";
import { DateInput } from "@/components/DateInput";
import { ConfirmDeleteDialog, RowActions } from "@/components/RowActions";
import { storeLabel, visibleStoreOptions } from "@/lib/branch-labels";
import { canPerformMenuAction, filterModuleTabs } from "@/lib/auth-demo";
import { useModuleAuth } from "@/lib/use-module-auth";
import CopyableText from "@/components/CopyableText";
import StickyFilterBar from "@/components/StickyFilterBar";

type Item = { id: string; code: string; name: string; unit: string; itemType: string; requiresImage: boolean };
type MasterItem = { id: string; type: string; code: string; name: string; branch: string | null; status: string };
type RequestLine = { id: string; itemId: string; quantity: number; estimatedUnitCost: number; imageUrl: string | null; item: Item };
type Quote = { id: string; supplierCode: string; supplierName: string; totalAmount: number; deliveryDays: number | null; paymentTerms: string | null; isSelected: boolean; note: string | null; lines: Array<{ itemId: string; quantity: number; unitCost: number }> };
type PurchaseRequest = { id: string; code: string; requestDate: string; branchCode: string; departmentCode: string | null; requestedBy: string; neededDate: string | null; reason: string; status: string; approvedAt: string | null; note: string | null; lines: RequestLine[]; quotes: Quote[] };
type OrderLine = { id: string; itemId: string; orderedQuantity: number; receivedQuantity: number; unitCost: number; imageUrl: string | null; item: Item };
type PurchaseOrder = { id: string; code: string; requestId: string | null; orderDate: string; supplierCode: string; supplierName: string; branchCode: string; departmentCode: string | null; warehouseCode: string; expectedDate: string | null; status: string; approvedAt: string | null; note: string | null; totalAmount: number; lines: OrderLine[]; payable: { outstandingAmount: number } | null };
type Data = { items: Item[]; requests: PurchaseRequest[]; orders: PurchaseOrder[]; departments: MasterItem[] };
/** Chứng từ mua hàng đang chờ xác nhận xoá. */
type DeleteTarget = { type: "REQUEST" | "ORDER" | "QUOTE"; id: string; title: string; description: string; label: string };

const money = (value: number) => new Intl.NumberFormat("vi-VN").format(value);
const statusStyle = (status: string) => status === "COMPLETED" || status === "APPROVED" ? "bg-emerald-50 text-emerald-700" : status.includes("REJECT") ? "bg-rose-50 text-rose-700" : "bg-amber-50 text-amber-700";

/** PR đã chốt thì không cho sửa/xoá nữa (khớp với /api/procurement). */
const lockedRequestStatuses = ["APPROVED", "ORDERED", "COMPLETED", "CANCELLED"];
/** PO chỉ còn sửa/xoá được khi đang ở trạng thái nháp. */
const lockedOrderStatuses = ["APPROVED", "PARTIALLY_RECEIVED", "COMPLETED", "CANCELLED"];

export default function ProcurementPage() {
  const href = "/procurement";
  const { user, loading } = useModuleAuth(href);
  const [active, setActive] = useState("requests");
  const [data, setData] = useState<Data>({ items: [], requests: [], orders: [], departments: [] });
  const [message, setMessage] = useState("");
  
  const [requestForm, setRequestForm] = useState({
    branchCode: "HCM",
    departmentCode: "",
    neededDate: new Date().toISOString().slice(0, 10),
    reason: "Bổ sung nguyên liệu vận hành",
    itemId: "",
    quantity: "10",
    estimatedUnitCost: "100000",
    imageUrl: "",
  });

  const [quoteForm, setQuoteForm] = useState({
    requestId: "",
    supplierCode: "NCC_001",
    supplierName: "Nhà cung cấp 01",
    unitCost: "95000",
    deliveryDays: "2",
    paymentTerms: "Công nợ 30 ngày"
  });

  const [warehouseCode, setWarehouseCode] = useState("KHO_HCM");

  /** Đề nghị mua hàng / báo giá / đơn mua hàng đang được sửa. */
  const [editingRequest, setEditingRequest] = useState<PurchaseRequest | null>(null);
  const [editingQuote, setEditingQuote] = useState<Quote | null>(null);
  const [editingOrder, setEditingOrder] = useState<PurchaseOrder | null>(null);
  const [orderForm, setOrderForm] = useState({ supplierName: "", warehouseCode: "", expectedDate: "", note: "" });
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const visibleTabs = useMemo(() => filterModuleTabs(user, href), [user]);

  // Tab mặc định có thể nằm ngoài quyền -> chuyển về tab đầu tiên được phép.
  useEffect(() => {
    if (visibleTabs.length === 0) return;
    if (visibleTabs.some((tab) => tab.id === active)) return;
    const fallback = visibleTabs[0].id;
    window.setTimeout(() => setActive(fallback), 0);
  }, [active, visibleTabs]);
  const canCreate = user ? canPerformMenuAction(user, href, "create") : false;
  const canEdit = user ? canPerformMenuAction(user, href, "edit") : false;
  const canApprove = user ? canPerformMenuAction(user, href, "approve") : false;
  const departmentName = (code?: string | null) => data.departments.find((item) => item.code === code)?.name || code || "Chưa gán phòng ban";
  const departmentsForBranch = useMemo(
    () => data.departments.filter((item) => !item.branch || item.branch === "ALL" || item.branch === requestForm.branchCode),
    [data.departments, requestForm.branchCode],
  );

  const loadData = async () => {
    const response = await fetch("/api/procurement");
    if (response.ok) {
      const payload = await response.json() as Data;
      setData(payload);
      setRequestForm((form) => {
        const availableDepartments = payload.departments.filter((item) => !item.branch || item.branch === "ALL" || item.branch === form.branchCode);
        return {
          ...form,
          itemId: form.itemId || payload.items[0]?.id || "",
          departmentCode: form.departmentCode || availableDepartments[0]?.code || "",
        };
      });
      setQuoteForm((form) => ({ ...form, requestId: form.requestId || payload.requests.find((item) => item.status === "APPROVED")?.id || payload.requests[0]?.id || "" }));
    }
  };

  useEffect(() => {
    if (!loading) window.setTimeout(() => void loadData(), 0);
  }, [loading]);

  const selectedRequest = useMemo(() => data.requests.find((item) => item.id === quoteForm.requestId), [data.requests, quoteForm.requestId]);
  const send = async (method: "POST" | "PATCH", body: object, success: string) => {
    setMessage("");
    const response = await fetch("/api/procurement", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json();
    setMessage(response.ok ? success : payload.error || "Không thực hiện được thao tác");
    if (response.ok) await loadData();
    return response.ok;
  };

  /** PR đã sinh đơn mua hàng thì mọi thay đổi phải đi qua đơn mua, không sửa ngược lại PR. */
  const requestHasOrder = (request: PurchaseRequest) => data.orders.some((order) => order.requestId === request.id);

  const requestLockReason = (request: PurchaseRequest) => {
    if (request.approvedAt || lockedRequestStatuses.includes(request.status)) {
      return `Đề nghị mua hàng ${request.code} đã được duyệt/chốt nên không thể sửa hoặc xoá.`;
    }
    if (requestHasOrder(request)) {
      return `Đề nghị mua hàng ${request.code} đã sinh đơn mua hàng nên không thể sửa hoặc xoá. Hãy xoá đơn mua hàng trước.`;
    }
    return null;
  };

  const orderLockReason = (order: PurchaseOrder) => {
    if (order.approvedAt || lockedOrderStatuses.includes(order.status)) {
      return `Đơn mua hàng ${order.code} đã được duyệt nên không thể sửa hoặc xoá. Hãy tạo đơn điều chỉnh mới.`;
    }
    if (order.lines.some((line) => line.receivedQuantity > 0)) {
      return `Đơn mua hàng ${order.code} đã nhận hàng vào kho nên không thể sửa hoặc xoá.`;
    }
    if (order.payable) {
      return `Đơn mua hàng ${order.code} đã sinh công nợ phải trả nhà cung cấp nên không thể sửa hoặc xoá.`;
    }
    return null;
  };

  const quoteLockReason = (request: PurchaseRequest, quote: Quote) => {
    if (quote.isSelected) {
      return `Báo giá của ${quote.supplierName} đang được chọn nên không thể sửa hoặc xoá. Hãy chọn báo giá khác trước.`;
    }
    if (requestHasOrder(request) || lockedRequestStatuses.includes(request.status)) {
      return `Đề nghị mua hàng ${request.code} đã chốt nên không thể sửa hoặc xoá báo giá kèm theo.`;
    }
    return null;
  };

  const resetRequestForm = () => {
    setEditingRequest(null);
    setRequestForm((form) => ({
      ...form,
      branchCode: "HCM",
      departmentCode: data.departments.find((item) => !item.branch || item.branch === "ALL" || item.branch === "HCM")?.code || "",
      neededDate: new Date().toISOString().slice(0, 10),
      reason: "Bổ sung nguyên liệu vận hành",
      itemId: data.items[0]?.id || "",
      quantity: "10",
      estimatedUnitCost: "100000",
      imageUrl: "",
    }));
  };

  const startEditRequest = (request: PurchaseRequest) => {
    const firstLine = request.lines[0];
    setEditingRequest(request);
    setActive("requests");
    setRequestForm({
      branchCode: request.branchCode,
      departmentCode: request.departmentCode || "",
      neededDate: (request.neededDate || request.requestDate).slice(0, 10),
      reason: request.reason,
      itemId: firstLine?.itemId || data.items[0]?.id || "",
      quantity: String(firstLine?.quantity ?? "1"),
      estimatedUnitCost: String(firstLine?.estimatedUnitCost ?? "0"),
      imageUrl: firstLine?.imageUrl || "",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const submitRequest = async (event: React.FormEvent) => {
    event.preventDefault();
    const lines = [{ itemId: requestForm.itemId, quantity: requestForm.quantity, estimatedUnitCost: requestForm.estimatedUnitCost, imageUrl: requestForm.imageUrl }];

    if (editingRequest) {
      // PR nhiều dòng hàng không biểu diễn được trên biểu mẫu một dòng nên chỉ cập nhật thông tin chung.
      const keepLines = editingRequest.lines.length > 1;
      const ok = await send(
        "PATCH",
        {
          action: "UPDATE_REQUEST",
          requestId: editingRequest.id,
          branchCode: requestForm.branchCode,
          departmentCode: requestForm.departmentCode,
          neededDate: requestForm.neededDate,
          reason: requestForm.reason,
          ...(keepLines ? {} : { lines }),
        },
        `Đã lưu thay đổi đề nghị mua hàng ${editingRequest.code}.`,
      );
      if (ok) resetRequestForm();
      return;
    }

    await send("POST", { action: "CREATE_REQUEST", branchCode: requestForm.branchCode, departmentCode: requestForm.departmentCode, neededDate: requestForm.neededDate, reason: requestForm.reason, lines }, "Đã tạo yêu cầu mua hàng.");
  };

  const resetQuoteForm = () => {
    setEditingQuote(null);
    setQuoteForm((form) => ({
      ...form,
      supplierCode: "NCC_001",
      supplierName: "Nhà cung cấp 01",
      unitCost: "95000",
      deliveryDays: "2",
      paymentTerms: "Công nợ 30 ngày",
    }));
  };

  const startEditQuote = (request: PurchaseRequest, quote: Quote) => {
    setEditingQuote(quote);
    setActive("quotes");
    setQuoteForm({
      requestId: request.id,
      supplierCode: quote.supplierCode,
      supplierName: quote.supplierName,
      unitCost: String(quote.lines[0]?.unitCost ?? "0"),
      deliveryDays: quote.deliveryDays !== null ? String(quote.deliveryDays) : "",
      paymentTerms: quote.paymentTerms || "",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const submitQuote = async (event: React.FormEvent) => {
    event.preventDefault();

    if (editingQuote) {
      const ok = await send(
        "PATCH",
        {
          action: "UPDATE_QUOTE",
          quoteId: editingQuote.id,
          supplierName: quoteForm.supplierName,
          deliveryDays: quoteForm.deliveryDays,
          paymentTerms: quoteForm.paymentTerms,
          lines: editingQuote.lines.map((line) => ({ itemId: line.itemId, quantity: line.quantity, unitCost: quoteForm.unitCost })),
        },
        `Đã lưu thay đổi báo giá của ${quoteForm.supplierName}.`,
      );
      if (ok) resetQuoteForm();
      return;
    }

    if (!selectedRequest) return;
    await send("POST", { action: "ADD_QUOTE", requestId: selectedRequest.id, supplierCode: quoteForm.supplierCode, supplierName: quoteForm.supplierName, deliveryDays: quoteForm.deliveryDays, paymentTerms: quoteForm.paymentTerms, lines: selectedRequest.lines.map((line) => ({ itemId: line.itemId, quantity: line.quantity, unitCost: quoteForm.unitCost })) }, "Đã thêm báo giá nhà cung cấp.");
  };

  const startEditOrder = (order: PurchaseOrder) => {
    setEditingOrder(order);
    setOrderForm({
      supplierName: order.supplierName,
      warehouseCode: order.warehouseCode,
      expectedDate: order.expectedDate ? order.expectedDate.slice(0, 10) : "",
      note: order.note || "",
    });
  };

  const submitOrder = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editingOrder) return;
    const ok = await send(
      "PATCH",
      {
        action: "UPDATE_ORDER",
        orderId: editingOrder.id,
        supplierName: orderForm.supplierName,
        warehouseCode: orderForm.warehouseCode,
        expectedDate: orderForm.expectedDate,
        note: orderForm.note,
      },
      `Đã lưu thay đổi đơn mua hàng ${editingOrder.code}.`,
    );
    if (ok) setEditingOrder(null);
  };

  const confirmDeleteProcurement = async (reason: string) => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const query = new URLSearchParams({ type: deleteTarget.type, id: deleteTarget.id });
      if (reason) query.set("reason", reason);
      const response = await fetch(`/api/procurement?${query.toString()}`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) {
        setDeleteError(payload.error || "Không xoá được chứng từ mua hàng");
        return;
      }
      if (deleteTarget.type === "REQUEST" && editingRequest?.id === deleteTarget.id) resetRequestForm();
      if (deleteTarget.type === "QUOTE" && editingQuote?.id === deleteTarget.id) resetQuoteForm();
      if (deleteTarget.type === "ORDER" && editingOrder?.id === deleteTarget.id) setEditingOrder(null);
      const label = deleteTarget.label;
      setDeleteTarget(null);
      await loadData();
      setMessage(`Đã chuyển ${label} vào Thùng rác.`);
    } finally {
      setDeleting(false);
    }
  };

  const createOrder = async (request: PurchaseRequest, quote: Quote) => {
    await send("POST", { action: "CREATE_ORDER", requestId: request.id, supplierCode: quote.supplierCode, supplierName: quote.supplierName, branchCode: request.branchCode, departmentCode: request.departmentCode, warehouseCode, lines: quote.lines.map((line) => ({ itemId: line.itemId, quantity: line.quantity, unitCost: line.unitCost })) }, "Đã tạo PO nháp từ báo giá. Vui lòng duyệt PO trước khi nhận hàng.");
    setActive("orders");
  };

  const handleSupplierSelect = (code: string) => {
    let name = "Nhà cung cấp 01";
    if (code === "NCC_002") name = "Nhà cung cấp 02";
    else if (code === "NCC_FOOD") name = "Nhà phân phối thực phẩm";
    setQuoteForm({ ...quoteForm, supplierCode: code, supplierName: name });
  };

  const totalPRs = data.requests.length;
  const pendingPRs = data.requests.filter((r) => ["DRAFT", "PENDING_APPROVAL"].includes(r.status)).length;
  const totalPOs = data.orders.length;
  const openPOs = data.orders.filter((o) => !["COMPLETED", "RECEIVED"].includes(o.status)).length;

  if (loading) return <div className="h-screen grid place-items-center bg-slate-100">Đang tải...</div>;

  return (
    <ModuleFrame title="Mua hàng & Nhà cung cấp" subtitle="GĐ3 - PR, báo giá, PO và nhận hàng" role={user?.role}>
      {/* Operational Summary Cards */}
      <StickyFilterBar>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500">Tổng yêu cầu PR</span>
            <span className="material-symbols-outlined text-blue-500 text-xl">assignment</span>
          </div>
          <p className="text-lg font-bold text-slate-800 mt-1">{totalPRs} yêu cầu</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500">PR chờ duyệt</span>
            <span className="material-symbols-outlined text-amber-500 text-xl">pending_actions</span>
          </div>
          <p className="text-lg font-bold text-amber-600 mt-1">{pendingPRs} yêu cầu</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500">Đơn mua hàng (PO)</span>
            <span className="material-symbols-outlined text-indigo-500 text-xl">local_shipping</span>
          </div>
          <p className="text-lg font-bold text-indigo-600 mt-1">{totalPOs} đơn</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500">PO đang thực hiện</span>
            <span className="material-symbols-outlined text-emerald-500 text-xl">package_2</span>
          </div>
          <p className="text-lg font-bold text-emerald-600 mt-1">{openPOs} đơn</p>
        </div>
      </div>

      <ModuleTabs active={active} onChange={setActive} tabs={visibleTabs} />
      </StickyFilterBar>
      {message && <p className="mb-4 px-4 py-3 rounded-lg border border-blue-100 bg-blue-50 text-sm text-blue-700">{message}</p>}

      {active === "requests" && (
        <div className="grid xl:grid-cols-[360px_1fr] gap-5">
          {(canCreate || editingRequest) && (
            <form onSubmit={submitRequest} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 h-fit shadow-sm">
              <h2 className="font-bold text-slate-800">
                {editingRequest ? `Sửa đề nghị ${editingRequest.code}` : "Tạo yêu cầu mua"}
              </h2>

              {editingRequest && editingRequest.lines.length > 1 && (
                <p className="text-xs rounded-lg bg-amber-50 border border-amber-200 text-amber-800 px-3 py-2">
                  Đề nghị này có {editingRequest.lines.length} dòng hàng nên chỉ cập nhật được thông tin chung
                  (cửa hàng, phòng ban, ngày cần hàng, lý do). Danh sách mặt hàng được giữ nguyên.
                </p>
              )}

              <Field label="Cửa hàng">
                <select
                  value={requestForm.branchCode}
                  onChange={(e) => {
                    const branchCode = e.target.value;
                    const nextDepartment = data.departments.find((item) => !item.branch || item.branch === "ALL" || item.branch === branchCode)?.code || "";
                    setRequestForm({ ...requestForm, branchCode, departmentCode: nextDepartment });
                  }}
                  className="control"
                  required
                >
                  {visibleStoreOptions(user).map((option) => (
                    <option key={option.code} value={option.code}>
                      {storeLabel(option.code)}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Phòng ban cần mua">
                <select
                  value={requestForm.departmentCode}
                  onChange={(e) => setRequestForm({ ...requestForm, departmentCode: e.target.value })}
                  className="control"
                  required
                >
                  {departmentsForBranch.map((item) => (
                    <option key={item.id} value={item.code}>
                      {item.name} ({item.code})
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Mặt hàng">
                <select
                  value={requestForm.itemId}
                  onChange={(e) => setRequestForm({ ...requestForm, itemId: e.target.value })}
                  className="control"
                  required
                >
                  {data.items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} ({item.code}) - {item.unit}
                    </option>
                  ))}
                </select>
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Số lượng">
                  <input
                    type="number"
                    min="0.01"
                    step="any"
                    value={requestForm.quantity}
                    onChange={(e) => setRequestForm({ ...requestForm, quantity: e.target.value })}
                    className="control"
                    required
                  />
                </Field>
                <Field label="Đơn giá dự kiến">
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={requestForm.estimatedUnitCost}
                    onChange={(e) => setRequestForm({ ...requestForm, estimatedUnitCost: e.target.value })}
                    className="control"
                    required
                  />
                </Field>
              </div>

              <Field label="Ngày cần hàng">
                <DateInput
                  value={requestForm.neededDate}
                  onChange={(neededDate) => setRequestForm({ ...requestForm, neededDate })}
                  className="control"
                  required
                  ariaLabel="Ngày cần hàng"
                />
              </Field>

              <Field label="Lý do / Diễn giải">
                <textarea
                  value={requestForm.reason}
                  onChange={(e) => setRequestForm({ ...requestForm, reason: e.target.value })}
                  className="control h-20 resize-none"
                  required
                />
              </Field>

              <Field label="URL hình ảnh (nếu có)">
                <input
                  type="url"
                  placeholder="https://... hoặc để trống"
                  value={requestForm.imageUrl}
                  onChange={(e) => setRequestForm({ ...requestForm, imageUrl: e.target.value })}
                  className="control"
                />
              </Field>
              
              <div className="flex gap-2">
                {editingRequest && (
                  <button type="button" onClick={resetRequestForm} className="px-4 rounded-lg border border-slate-300 bg-white py-2 text-sm font-bold text-slate-600 hover:bg-slate-50">
                    Huỷ
                  </button>
                )}
                <button className="primary-button flex-1">
                  <span className="material-symbols-outlined text-lg">{editingRequest ? "save" : "add"}</span>
                  {editingRequest ? "Lưu thay đổi" : "Tạo PR"}
                </button>
              </div>
            </form>
          )}

          <section className="table-panel shadow-sm">
            <PanelTitle title="Danh sách PR" onReload={loadData} />
            <Table
              headers={[
                { label: "Yêu cầu" },
                { label: "Phòng ban" },
                { label: "Nội dung" },
                { label: "Giá dự kiến", align: "right" },
                { label: "Trạng thái" },
                { label: "Thao tác", align: "right" },
              ]}
            >
              {data.requests.map((request) => (
                <tr key={request.id} className="border-t border-slate-100">
                  <td className="cell">
                    <CopyableText value={request.code}><b>{request.code}</b></CopyableText>
                    <small>{new Date(request.requestDate).toLocaleDateString("vi-VN")} · {request.branchCode}</small>
                  </td>
                  <td className="cell">
                    <b>{departmentName(request.departmentCode)}</b>
                    <small>{request.departmentCode || "UNASSIGNED"}</small>
                  </td>
                  <td className="cell">
                    <b>{request.reason}</b>
                    <small>{request.lines.map((line) => `${line.item.name}: ${line.quantity} ${line.item.unit}${line.imageUrl ? " · có hình" : ""}`).join(", ")}</small>
                  </td>
                  <td className="cell text-right font-semibold">
                    {money(request.lines.reduce((sum, line) => sum + line.quantity * line.estimatedUnitCost, 0))} đ
                  </td>
                  <td className="cell">
                    <span className={`status ${statusStyle(request.status)}`}>{request.status}</span>
                  </td>
                  <td className="cell">
                    <div className="flex items-center justify-end gap-2">
                      {canApprove && request.status === "PENDING_APPROVAL" && (
                        <>
                          <button onClick={() => void send("PATCH", { action: "APPROVE_REQUEST", requestId: request.id }, "Đã duyệt PR.")} className="action-link text-emerald-700 hover:underline">Duyệt</button>
                          <button onClick={() => void send("PATCH", { action: "REJECT_REQUEST", requestId: request.id }, "Đã từ chối PR.")} className="action-link text-rose-700 hover:underline">Từ chối</button>
                        </>
                      )}
                      <RowActions
                        session={user}
                        module={href}
                        compact
                        onEdit={() => startEditRequest(request)}
                        onDelete={() => {
                          setDeleteError(null);
                          setDeleteTarget({
                            type: "REQUEST",
                            id: request.id,
                            title: `Xoá đề nghị mua hàng ${request.code}?`,
                            description: `${request.reason} · ${departmentName(request.departmentCode)}`,
                            label: `đề nghị mua hàng ${request.code}`,
                          });
                        }}
                        editDisabledReason={requestLockReason(request)}
                        deleteDisabledReason={requestLockReason(request)}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </Table>
          </section>
        </div>
      )}

      {active === "quotes" && (
        <div className="grid xl:grid-cols-[360px_1fr] gap-5">
          {(canCreate || editingQuote) && (
            <form onSubmit={submitQuote} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 h-fit shadow-sm">
              <h2 className="font-bold text-slate-800">
                {editingQuote ? `Sửa báo giá của ${editingQuote.supplierName}` : "Nhập báo giá"}
              </h2>

              <Field label="Yêu cầu mua">
                <select value={quoteForm.requestId} onChange={(e) => setQuoteForm({ ...quoteForm, requestId: e.target.value })} className="control" disabled={Boolean(editingQuote)}>
                  {data.requests.filter((item) => ["APPROVED", "ORDERED"].includes(item.status)).map((item) => (
                    <option key={item.id} value={item.id}>{item.code} - {item.reason}</option>
                  ))}
                </select>
              </Field>
              
              <Field label="Nhà cung cấp">
                <select
                  value={quoteForm.supplierCode}
                  onChange={(e) => handleSupplierSelect(e.target.value)}
                  className="control"
                  disabled={Boolean(editingQuote)}
                >
                  <option value="NCC_001">NCC_001 (Nhà cung cấp 01)</option>
                  <option value="NCC_002">NCC_002 (Nhà cung cấp 02)</option>
                  <option value="NCC_FOOD">NCC_FOOD (Nhà phân phối thực phẩm)</option>
                </select>
              </Field>
              
              <div className="grid grid-cols-2 gap-3">
                <Field label="Đơn giá">
                  <input type="number" value={quoteForm.unitCost} onChange={(e) => setQuoteForm({ ...quoteForm, unitCost: e.target.value })} className="control" />
                </Field>
                <Field label="Giao trong (ngày)">
                  <input type="number" value={quoteForm.deliveryDays} onChange={(e) => setQuoteForm({ ...quoteForm, deliveryDays: e.target.value })} className="control" />
                </Field>
              </div>
              
              <Field label="Điều khoản">
                <input value={quoteForm.paymentTerms} onChange={(e) => setQuoteForm({ ...quoteForm, paymentTerms: e.target.value })} className="control" />
              </Field>
              
              <div className="flex gap-2">
                {editingQuote && (
                  <button type="button" onClick={resetQuoteForm} className="px-4 rounded-lg border border-slate-300 bg-white py-2 text-sm font-bold text-slate-600 hover:bg-slate-50">
                    Huỷ
                  </button>
                )}
                <button className="primary-button flex-1">
                  <span className="material-symbols-outlined text-lg">{editingQuote ? "save" : "add"}</span>
                  {editingQuote ? "Lưu thay đổi" : "Thêm báo giá"}
                </button>
              </div>
            </form>
          )}

          <section className="space-y-4">
            {data.requests.filter((request) => request.quotes.length > 0).map((request) => (
              <div key={request.id} className="table-panel shadow-sm p-4">
                <div className="flex items-center justify-between pb-3 mb-3 border-b border-slate-100">
                  <div>
                    <b><CopyableText value={request.code} /> — {request.reason}</b>
                    <p className="text-xs text-slate-500">Mặt hàng: {request.lines.map((line) => `${line.item.name} (${line.quantity} ${line.item.unit})`).join(", ")}</p>
                  </div>
                  <span className={`status ${statusStyle(request.status)}`}>{request.status}</span>
                </div>

                <div className="overflow-x-auto max-h-[300px] overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-xs text-slate-500 uppercase border-b border-slate-200 sticky top-0 z-10">
                      <tr>
                        <th className="px-3 py-2 text-left">Nhà cung cấp</th>
                        <th className="px-3 py-2 text-right">Tổng giá</th>
                        <th className="px-3 py-2 text-center">Giao hàng</th>
                        <th className="px-3 py-2 text-left">Điều khoản</th>
                        <th className="px-3 py-2 text-right">Thao tác</th>
                      </tr>
                    </thead>
                    <tbody>
                      {request.quotes.map((quote) => (
                        <tr key={quote.id} className="border-t border-slate-100">
                          <td className="cell">
                            <b>{quote.supplierName}</b>
                            <small>{quote.supplierCode}</small>
                          </td>
                          <td className="cell text-right font-bold">{money(quote.totalAmount)} đ</td>
                          <td className="cell text-center">{quote.deliveryDays ? `${quote.deliveryDays} ngày` : "N/A"}</td>
                          <td className="cell">{quote.paymentTerms || "N/A"}</td>
                          <td className="cell">
                            <div className="flex items-center justify-end gap-2">
                              {canCreate && (
                                <button onClick={() => void createOrder(request, quote)} className="action-link text-blue-700 hover:underline">
                                  Chọn & Tạo PO
                                </button>
                              )}
                              <RowActions
                                session={user}
                                module={href}
                                compact
                                onEdit={() => startEditQuote(request, quote)}
                                onDelete={() => {
                                  setDeleteError(null);
                                  setDeleteTarget({
                                    type: "QUOTE",
                                    id: quote.id,
                                    title: `Xoá báo giá của ${quote.supplierName}?`,
                                    description: `${request.code} · ${money(quote.totalAmount)} đ`,
                                    label: `báo giá của ${quote.supplierName} trên ${request.code}`,
                                  });
                                }}
                                editDisabledReason={quoteLockReason(request, quote)}
                                deleteDisabledReason={quoteLockReason(request, quote)}
                              />
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </section>
        </div>
      )}

      {active === "orders" && (
        <section className="table-panel shadow-sm">
          <div className="p-5 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h2 className="font-bold">Đơn mua hàng (PO)</h2>
              <p className="text-xs text-slate-500 mt-1">Duyệt PO và bấm &quot;Nhận hàng&quot; để tự động tăng tồn kho &amp; ghi nhận công nợ.</p>
            </div>
            <div className="flex items-center gap-3">
              <label className="text-xs font-semibold text-slate-600 flex items-center gap-1.5">
                Kho nhận:
                <select value={warehouseCode} onChange={(e) => setWarehouseCode(e.target.value)} className="control py-1 px-2 text-xs">
                  <option value="KHO_HCM">Kho Cửa hàng 1 (KHO_HCM)</option>
                  <option value="KHO_HN">Kho Cửa hàng 2 (KHO_HN)</option>
                </select>
              </label>
              <button type="button" title="Tải lại" onClick={loadData} className="icon-button"><span className="material-symbols-outlined text-lg">refresh</span></button>
            </div>
          </div>

          <Table
            headers={[
              { label: "Mã PO" },
              { label: "Nhà cung cấp" },
              { label: "Cửa hàng/Kho" },
              { label: "Tổng tiền", align: "right" },
              { label: "Trạng thái" },
              { label: "Tài sản/CCDC" },
              { label: "Công nợ phát sinh", align: "right" },
              { label: "Thao tác", align: "right" },
            ]}
          >
            {data.orders.map((order) => {
              const totalOrdered = order.lines.reduce((sum, line) => sum + line.orderedQuantity, 0);
              const totalReceived = order.lines.reduce((sum, line) => sum + line.receivedQuantity, 0);
              return (
                <tr key={order.id} className="border-t border-slate-100">
                  <td className="cell">
                    <CopyableText value={order.code}><b>{order.code}</b></CopyableText>
                    <small>{new Date(order.orderDate).toLocaleDateString("vi-VN")}</small>
                  </td>
                  <td className="cell">
                    <b>{order.supplierName}</b>
                    <small>{order.lines.map((line) => `${line.item.name} (${line.receivedQuantity}/${line.orderedQuantity})`).join(", ")}</small>
                  </td>
                  <td className="cell">
                    <b>{storeLabel(order.branchCode)}</b>
                    <small>Kho: {order.warehouseCode}</small>
                  </td>
                  <td className="cell text-right font-bold">{money(order.totalAmount)} đ</td>
                  <td className="cell">
                    <span className={`status ${statusStyle(order.status)}`}>{order.status}</span>
                    <small className="block mt-0.5 text-[10px] text-slate-500">Đã nhận: {totalReceived}/{totalOrdered}</small>
                  </td>
                  <td className="cell">
                    <b>{order.lines.filter((line) => ["TOOL", "ASSET"].includes(line.item.itemType)).length} dòng</b>
                    <small>{order.lines.some((line) => line.imageUrl) ? "Có hình ảnh" : "Chưa có hình"}</small>
                  </td>
                  <td className="cell text-right font-semibold text-rose-700">
                    {money(order.payable?.outstandingAmount || 0)} đ
                  </td>
                  <td className="cell">
                    <div className="flex items-center justify-end gap-2">
                      {canApprove && order.status === "DRAFT" && (
                        <button onClick={() => void send("PATCH", { action: "APPROVE_ORDER", orderId: order.id }, "Đã duyệt PO.")} className="action-link text-blue-700 hover:underline">
                          Duyệt PO
                        </button>
                      )}
                      {canEdit && ["APPROVED", "PARTIALLY_RECEIVED"].includes(order.status) && (
                        <button onClick={() => void send("PATCH", { action: "RECEIVE_ORDER", orderId: order.id }, "Đã nhận toàn bộ số lượng còn lại và cập nhật kho.")} className="action-link text-emerald-700 hover:underline">
                          Nhận hàng
                        </button>
                      )}
                      <RowActions
                        session={user}
                        module={href}
                        compact
                        onEdit={() => startEditOrder(order)}
                        onDelete={() => {
                          setDeleteError(null);
                          setDeleteTarget({
                            type: "ORDER",
                            id: order.id,
                            title: `Xoá đơn mua hàng ${order.code}?`,
                            description: `${order.supplierName} · ${money(order.totalAmount)} đ`,
                            label: `đơn mua hàng ${order.code}`,
                          });
                        }}
                        editDisabledReason={orderLockReason(order)}
                        deleteDisabledReason={orderLockReason(order)}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </Table>
        </section>
      )}

      {editingOrder && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <form onSubmit={submitOrder} className="bg-white rounded-xl w-full max-w-md shadow-xl">
            <div className="p-5 border-b border-slate-200">
              <h3 className="font-bold text-slate-900">Sửa đơn mua hàng {editingOrder.code}</h3>
              <p className="text-sm text-slate-500 mt-1">
                Chỉ đơn nháp chưa nhận hàng mới sửa được. Danh sách mặt hàng giữ nguyên.
              </p>
            </div>

            <div className="p-5 space-y-4">
              <Field label="Nhà cung cấp">
                <input
                  value={orderForm.supplierName}
                  onChange={(e) => setOrderForm({ ...orderForm, supplierName: e.target.value })}
                  className="control"
                  required
                />
              </Field>

              <Field label="Kho nhận">
                <select
                  value={orderForm.warehouseCode}
                  onChange={(e) => setOrderForm({ ...orderForm, warehouseCode: e.target.value })}
                  className="control"
                  required
                >
                  <option value="KHO_HCM">Kho Cửa hàng 1 (KHO_HCM)</option>
                  <option value="KHO_HN">Kho Cửa hàng 2 (KHO_HN)</option>
                </select>
              </Field>

              <Field label="Ngày dự kiến nhận">
                <DateInput
                  value={orderForm.expectedDate}
                  onChange={(expectedDate) => setOrderForm({ ...orderForm, expectedDate })}
                  className="control"
                  ariaLabel="Ngày dự kiến nhận hàng"
                />
              </Field>

              <Field label="Ghi chú">
                <textarea
                  value={orderForm.note}
                  onChange={(e) => setOrderForm({ ...orderForm, note: e.target.value })}
                  className="control h-20 resize-none"
                  placeholder="Ghi chú thêm cho đơn mua hàng..."
                />
              </Field>
            </div>

            <div className="p-5 border-t border-slate-200 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditingOrder(null)}
                className="px-4 py-2 rounded-lg text-sm font-bold text-slate-600 hover:bg-slate-100"
              >
                Huỷ
              </button>
              <button type="submit" className="px-4 py-2 rounded-lg text-sm font-bold bg-blue-600 hover:bg-blue-700 text-white">
                Lưu thay đổi
              </button>
            </div>
          </form>
        </div>
      )}

      <ConfirmDeleteDialog
        open={Boolean(deleteTarget)}
        title={deleteTarget?.title || ""}
        description={deleteTarget?.description}
        submitting={deleting}
        error={deleteError}
        onCancel={() => {
          setDeleteTarget(null);
          setDeleteError(null);
        }}
        onConfirm={confirmDeleteProcurement}
      />
    </ModuleFrame>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block text-xs font-bold text-slate-600">{label}{children}</label>; }
function PanelTitle({ title, onReload }: { title: string; onReload: () => void }) { return <div className="p-5 flex items-center justify-between"><h2 className="font-bold">{title}</h2><button type="button" title="Tải lại" onClick={onReload} className="icon-button"><span className="material-symbols-outlined text-lg">refresh</span></button></div>; }

function Table({ headers, children }: { headers: { label: string; align?: "left" | "right" }[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto max-h-[580px] overflow-y-auto">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs text-slate-500 uppercase border-b border-slate-200 sticky top-0 z-10 shadow-sm">
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
