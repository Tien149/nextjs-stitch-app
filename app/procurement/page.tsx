"use client";

import { useEffect, useMemo, useState } from "react";
import { ModuleFrame, ModuleTabs } from "@/components/ModuleFrame";
import { DateInput } from "@/components/DateInput";
import { storeLabel, storeOptions } from "@/lib/branch-labels";
import { canPerformMenuAction } from "@/lib/auth-demo";
import { useModuleAuth } from "@/lib/use-module-auth";

type Item = { id: string; code: string; name: string; unit: string; itemType: string; requiresImage: boolean };
type RequestLine = { id: string; itemId: string; quantity: number; estimatedUnitCost: number; imageUrl: string | null; item: Item };
type Quote = { id: string; supplierCode: string; supplierName: string; totalAmount: number; deliveryDays: number | null; paymentTerms: string | null; isSelected: boolean; lines: Array<{ itemId: string; quantity: number; unitCost: number }> };
type PurchaseRequest = { id: string; code: string; requestDate: string; branchCode: string; requestedBy: string; neededDate: string | null; reason: string; status: string; lines: RequestLine[]; quotes: Quote[] };
type OrderLine = { id: string; itemId: string; orderedQuantity: number; receivedQuantity: number; unitCost: number; imageUrl: string | null; item: Item };
type PurchaseOrder = { id: string; code: string; orderDate: string; supplierName: string; branchCode: string; warehouseCode: string; status: string; totalAmount: number; lines: OrderLine[]; payable: { outstandingAmount: number } | null };
type Data = { items: Item[]; requests: PurchaseRequest[]; orders: PurchaseOrder[] };

const money = (value: number) => new Intl.NumberFormat("vi-VN").format(value);
const statusStyle = (status: string) => status === "COMPLETED" || status === "APPROVED" ? "bg-emerald-50 text-emerald-700" : status.includes("REJECT") ? "bg-rose-50 text-rose-700" : "bg-amber-50 text-amber-700";

export default function ProcurementPage() {
  const href = "/procurement";
  const { user, loading } = useModuleAuth(href);
  const [active, setActive] = useState("requests");
  const [data, setData] = useState<Data>({ items: [], requests: [], orders: [] });
  const [message, setMessage] = useState("");
  
  const [requestForm, setRequestForm] = useState({
    branchCode: "HCM",
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

  const canCreate = user ? canPerformMenuAction(user.role, href, "create") : false;
  const canEdit = user ? canPerformMenuAction(user.role, href, "edit") : false;
  const canApprove = user ? canPerformMenuAction(user.role, href, "approve") : false;

  const loadData = async () => {
    const response = await fetch("/api/procurement");
    if (response.ok) {
      const payload = await response.json() as Data;
      setData(payload);
      setRequestForm((form) => ({ ...form, itemId: form.itemId || payload.items[0]?.id || "" }));
      setQuoteForm((form) => ({ ...form, requestId: form.requestId || payload.requests.find((item) => item.status === "APPROVED")?.id || payload.requests[0]?.id || "" }));
    }
  };

  useEffect(() => {
    if (!loading) window.setTimeout(() => void loadData(), 0);
  }, [loading]);

  const selectedRequest = useMemo(() => data.requests.find((item) => item.id === quoteForm.requestId), [data.requests, quoteForm.requestId]);
  const selectedItem = useMemo(() => data.items.find((item) => item.id === requestForm.itemId), [data.items, requestForm.itemId]);

  const send = async (method: "POST" | "PATCH", body: object, success: string) => {
    setMessage("");
    const response = await fetch("/api/procurement", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json();
    setMessage(response.ok ? success : payload.error || "Không thực hiện được thao tác");
    if (response.ok) await loadData();
    return response.ok;
  };

  const createRequest = async (event: React.FormEvent) => {
    event.preventDefault();
    await send("POST", { action: "CREATE_REQUEST", branchCode: requestForm.branchCode, neededDate: requestForm.neededDate, reason: requestForm.reason, lines: [{ itemId: requestForm.itemId, quantity: requestForm.quantity, estimatedUnitCost: requestForm.estimatedUnitCost, imageUrl: requestForm.imageUrl }] }, "Đã tạo yêu cầu mua hàng.");
  };

  const addQuote = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedRequest) return;
    await send("POST", { action: "ADD_QUOTE", requestId: selectedRequest.id, supplierCode: quoteForm.supplierCode, supplierName: quoteForm.supplierName, deliveryDays: quoteForm.deliveryDays, paymentTerms: quoteForm.paymentTerms, lines: selectedRequest.lines.map((line) => ({ itemId: line.itemId, quantity: line.quantity, unitCost: quoteForm.unitCost })) }, "Đã thêm báo giá nhà cung cấp.");
  };

  const createOrder = async (request: PurchaseRequest, quote: Quote) => {
    await send("POST", { action: "CREATE_ORDER", requestId: request.id, supplierCode: quote.supplierCode, supplierName: quote.supplierName, branchCode: request.branchCode, warehouseCode, lines: quote.lines.map((line) => ({ itemId: line.itemId, quantity: line.quantity, unitCost: line.unitCost })) }, "Đã tạo PO nháp từ báo giá. Vui lòng duyệt PO trước khi nhận hàng.");
    setActive("orders");
  };

  const handleSupplierSelect = (code: string) => {
    let name = "Nhà cung cấp 01";
    if (code === "NCC_002") name = "Nhà cung cấp 02";
    else if (code === "NCC_FOOD") name = "Nhà phân phối thực phẩm";
    setQuoteForm({ ...quoteForm, supplierCode: code, supplierName: name });
  };

  if (loading) return <div className="h-screen grid place-items-center bg-slate-100">Đang tải...</div>;

  return (
    <ModuleFrame title="Mua hàng & Nhà cung cấp" subtitle="GĐ3 - PR, báo giá, PO và nhận hàng" role={user?.role}>
      <ModuleTabs active={active} onChange={setActive} tabs={[{ id: "requests", label: "Yêu cầu mua", icon: "assignment" }, { id: "quotes", label: "So sánh giá", icon: "compare_arrows" }, { id: "orders", label: "Đơn mua hàng", icon: "local_shipping" }]} />
      {message && <p className="mb-4 px-4 py-3 rounded-lg border border-blue-100 bg-blue-50 text-sm text-blue-700">{message}</p>}

      {active === "requests" && (
        <div className="grid xl:grid-cols-[360px_1fr] gap-5">
          {canCreate && (
            <form onSubmit={createRequest} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 h-fit shadow-sm">
              <h2 className="font-bold text-slate-800">Tạo yêu cầu mua</h2>
              
              <Field label="Cửa hàng">
                <select
                  value={requestForm.branchCode}
                  onChange={(e) => setRequestForm({ ...requestForm, branchCode: e.target.value })}
                  className="control"
                  required
                >
                  {storeOptions.map((option) => (
                    <option key={option.code} value={option.code}>
                      {storeLabel(option.code)}
                    </option>
                  ))}
                </select>
              </Field>
              
              <Field label="Ngày cần hàng">
                <DateInput value={requestForm.neededDate} onChange={(neededDate) => setRequestForm({ ...requestForm, neededDate })} className="mt-1.5" required ariaLabel="Ngày cần hàng" />
              </Field>
              
              <Field label="Mặt hàng">
                <select value={requestForm.itemId} onChange={(e) => setRequestForm({ ...requestForm, itemId: e.target.value })} className="control" required>
                  <option value="">Chọn mặt hàng</option>
                  {data.items.map((item) => (
                    <option key={item.id} value={item.id}>{item.code} - {item.name}{item.requiresImage ? " *cần hình" : ""}</option>
                  ))}
                </select>
              </Field>
              <Field label={selectedItem?.requiresImage ? "URL hình ảnh *" : "URL hình ảnh"}>
                <input
                  value={requestForm.imageUrl}
                  onChange={(e) => setRequestForm({ ...requestForm, imageUrl: e.target.value })}
                  className="control"
                  placeholder="https://... hoặc mã ảnh nội bộ"
                  required={Boolean(selectedItem?.requiresImage)}
                />
                {selectedItem && ["TOOL", "ASSET"].includes(selectedItem.itemType) && (
                  <p className="mt-1 text-[11px] font-semibold text-amber-600">Mặt hàng này sẽ tự tạo hồ sơ tài sản/CCDC khi nhận PO.</p>
                )}
              </Field>
              
              <div className="grid grid-cols-2 gap-3">
                <Field label="Số lượng">
                  <input type="number" min="0.01" step="0.01" value={requestForm.quantity} onChange={(e) => setRequestForm({ ...requestForm, quantity: e.target.value })} className="control" />
                </Field>
                <Field label="Giá dự kiến">
                  <input type="number" value={requestForm.estimatedUnitCost} onChange={(e) => setRequestForm({ ...requestForm, estimatedUnitCost: e.target.value })} className="control" />
                </Field>
              </div>
              
              <Field label="Lý do">
                <textarea value={requestForm.reason} onChange={(e) => setRequestForm({ ...requestForm, reason: e.target.value })} className="control h-20 resize-none" required />
              </Field>
              
              <button className="primary-button w-full">
                <span className="material-symbols-outlined text-lg">add</span>Tạo PR
              </button>
            </form>
          )}

          <section className="table-panel shadow-sm">
            <PanelTitle title="Danh sách PR" onReload={loadData} />
            <Table
              headers={[
                { label: "Yêu cầu" },
                { label: "Nội dung" },
                { label: "Giá dự kiến", align: "right" },
                { label: "Trạng thái" },
                { label: "Thao tác", align: "right" },
              ]}
            >
              {data.requests.map((request) => (
                <tr key={request.id} className="border-t border-slate-100">
                  <td className="cell">
                    <b>{request.code}</b>
                    <small>{new Date(request.requestDate).toLocaleDateString("vi-VN")} · {request.branchCode}</small>
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
                  <td className="cell text-right space-x-2">
                    {canApprove && request.status === "PENDING_APPROVAL" && (
                      <>
                        <button onClick={() => void send("PATCH", { action: "APPROVE_REQUEST", requestId: request.id }, "Đã duyệt PR.")} className="action-link text-emerald-700 hover:underline">Duyệt</button>
                        <button onClick={() => void send("PATCH", { action: "REJECT_REQUEST", requestId: request.id }, "Đã từ chối PR.")} className="action-link text-rose-700 hover:underline">Từ chối</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
          </section>
        </div>
      )}

      {active === "quotes" && (
        <div className="grid xl:grid-cols-[360px_1fr] gap-5">
          {canCreate && (
            <form onSubmit={addQuote} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 h-fit shadow-sm">
              <h2 className="font-bold text-slate-800">Nhập báo giá</h2>
              
              <Field label="Yêu cầu mua">
                <select value={quoteForm.requestId} onChange={(e) => setQuoteForm({ ...quoteForm, requestId: e.target.value })} className="control">
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
              
              <button className="primary-button w-full">
                <span className="material-symbols-outlined text-lg">add</span>Thêm báo giá
              </button>
            </form>
          )}

          <section className="space-y-4">
            {data.requests.filter((request) => request.quotes.length > 0).map((request) => (
              <div key={request.id} className="bg-white border border-slate-200 rounded-lg overflow-hidden shadow-sm">
                <div className="px-5 py-4 border-b border-slate-200 flex justify-between items-center">
                  <div>
                    <b>{request.code} - {request.reason}</b>
                    <p className="text-xs text-slate-500 mt-1">{request.lines.length} mặt hàng</p>
                  </div>
                  
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-slate-600">Kho nhận:</span>
                    <select
                      value={warehouseCode}
                      onChange={(e) => setWarehouseCode(e.target.value)}
                      className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm w-36 focus:border-blue-500 outline-none"
                    >
                      <option value="KHO_HCM">Kho Cửa hàng 1</option>
                      <option value="KHO_HN">Kho Cửa hàng 2</option>
                    </select>
                  </div>
                </div>
                
                <Table
                  headers={[
                    { label: "Nhà cung cấp" },
                    { label: "Tổng báo giá", align: "right" },
                    { label: "Giao hàng" },
                    { label: "Điều khoản" },
                    { label: "Thao tác", align: "right" },
                  ]}
                >
                  {request.quotes.map((quote) => (
                    <tr key={quote.id} className="border-t border-slate-100">
                      <td className="cell">
                        <b>{quote.supplierName}</b>
                        <small>{quote.supplierCode}</small>
                      </td>
                      <td className="cell font-bold text-right text-indigo-950">
                        {money(quote.totalAmount)} đ
                      </td>
                      <td className="cell">{quote.deliveryDays || "-"} ngày</td>
                      <td className="cell">{quote.paymentTerms || "-"}</td>
                      <td className="cell text-right space-x-2">
                        {canApprove && (
                          <button onClick={() => void send("PATCH", { action: "SELECT_QUOTE", quoteId: quote.id }, "Đã chọn báo giá.")} className="action-link hover:underline text-indigo-700">
                            {quote.isSelected ? "Đã chọn" : "Chọn"}
                          </button>
                        )}
                        {canCreate && (
                          <button onClick={() => void createOrder(request, quote)} className="action-link text-blue-700 hover:underline">
                            Tạo PO
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </Table>
              </div>
            ))}
          </section>
        </div>
      )}

      {active === "orders" && (
        <section className="table-panel shadow-sm">
          <PanelTitle title="Đơn mua hàng" onReload={loadData} />
          <Table
            headers={[
              { label: "PO" },
              { label: "Nhà cung cấp" },
              { label: "Giá trị", align: "right" },
              { label: "Tiến độ nhận" },
              { label: "Tài sản/Ảnh" },
              { label: "Công nợ", align: "right" },
              { label: "Thao tác", align: "right" },
            ]}
          >
            {data.orders.map((order) => {
              const ordered = order.lines.reduce((sum, line) => sum + line.orderedQuantity, 0);
              const received = order.lines.reduce((sum, line) => sum + line.receivedQuantity, 0);
              return (
                <tr key={order.id} className="border-t border-slate-100">
                  <td className="cell">
                    <b>{order.code}</b>
                    <small>{order.branchCode} · {order.warehouseCode}</small>
                  </td>
                  <td className="cell">
                    <b>{order.supplierName}</b>
                    <small>{new Date(order.orderDate).toLocaleDateString("vi-VN")}</small>
                  </td>
                  <td className="cell text-right font-bold text-slate-900">
                    {money(order.totalAmount)} đ
                  </td>
                  <td className="cell">
                    <b>{received}/{ordered}</b>
                    <small><span className={`status ${statusStyle(order.status)}`}>{order.status}</span></small>
                  </td>
                  <td className="cell">
                    <b>{order.lines.filter((line) => ["TOOL", "ASSET"].includes(line.item.itemType)).length} dòng</b>
                    <small>{order.lines.some((line) => line.imageUrl) ? "Có hình ảnh" : "Chưa có hình"}</small>
                  </td>
                  <td className="cell text-right font-semibold text-rose-700">
                    {money(order.payable?.outstandingAmount || 0)} đ
                  </td>
                  <td className="cell text-right space-x-2">
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
                  </td>
                </tr>
              );
            })}
          </Table>
        </section>
      )}
    </ModuleFrame>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block text-xs font-bold text-slate-600">{label}{children}</label>; }
function PanelTitle({ title, onReload }: { title: string; onReload: () => void }) { return <div className="p-5 flex items-center justify-between"><h2 className="font-bold">{title}</h2><button type="button" title="Tải lại" onClick={onReload} className="icon-button"><span className="material-symbols-outlined text-lg">refresh</span></button></div>; }

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
