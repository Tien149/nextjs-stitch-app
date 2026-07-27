"use client";

import { useEffect, useState } from "react";
import { ModuleFrame, ModuleTabs } from "@/components/ModuleFrame";
import { storeLabel, storeOptions } from "@/lib/branch-labels";
import { canPerformMenuAction, SESSION_KEY } from "@/lib/auth-demo";
import { useModuleAuth } from "@/lib/use-module-auth";

type UnitConversion = { id: string; unitCode: string; unitName: string | null; conversionRate: number; isDefaultPurchase: boolean };
type Item = { id: string; code: string; name: string; unit: string; itemType: string; minStock: number; requiresImage: boolean; unitConversions?: UnitConversion[] };
type Balance = { id: string; warehouseCode: string; quantity: number; averageCost: number; item: Item };
type Transaction = { id: string; code: string; transactionType: string; transactionDate: string; warehouseCode: string; toWarehouseCode: string | null; referenceCode: string | null; lines: Array<{ id: string; inputQuantity: number | null; inputUnitCode: string | null; conversionRate: number; quantity: number; unitCost: number; inputUnitCost: number | null; totalCost: number; item: Item }> };
type Recipe = { id: string; code: string; productCode: string; productName: string; sellingPrice: number; estimatedCost: number; version: number; lines: Array<{ quantity: number; wasteRate: number; item: Item }> };
type Warehouse = { id: string; code: string; name: string; branch: string | null };
type MovementByType = Record<string, { inbound: number; outbound: number; value: number }>;
type StockSummary = { item: Item; warehouseCode: string; openingQuantity: number; inboundQuantity: number; outboundQuantity: number; closingQuantity: number; averageCost: number; closingValue: number; movementByType?: MovementByType };
type StockMovement = { transactionId: string; code: string; transactionType: string; transactionDate: string; warehouseCode: string; toWarehouseCode: string | null; itemCode: string; itemName: string; unit: string; quantity: number; inboundQuantity: number; outboundQuantity: number; value: number; referenceCode: string | null };
type Stocktake = { id: string; code: string; stocktakeDate: string; branchCode: string; warehouseCode: string; status: string; lines: Array<{ id: string; systemQuantity: number; actualQuantity: number; varianceQuantity: number; item: Item }> };
type StocktakeDraftRow = { itemId: string; itemCode: string; itemName: string; unit: string; systemQuantity: number; actualQuantity: string; reason: string };
type Data = { items: Item[]; balances: Balance[]; transactions: Transaction[]; recipes: Recipe[]; warehouses: Warehouse[]; stocktakes: Stocktake[]; stockSummary: StockSummary[]; stockMovements: StockMovement[] };
const money = (value: number) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(value);
const movementTypes = ["NHAP_MUA", "NHAP_KHAC", "NHAP_CHE_BIEN", "NHAP_KIEM_KE", "XUAT_BAN", "XUAT_HUY", "XUAT_KHAC", "XUAT_CHE_BIEN", "XUAT_KIEM_KE", "DIEU_CHUYEN"];

function buildStocktakeRows(warehouseCode: string, balances: Balance[], fallbackItems: Item[]): StocktakeDraftRow[] {
  const rows = balances
    .filter((balance) => balance.warehouseCode === warehouseCode)
    .map((balance) => ({
      itemId: balance.item.id,
      itemCode: balance.item.code,
      itemName: balance.item.name,
      unit: balance.item.unit,
      systemQuantity: balance.quantity,
      actualQuantity: String(balance.quantity),
      reason: "",
    }));
  if (rows.length > 0) return rows;
  return fallbackItems.slice(0, 20).map((item) => ({
    itemId: item.id,
    itemCode: item.code,
    itemName: item.name,
    unit: item.unit,
    systemQuantity: 0,
    actualQuantity: "0",
    reason: "",
  }));
}

export default function InventoryPage() {
  const href = "/inventory";
  const { user, loading } = useModuleAuth(href);
  const [active, setActive] = useState("stock");
  const [data, setData] = useState<Data>({ items: [], balances: [], transactions: [], recipes: [], warehouses: [], stocktakes: [], stockSummary: [], stockMovements: [] });
  const [message, setMessage] = useState("");
  const [reportWarehouse, setReportWarehouse] = useState("ALL");
  const [reportType, setReportType] = useState("ALL");
  
  const [itemForm, setItemForm] = useState({ code: "NVL_001", name: "Nguyên liệu mẫu", unit: "g", itemType: "RAW_MATERIAL", purchaseUnit: "kg", conversionRate: "1000", minStock: "500", requiresImage: false });
  const [conversionForm, setConversionForm] = useState({ itemId: "", purchaseUnit: "thung", conversionRate: "24", note: "" });
  const [stockForm, setStockForm] = useState({ transactionType: "NHAP_MUA", branchCode: "HCM", warehouseCode: "KHO_HCM", toWarehouseCode: "KHO_HN", itemId: "", inputUnitCode: "", quantity: "10", unitCost: "100000", referenceCode: "", note: "Nhap kho van hanh" });
  const [recipeForm, setRecipeForm] = useState({ productCode: "SP_COMBO01", productName: "Combo ban POS", sellingPrice: "45000", itemId: "", quantity: "0.02", wasteRate: "3" });
  const [recipeRows, setRecipeRows] = useState([{ itemId: "", quantity: "1", wasteRate: "0" }, { itemId: "", quantity: "20", wasteRate: "5" }]);
  const [productionForm, setProductionForm] = useState({ productCode: "BTP_SOTCACHUA", productQuantity: "2", branchCode: "HCM", warehouseCode: "KHO_HCM", toWarehouseCode: "KHO_HCM", referenceCode: "", note: "Che bien ban thanh pham" });
  const [stocktakeForm, setStocktakeForm] = useState({ branchCode: "HCM", warehouseCode: "KHO_HCM", itemId: "", actualQuantity: "0", reason: "Kiem ke thuc te" });
  const [stocktakeRows, setStocktakeRows] = useState<StocktakeDraftRow[]>([]);
  const [wasteForm, setWasteForm] = useState({ recipeId: "", productQuantity: "1", branchCode: "HCM", warehouseCode: "KHO_HCM", referenceCode: "", note: "Hủy hàng theo báo cáo POS" });
  
  const canCreate = user ? canPerformMenuAction(user.role, href, "create") : false;
  const selectedStockItem = data.items.find((item) => item.id === stockForm.itemId);
  const stockUnits = selectedStockItem?.unitConversions?.length
    ? selectedStockItem.unitConversions
    : selectedStockItem
      ? [{ id: "base", unitCode: selectedStockItem.unit.toUpperCase(), unitName: selectedStockItem.unit, conversionRate: 1, isDefaultPurchase: true }]
      : [];
  const selectedStockUnit = stockUnits.find((unit) => unit.unitCode === stockForm.inputUnitCode) || stockUnits[0];
  const stockInputQuantity = Number(stockForm.quantity || 0);
  const stockConversionRate = selectedStockUnit?.conversionRate || 1;
  const stockBaseQuantity = stockInputQuantity * stockConversionRate;
  const stockInputUnitCost = Number(stockForm.unitCost || 0);
  const stockBaseUnitCost = stockInputUnitCost > 0 ? stockInputUnitCost / stockConversionRate : 0;
  const stockLineValue = stockInputUnitCost * stockInputQuantity;
  const warehouseOptions = data.warehouses.length ? data.warehouses : [
    { id: "KHO_HCM", code: "KHO_HCM", name: "Kho Cua hang 1", branch: "HCM" },
    { id: "KHO_HN", code: "KHO_HN", name: "Kho Cua hang 2", branch: "HN" },
  ];
  const sourceWarehouseOptions = warehouseOptions.filter((warehouse) => warehouse.branch === stockForm.branchCode || !warehouse.branch);
  const filteredStockSummary = data.stockSummary.filter((row) => {
    if (reportWarehouse !== "ALL" && row.warehouseCode !== reportWarehouse) return false;
    if (reportType !== "ALL") {
      const movement = row.movementByType?.[reportType];
      return !!movement && (movement.inbound > 0 || movement.outbound > 0);
    }
    return true;
  });
  const filteredStockMovements = data.stockMovements.filter((row) => {
    if (reportWarehouse !== "ALL" && row.warehouseCode !== reportWarehouse) return false;
    if (reportType !== "ALL" && row.transactionType !== reportType) return false;
    return true;
  }).slice(-100).reverse();

  const getSessionHeaders = (): Record<string, string> => {
    if (typeof window === "undefined") return {};
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? { "x-demo-session": encodeURIComponent(raw) } : {};
  };

  const loadData = async () => {
    const response = await fetch("/api/inventory", {
      headers: getSessionHeaders(),
    });
    if (!response.ok) return;
    const payload = await response.json() as Data;
    setData(payload);
    const firstItem = payload.items[0]?.id || "";
    const firstRecipe = payload.recipes[0]?.id || "";
    setStockForm((form) => {
      const item = payload.items.find((candidate) => candidate.id === (form.itemId || firstItem));
      const defaultUnit = item?.unitConversions?.[0]?.unitCode || item?.unit.toUpperCase() || "";
      return { ...form, itemId: form.itemId || firstItem, inputUnitCode: form.inputUnitCode || defaultUnit };
    });
    setRecipeForm((form) => ({ ...form, itemId: form.itemId || firstItem }));
    setRecipeRows((rows) => rows.map((row) => ({ ...row, itemId: row.itemId || firstItem })));
    setStocktakeForm((form) => ({ ...form, itemId: form.itemId || firstItem }));
    setStocktakeRows(buildStocktakeRows(stocktakeForm.warehouseCode, payload.balances, payload.items));
    setWasteForm((form) => ({ ...form, recipeId: form.recipeId || firstRecipe }));
    setConversionForm((form) => ({ ...form, itemId: form.itemId || firstItem }));
  };

  useEffect(() => { if (!loading) window.setTimeout(() => void loadData(), 0); }, [loading]);

  const send = async (body: object, success: string) => {
    setMessage("");
    const response = await fetch("/api/inventory", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...getSessionHeaders(),
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    setMessage(response.ok ? success : payload.error || "Không thực hiện được thao tác");
    if (response.ok) await loadData();
  };

  const totalSKUs = data.items.length;
  const lowStockCount = data.balances.filter((b) => b.quantity < (b.item.minStock || 0)).length;
  const totalStockValue = data.balances.reduce((sum, b) => sum + b.quantity * b.averageCost, 0);
  const totalTransactions = data.transactions.length;

  if (loading) return <div className="h-screen grid place-items-center bg-slate-100">Đang tải...</div>;
  
  return (
    <ModuleFrame title="Kho & Định lượng" subtitle="Giai đoạn 3 • Quản lý kho hàng, tính giá bình quân, công thức định lượng và hủy hàng" role={user?.role}>
      {/* Operational Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500">Tổng mã hàng (SKUs)</span>
            <span className="material-symbols-outlined text-blue-500 text-xl">inventory_2</span>
          </div>
          <p className="text-lg font-bold text-slate-800 mt-1">{totalSKUs} mặt hàng</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500">Cảnh báo dưới Min</span>
            <span className="material-symbols-outlined text-rose-500 text-xl">warning</span>
          </div>
          <p className="text-lg font-bold text-rose-600 mt-1">{lowStockCount} mặt hàng</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500">Tổng giá trị tồn kho</span>
            <span className="material-symbols-outlined text-emerald-500 text-xl">payments</span>
          </div>
          <p className="text-lg font-bold text-emerald-600 mt-1">{money(totalStockValue)} đ</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500">Tổng giao dịch kho</span>
            <span className="material-symbols-outlined text-indigo-500 text-xl">swap_horiz</span>
          </div>
          <p className="text-lg font-bold text-indigo-600 mt-1">{totalTransactions} giao dịch</p>
        </div>
      </div>

      <ModuleTabs active={active} onChange={setActive} tabs={[{ id: "stock", label: "Tồn kho", icon: "inventory" }, { id: "transactions", label: "Nhập / Xuất", icon: "swap_horiz" }, { id: "items", label: "Mặt hàng", icon: "category" }, { id: "recipes", label: "Định lượng", icon: "menu_book" }, { id: "production", label: "Chế biến", icon: "blender" }, { id: "stocktake", label: "Kiểm kê", icon: "fact_check" }, { id: "waste", label: "Hủy hàng", icon: "delete_sweep" }]} />
      {message && <p className="mb-4 px-4 py-3 rounded-lg border border-blue-100 bg-blue-50 text-sm text-blue-700">{message}</p>}

      {active === "stock" && (
        <section className="table-panel shadow-sm mb-5">
          <Panel title="Nhập - Xuất - Tồn cơ bản theo kho" reload={loadData} />
          <div className="px-5 pb-4 grid sm:grid-cols-2 gap-3">
            <Input label="Kho">
              <select className="control" value={reportWarehouse} onChange={(e) => setReportWarehouse(e.target.value)}>
                <option value="ALL">Tất cả kho</option>
                {warehouseOptions.map((warehouse) => <option key={warehouse.code} value={warehouse.code}>{warehouse.name || warehouse.code}</option>)}
              </select>
            </Input>
            <Input label="Loại giao dịch">
              <select className="control" value={reportType} onChange={(e) => setReportType(e.target.value)}>
                <option value="ALL">Tất cả loại</option>
                {movementTypes.map((type) => <option key={type} value={type}>{movementTypeLabel(type)}</option>)}
              </select>
            </Input>
          </div>
          <Table
            headers={[
              { label: "Mặt hàng" },
              { label: "Kho" },
              { label: "Đầu kỳ", align: "right" },
              { label: "Nhập", align: "right" },
              { label: "Xuất", align: "right" },
              { label: "Cuối kỳ", align: "right" },
              { label: "Giá bình quân", align: "right" },
              { label: "Giá trị tồn", align: "right" },
            ]}
          >
            {(filteredStockSummary.length ? filteredStockSummary : data.balances.filter((row) => reportWarehouse === "ALL" || row.warehouseCode === reportWarehouse).map((row) => ({
              item: row.item,
              warehouseCode: row.warehouseCode,
              openingQuantity: row.quantity,
              inboundQuantity: 0,
              outboundQuantity: 0,
              closingQuantity: row.quantity,
              averageCost: row.averageCost,
              closingValue: row.quantity * row.averageCost,
              movementByType: {},
            }))).map((row) => (
              <tr key={`nxt-${row.item.id}-${row.warehouseCode}`} className="border-t border-slate-100">
                <Cell>
                  <b>{row.item.code} - {row.item.name}</b>
                  <small>{row.item.unit}</small>
                </Cell>
                <Cell>{row.warehouseCode}</Cell>
                <Cell right>{money(row.openingQuantity)}</Cell>
                <Cell right>{money(row.inboundQuantity)}</Cell>
                <Cell right>{money(row.outboundQuantity)}</Cell>
                <Cell right><b>{money(row.closingQuantity)}</b></Cell>
                <Cell right>{money(row.averageCost)} đ</Cell>
                <Cell right><b>{money(row.closingValue)} đ</b></Cell>
              </tr>
            ))}
          </Table>
        </section>
      )}

      {active === "stock" && (
        <section className="table-panel shadow-sm mb-5">
          <Panel title="Chi tiết phát sinh theo loại giao dịch" reload={loadData} />
          <Table
            headers={[
              { label: "Ngày" },
              { label: "Chứng từ" },
              { label: "Loại" },
              { label: "Kho" },
              { label: "Mặt hàng" },
              { label: "Nhập", align: "right" },
              { label: "Xuất", align: "right" },
              { label: "Giá trị", align: "right" },
            ]}
          >
            {filteredStockMovements.map((row) => (
              <tr key={`${row.transactionId}-${row.itemCode}-${row.warehouseCode}-${row.inboundQuantity}-${row.outboundQuantity}`} className="border-t border-slate-100">
                <Cell>{new Date(row.transactionDate).toLocaleDateString("vi-VN")}</Cell>
                <Cell><b>{row.code}</b><small>{row.referenceCode || "-"}</small></Cell>
                <Cell><span className="status bg-slate-100">{movementTypeLabel(row.transactionType)}</span></Cell>
                <Cell>{row.warehouseCode}</Cell>
                <Cell><b>{row.itemCode}</b><small>{row.itemName}</small></Cell>
                <Cell right>{row.inboundQuantity ? `${money(row.inboundQuantity)} ${row.unit}` : "-"}</Cell>
                <Cell right>{row.outboundQuantity ? `${money(row.outboundQuantity)} ${row.unit}` : "-"}</Cell>
                <Cell right>{money(row.value)} đ</Cell>
              </tr>
            ))}
          </Table>
        </section>
      )}

      {active === "stock" && (
        <section className="table-panel shadow-sm">
          <Panel title="Tồn kho theo kho" reload={loadData} />
          <Table
            headers={[
              { label: "Mặt hàng" },
              { label: "Kho" },
              { label: "Số lượng", align: "right" },
              { label: "Giá bình quân", align: "right" },
              { label: "Giá trị", align: "right" },
              { label: "Cảnh báo" },
            ]}
          >
            {data.balances.map((row) => (
              <tr key={row.id} className="border-t border-slate-100">
                <Cell>
                  <b>{row.item.code} - {row.item.name}</b>
                  <small>{row.item.itemType} · {row.item.unit}</small>
                </Cell>
                <Cell>{row.warehouseCode}</Cell>
                <Cell right><b>{money(row.quantity)}</b> {row.item.unit}</Cell>
                <Cell right>{money(row.averageCost)} đ</Cell>
                <Cell right><b>{money(row.quantity * row.averageCost)} đ</b></Cell>
                <Cell>{row.quantity < row.item.minStock ? <span className="status bg-rose-50 text-rose-700">Dưới định mức</span> : <span className="status bg-emerald-50 text-emerald-700">Đủ tồn</span>}</Cell>
              </tr>
            ))}
          </Table>
        </section>
      )}

      {active === "items" && (
        <div className="grid lg:grid-cols-[360px_1fr] gap-5">
          {canCreate && (
            <div className="space-y-4">
            <form onSubmit={(e) => { e.preventDefault(); void send({ action: "CREATE_ITEM", ...itemForm }, "Đã tạo mặt hàng."); }} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 h-fit shadow-sm">
              <h2 className="font-bold text-slate-800">Thêm mặt hàng</h2>
              
              <Input label="Mã">
                <input data-input-kind="code" className="control" value={itemForm.code} onChange={(e) => setItemForm({ ...itemForm, code: e.target.value })} />
              </Input>
              
              <Input label="Tên">
                <input className="control" value={itemForm.name} onChange={(e) => setItemForm({ ...itemForm, name: e.target.value })} />
              </Input>
              
              <div className="grid grid-cols-2 gap-3">
                <Input label="Đơn vị">
                  <input className="control" value={itemForm.unit} onChange={(e) => setItemForm({ ...itemForm, unit: e.target.value })} />
                </Input>
                <Input label="Tồn tối thiểu">
                  <input type="number" className="control" value={itemForm.minStock} onChange={(e) => setItemForm({ ...itemForm, minStock: e.target.value })} />
                </Input>
              </div>
              
              <Input label="Loại">
                <select className="control" value={itemForm.itemType} onChange={(e) => setItemForm({ ...itemForm, itemType: e.target.value })}>
                  <option value="RAW_MATERIAL">Nguyên liệu thô</option>
                  <option value="SEMI_FINISHED">Bán thành phẩm</option>
                  <option value="FINISHED">Thành phẩm</option>
                  <option value="PACKAGING">Bao bì</option>
                  <option value="TOOL">CCDC</option>
                  <option value="ASSET">Tài sản</option>
                </select>
              </Input>

              <div className="grid grid-cols-2 gap-3">
                <Input label="ĐVT mua">
                  <input className="control" value={itemForm.purchaseUnit} onChange={(e) => setItemForm({ ...itemForm, purchaseUnit: e.target.value })} placeholder="vd: thùng, kg, bao" />
                </Input>
                <Input label="Tỷ lệ quy đổi">
                  <input type="number" min="1" step="0.001" className="control" value={itemForm.conversionRate} onChange={(e) => setItemForm({ ...itemForm, conversionRate: e.target.value })} />
                </Input>
              </div>

              <label className="flex items-center gap-2 text-xs font-bold text-slate-600 mt-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={itemForm.requiresImage}
                  onChange={(e) => setItemForm({ ...itemForm, requiresImage: e.target.checked })}
                  className="rounded text-blue-600 focus:ring-blue-500"
                />
                Yêu cầu ảnh khi mua / nhận hàng
              </label>
              
              <button className="primary-button w-full">
                <span className="material-symbols-outlined text-lg">add</span>Thêm mặt hàng
              </button>
            </form>
            <form onSubmit={(e) => { e.preventDefault(); void send({ action: "UPSERT_UNIT_CONVERSION", ...conversionForm }, "Đã cập nhật ĐVT quy đổi."); }} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 h-fit shadow-sm">
              <h2 className="font-bold text-slate-800">Cập nhật ĐVT quy đổi</h2>
              <Input label="Mặt hàng">
                <ItemSelect items={data.items} value={conversionForm.itemId} onChange={(itemId) => setConversionForm({ ...conversionForm, itemId })} />
              </Input>
              <div className="grid grid-cols-2 gap-3">
                <Input label="ĐVT mua">
                  <input className="control" value={conversionForm.purchaseUnit} onChange={(e) => setConversionForm({ ...conversionForm, purchaseUnit: e.target.value })} />
                </Input>
                <Input label="Tỷ lệ quy đổi">
                  <input type="number" min="1" step="0.001" className="control" value={conversionForm.conversionRate} onChange={(e) => setConversionForm({ ...conversionForm, conversionRate: e.target.value })} />
                </Input>
              </div>
              <Input label="Ghi chú">
                <input className="control" value={conversionForm.note} onChange={(e) => setConversionForm({ ...conversionForm, note: e.target.value })} />
              </Input>
              <button className="primary-button w-full">
                <span className="material-symbols-outlined text-lg">sync_alt</span>Lưu quy đổi
              </button>
            </form>
            </div>
          )}
          
          <section className="table-panel shadow-sm">
            <Panel title="Danh mục mặt hàng" reload={loadData} />
            <Table
              headers={[
                { label: "Mã" },
                { label: "Tên" },
                { label: "Loại" },
                { label: "Đơn vị" },
                { label: "Quy đổi mua" },
                { label: "Tồn tối thiểu", align: "right" },
                { label: "Yêu cầu ảnh" },
              ]}
            >
              {data.items.map((item) => (
                <tr key={item.id} className="border-t border-slate-100">
                  <Cell><b>{item.code}</b></Cell>
                  <Cell>{item.name}</Cell>
                  <Cell>{item.itemType}</Cell>
                  <Cell>{item.unit}</Cell>
                  <Cell>{item.unitConversions?.filter((unit) => unit.conversionRate > 1).map((unit) => `1 ${unit.unitName || unit.unitCode} = ${money(unit.conversionRate)} ${item.unit}`).join(", ") || "-"}</Cell>
                  <Cell right>{money(item.minStock)}</Cell>
                  <Cell>
                    {item.requiresImage ? (
                      <span className="status bg-indigo-50 text-indigo-700 font-bold px-2 py-0.5 rounded text-[11px]">Bắt buộc</span>
                    ) : (
                      <span className="text-slate-400">-</span>
                    )}
                  </Cell>
                </tr>
              ))}
            </Table>
          </section>
        </div>
      )}

      {active === "transactions" && (
        <div className="grid lg:grid-cols-[380px_1fr] gap-5">
          {canCreate && (
            <form onSubmit={(e) => { e.preventDefault(); void send({ action: "STOCK_TRANSACTION", ...stockForm, lines: [{ itemId: stockForm.itemId, inputQuantity: stockForm.quantity, inputUnitCode: stockForm.inputUnitCode || selectedStockUnit?.unitCode, inputUnitCost: stockForm.unitCost }] }, "Đã ghi nhận giao dịch kho."); }} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 h-fit shadow-sm">
              <h2 className="font-bold text-slate-800">Ghi nhận nhập / xuất</h2>
              
              <Input label="Loại">
                <select className="control" value={stockForm.transactionType} onChange={(e) => setStockForm({ ...stockForm, transactionType: e.target.value })}>
                  <option value="NHAP_MUA">Nhập mua</option>
                  <option value="NHAP_KHAC">Nhập khác</option>
                  <option value="XUAT_HUY">Xuất hủy / Hao hụt</option>
                  <option value="XUAT_KHAC">Xuất khác</option>
                  <option value="DIEU_CHUYEN">Điều chuyển kho</option>
                </select>
              </Input>
              
              <Input label="Mặt hàng">
                <ItemSelect items={data.items} value={stockForm.itemId} onChange={(itemId) => {
                  const item = data.items.find((candidate) => candidate.id === itemId);
                  setStockForm({ ...stockForm, itemId, inputUnitCode: item?.unitConversions?.[0]?.unitCode || item?.unit.toUpperCase() || "" });
                }} />
              </Input>
              
              <div className="grid grid-cols-2 gap-3">
                <Input label="Cửa hàng">
                  <select
                    value={stockForm.branchCode}
                    onChange={(e) => setStockForm({ ...stockForm, branchCode: e.target.value })}
                    className="control"
                  >
                    {storeOptions.map((option) => (
                      <option key={option.code} value={option.code}>
                        {storeLabel(option.code)}
                      </option>
                    ))}
                  </select>
                </Input>
                <Input label="Kho">
                  <select
                    value={stockForm.warehouseCode}
                    onChange={(e) => setStockForm({ ...stockForm, warehouseCode: e.target.value })}
                    className="control"
                  >
                    {sourceWarehouseOptions.map((warehouse) => (
                      <option key={warehouse.code} value={warehouse.code}>{warehouse.name || warehouse.code}</option>
                    ))}
                  </select>
                </Input>
              </div>

              {stockForm.transactionType === "DIEU_CHUYEN" && (
                <Input label="Kho nhan">
                  <select
                    value={stockForm.toWarehouseCode}
                    onChange={(e) => setStockForm({ ...stockForm, toWarehouseCode: e.target.value })}
                    className="control"
                  >
                    {warehouseOptions.map((warehouse) => (
                      <option key={warehouse.code} value={warehouse.code}>{warehouse.name || warehouse.code}</option>
                    ))}
                  </select>
                </Input>
              )}
              
              <div className="grid grid-cols-3 gap-3">
                <Input label="Số lượng">
                  <input type="number" step="0.01" className="control" value={stockForm.quantity} onChange={(e) => setStockForm({ ...stockForm, quantity: e.target.value })} />
                </Input>
                <Input label="DVT">
                  <select className="control" value={stockForm.inputUnitCode || selectedStockUnit?.unitCode || ""} onChange={(e) => setStockForm({ ...stockForm, inputUnitCode: e.target.value })}>
                    {stockUnits.map((unit) => (
                      <option key={unit.unitCode} value={unit.unitCode}>{unit.unitName || unit.unitCode}</option>
                    ))}
                  </select>
                </Input>
                <Input label="Đơn giá nhập">
                  <input type="number" className="control" value={stockForm.unitCost} onChange={(e) => setStockForm({ ...stockForm, unitCost: e.target.value })} />
                </Input>
              </div>

              {selectedStockItem && (
                <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                  <b>Preview:</b> {money(stockInputQuantity)} {selectedStockUnit?.unitName || selectedStockUnit?.unitCode || selectedStockItem.unit}
                  {" = "}
                  {money(stockBaseQuantity)} {selectedStockItem.unit}
                  {stockBaseUnitCost > 0 ? ` · Don gia quy doi ${money(stockBaseUnitCost)} d/${selectedStockItem.unit} · Thanh tien ${money(stockLineValue)} d` : ""}
                </div>
              )}
              
              <Input label="Tham chiếu">
                <input data-input-kind="code" className="control" value={stockForm.referenceCode} onChange={(e) => setStockForm({ ...stockForm, referenceCode: e.target.value })} />
              </Input>
              
              <button className="primary-button w-full">Ghi nhận</button>
            </form>
          )}
          
          <section className="table-panel shadow-sm">
            <Panel title="Thẻ kho gần nhất" reload={loadData} />
            <Table
              headers={[
                { label: "Chứng từ" },
                { label: "Loại" },
                { label: "Kho" },
                { label: "Mặt hàng" },
                { label: "Giá trị", align: "right" },
              ]}
            >
              {data.transactions.map((row) => (
                <tr key={row.id} className="border-t border-slate-100">
                  <Cell><b>{row.code}</b><small>{new Date(row.transactionDate).toLocaleDateString("vi-VN")}</small></Cell>
                  <Cell><span className="status bg-slate-100">{movementTypeLabel(row.transactionType)}</span></Cell>
                  <Cell>{row.toWarehouseCode ? `${row.warehouseCode} -> ${row.toWarehouseCode}` : row.warehouseCode}</Cell>
                  <Cell>{row.lines.map((line) => `${line.item.name}: ${money(line.inputQuantity || line.quantity)} ${line.inputUnitCode || line.item.unit} = ${money(line.quantity)} ${line.item.unit}`).join(", ")}</Cell>
                  <Cell right><b>{money(row.lines.reduce((sum, line) => sum + line.totalCost, 0))} đ</b></Cell>
                </tr>
              ))}
            </Table>
          </section>
        </div>
      )}

      {active === "recipes" && (
        <div className="grid lg:grid-cols-[380px_1fr] gap-5">
          {canCreate && (
            <form onSubmit={(e) => { e.preventDefault(); void send({ action: "CREATE_RECIPE", ...recipeForm, lines: recipeRows.filter((row) => row.itemId).map((row) => ({ itemId: row.itemId, quantity: row.quantity, wasteRate: row.wasteRate })) }, "Đã tạo phiên bản định lượng mới."); }} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 h-fit shadow-sm">
              <h2 className="font-bold text-slate-800">Tạo định lượng</h2>
              
              <div className="grid grid-cols-2 gap-3">
                <Input label="Mã món">
                  <input data-input-kind="code" className="control" value={recipeForm.productCode} onChange={(e) => setRecipeForm({ ...recipeForm, productCode: e.target.value })} />
                </Input>
                <Input label="Giá bán">
                  <input type="number" className="control" value={recipeForm.sellingPrice} onChange={(e) => setRecipeForm({ ...recipeForm, sellingPrice: e.target.value })} />
                </Input>
              </div>
              
              <Input label="Tên món">
                <input className="control" value={recipeForm.productName} onChange={(e) => setRecipeForm({ ...recipeForm, productName: e.target.value })} />
              </Input>
              
              <div className="space-y-4 border border-slate-100 rounded-lg p-3.5 bg-slate-50/50">
                <div className="flex items-center justify-between border-b border-slate-200/60 pb-2">
                  <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Thành phần nguyên liệu</h3>
                  <button type="button" className="text-xs font-bold text-blue-600 hover:underline flex items-center gap-0.5" onClick={() => setRecipeRows([...recipeRows, { itemId: "", quantity: "1", wasteRate: "0" }])}>
                    <span className="material-symbols-outlined text-sm font-bold">add</span>Thêm dòng
                  </button>
                </div>
                {recipeRows.map((row, index) => (
                  <div key={index} className="bg-white border border-slate-200 rounded-xl p-3.5 space-y-3 relative shadow-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Nguyên liệu #{index + 1}</span>
                      {recipeRows.length > 1 && (
                        <button type="button" className="text-xs font-bold text-rose-600 hover:text-rose-700 hover:underline flex items-center gap-0.5" onClick={() => setRecipeRows(recipeRows.filter((_, rowIndex) => rowIndex !== index))}>
                          Xóa
                        </button>
                      )}
                    </div>
                    
                    <div className="flex flex-col gap-1">
                      <span className="text-xs font-bold text-slate-600">Chọn nguyên liệu</span>
                      <ItemSelect items={data.items} value={row.itemId} onChange={(itemId) => setRecipeRows(recipeRows.map((candidate, rowIndex) => rowIndex === index ? { ...candidate, itemId } : candidate))} />
                    </div>
                    
                    <div className="grid grid-cols-2 gap-3">
                      <div className="flex flex-col gap-1">
                        <span className="text-xs font-bold text-slate-600">Định lượng</span>
                        <input type="number" step="0.001" className="control !mt-0" value={row.quantity} onChange={(e) => setRecipeRows(recipeRows.map((candidate, rowIndex) => rowIndex === index ? { ...candidate, quantity: e.target.value } : candidate))} />
                      </div>
                      
                      <div className="flex flex-col gap-1">
                        <span className="text-xs font-bold text-slate-600">Hao hụt (%)</span>
                        <input type="number" step="0.1" className="control !mt-0" value={row.wasteRate} onChange={(e) => setRecipeRows(recipeRows.map((candidate, rowIndex) => rowIndex === index ? { ...candidate, wasteRate: e.target.value } : candidate))} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              
              <button className="primary-button w-full">Lưu phiên bản</button>
            </form>
          )}
          
          <section className="table-panel shadow-sm">
            <Panel title="Cost món theo giá bình quân" reload={loadData} />
            <Table
              headers={[
                { label: "Sản phẩm" },
                { label: "Phiên bản" },
                { label: "Nguyên liệu" },
                { label: "Cost", align: "right" },
                { label: "Giá bán", align: "right" },
                { label: "Tỷ lệ cost", align: "right" },
              ]}
            >
              {data.recipes.map((recipe) => (
                <tr key={recipe.id} className="border-t border-slate-100">
                  <Cell><b>{recipe.productCode} - {recipe.productName}</b></Cell>
                  <Cell>V{recipe.version}</Cell>
                  <Cell>{recipe.lines.map((line) => `${line.item.name}: ${line.quantity} (+${line.wasteRate}%)`).join(", ")}</Cell>
                  <Cell right><b>{money(recipe.estimatedCost)} đ</b></Cell>
                  <Cell right>{money(recipe.sellingPrice)} đ</Cell>
                  <Cell right>{recipe.sellingPrice > 0 ? `${(recipe.estimatedCost / recipe.sellingPrice * 100).toFixed(1)}%` : "-"}</Cell>
                </tr>
              ))}
            </Table>
          </section>
        </div>
      )}

      {active === "production" && (
        <div className="grid lg:grid-cols-[380px_1fr] gap-5">
          {canCreate && (
            <form onSubmit={(e) => { e.preventDefault(); void send({ action: "PRODUCE_SEMI_FINISHED", ...productionForm }, "Đã ghi nhận chế biến bán thành phẩm."); }} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 h-fit shadow-sm">
              <h2 className="font-bold text-slate-800">Chế biến bán thành phẩm</h2>
              <Input label="Mã bán thành phẩm">
                <input data-input-kind="code" className="control" value={productionForm.productCode} onChange={(e) => setProductionForm({ ...productionForm, productCode: e.target.value })} />
              </Input>
              <div className="grid grid-cols-2 gap-3">
                <Input label="Số lượng">
                  <input type="number" step="0.001" className="control" value={productionForm.productQuantity} onChange={(e) => setProductionForm({ ...productionForm, productQuantity: e.target.value })} />
                </Input>
                <Input label="Cửa hàng">
                  <select className="control" value={productionForm.branchCode} onChange={(e) => setProductionForm({ ...productionForm, branchCode: e.target.value })}>
                    {storeOptions.map((option) => <option key={option.code} value={option.code}>{storeLabel(option.code)}</option>)}
                  </select>
                </Input>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Input label="Kho xuất NVL">
                  <select className="control" value={productionForm.warehouseCode} onChange={(e) => setProductionForm({ ...productionForm, warehouseCode: e.target.value })}>
                    {warehouseOptions.map((warehouse) => <option key={warehouse.code} value={warehouse.code}>{warehouse.name || warehouse.code}</option>)}
                  </select>
                </Input>
                <Input label="Kho nhập BTP">
                  <select className="control" value={productionForm.toWarehouseCode} onChange={(e) => setProductionForm({ ...productionForm, toWarehouseCode: e.target.value })}>
                    {warehouseOptions.map((warehouse) => <option key={warehouse.code} value={warehouse.code}>{warehouse.name || warehouse.code}</option>)}
                  </select>
                </Input>
              </div>
              <Input label="Mã lệnh">
                <input data-input-kind="code" className="control" value={productionForm.referenceCode} onChange={(e) => setProductionForm({ ...productionForm, referenceCode: e.target.value })} />
              </Input>
              <button className="primary-button w-full">Ghi nhận chế biến</button>
            </form>
          )}
          <section className="table-panel shadow-sm">
            <Panel title="Giao dịch chế biến gần nhất" reload={loadData} />
            <Table headers={[{ label: "Chứng từ" }, { label: "Loại" }, { label: "Kho" }, { label: "Mặt hàng" }]}>
              {data.transactions.filter((row) => row.transactionType.includes("CHE_BIEN")).map((row) => (
                <tr key={row.id} className="border-t border-slate-100">
                  <Cell><b>{row.code}</b><small>{new Date(row.transactionDate).toLocaleDateString("vi-VN")}</small></Cell>
                  <Cell>{movementTypeLabel(row.transactionType)}</Cell>
                  <Cell>{row.warehouseCode}</Cell>
                  <Cell>{row.lines.map((line) => `${line.item.code}: ${money(line.quantity)} ${line.item.unit}`).join(", ")}</Cell>
                </tr>
              ))}
            </Table>
          </section>
        </div>
      )}

      {active === "stocktake" && (
        <div className="space-y-5">
          {canCreate && (
            <form onSubmit={(e) => { e.preventDefault(); void send({ action: "APPROVE_STOCKTAKE", ...stocktakeForm, lines: stocktakeRows.map((row) => ({ itemId: row.itemId, actualQuantity: row.actualQuantity, reason: row.reason || stocktakeForm.reason })) }, "Đã duyệt kiểm kê và sinh điều chỉnh."); }} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 h-fit shadow-sm">
              <h2 className="font-bold text-slate-800">Kiểm kê kho</h2>
              <div className="grid grid-cols-2 gap-3">
                <Input label="Cửa hàng">
                  <select className="control" value={stocktakeForm.branchCode} onChange={(e) => setStocktakeForm({ ...stocktakeForm, branchCode: e.target.value })}>
                    {storeOptions.map((option) => <option key={option.code} value={option.code}>{storeLabel(option.code)}</option>)}
                  </select>
                </Input>
                <Input label="Kho">
                  <select className="control" value={stocktakeForm.warehouseCode} onChange={(e) => { const warehouseCode = e.target.value; setStocktakeForm({ ...stocktakeForm, warehouseCode }); setStocktakeRows(buildStocktakeRows(warehouseCode, data.balances, data.items)); }}>
                    {warehouseOptions.map((warehouse) => <option key={warehouse.code} value={warehouse.code}>{warehouse.name || warehouse.code}</option>)}
                  </select>
                </Input>
              </div>
              <Input label="Lý do">
                <input className="control" value={stocktakeForm.reason} onChange={(e) => setStocktakeForm({ ...stocktakeForm, reason: e.target.value })} />
              </Input>
              <div className="flex justify-end">
                <button type="button" className="secondary-button" onClick={() => setStocktakeRows(buildStocktakeRows(stocktakeForm.warehouseCode, data.balances, data.items))}>
                  <span className="material-symbols-outlined text-lg">refresh</span>Nạp danh sách kho
                </button>
              </div>
              <div className="border border-slate-200 rounded-lg overflow-hidden">
                <Table headers={[{ label: "Mặt hàng" }, { label: "Tồn hệ thống", align: "right" }, { label: "Tồn thực tế", align: "right" }, { label: "Chênh lệch", align: "right" }, { label: "Lý do" }]}>
                  {stocktakeRows.map((row, index) => {
                    const actualQuantity = Number(row.actualQuantity || 0);
                    const variance = actualQuantity - row.systemQuantity;
                    return (
                      <tr key={row.itemId} className="border-t border-slate-100">
                        <Cell><b>{row.itemCode}</b><small>{row.itemName} · {row.unit}</small></Cell>
                        <Cell right>{money(row.systemQuantity)}</Cell>
                        <Cell right>
                          <input
                            type="number"
                            min="0"
                            step="0.001"
                            className="control text-right w-28 inline-block"
                            value={row.actualQuantity}
                            onChange={(e) => setStocktakeRows(stocktakeRows.map((candidate, rowIndex) => rowIndex === index ? { ...candidate, actualQuantity: e.target.value } : candidate))}
                          />
                        </Cell>
                        <Cell right><span className={variance === 0 ? "text-slate-500" : variance > 0 ? "text-emerald-700 font-bold" : "text-rose-700 font-bold"}>{money(variance)}</span></Cell>
                        <Cell>
                          <input
                            className="control"
                            value={row.reason}
                            placeholder={stocktakeForm.reason}
                            onChange={(e) => setStocktakeRows(stocktakeRows.map((candidate, rowIndex) => rowIndex === index ? { ...candidate, reason: e.target.value } : candidate))}
                          />
                        </Cell>
                      </tr>
                    );
                  })}
                </Table>
              </div>
              <button className="primary-button w-full">Duyệt kiểm kê</button>
            </form>
          )}
          <section className="table-panel shadow-sm">
            <Panel title="Phiếu kiểm kê gần nhất" reload={loadData} />
            <Table headers={[{ label: "Phiếu" }, { label: "Kho" }, { label: "Mặt hàng" }, { label: "Chênh lệch", align: "right" }]}>
              {data.stocktakes.map((row) => (
                <tr key={row.id} className="border-t border-slate-100">
                  <Cell><b>{row.code}</b><small>{new Date(row.stocktakeDate).toLocaleDateString("vi-VN")} · {row.status}</small></Cell>
                  <Cell>{row.warehouseCode}</Cell>
                  <Cell>{row.lines.map((line) => line.item.code).join(", ")}</Cell>
                  <Cell right>{money(row.lines.reduce((sum, line) => sum + line.varianceQuantity, 0))}</Cell>
                </tr>
              ))}
            </Table>
          </section>
        </div>
      )}

      {active === "waste" && (
        <div className="max-w-xl">
          <form onSubmit={(e) => { e.preventDefault(); void send({ action: "RECORD_WASTE", ...wasteForm }, "Đã xuất kho nguyên liệu hủy theo định lượng."); }} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 shadow-sm">
            <h2 className="font-bold text-slate-800">Ghi nhận hủy hàng POS</h2>
            
            <Input label="Sản phẩm">
              <select className="control" value={wasteForm.recipeId} onChange={(e) => setWasteForm({ ...wasteForm, recipeId: e.target.value })}>{data.recipes.map((recipe) => <option key={recipe.id} value={recipe.id}>{recipe.productCode} - {recipe.productName} (V{recipe.version})</option>)}</select>
            </Input>
            
            <Input label="Số lượng hủy">
              <input type="number" min="0.01" step="0.01" className="control" value={wasteForm.productQuantity} onChange={(e) => setWasteForm({ ...wasteForm, productQuantity: e.target.value })} />
            </Input>
            
            <div className="grid grid-cols-2 gap-3">
              <Input label="Cửa hàng">
                <select
                  value={wasteForm.branchCode}
                  onChange={(e) => setWasteForm({ ...wasteForm, branchCode: e.target.value })}
                  className="control"
                >
                  {storeOptions.map((option) => (
                    <option key={option.code} value={option.code}>
                      {storeLabel(option.code)}
                    </option>
                  ))}
                </select>
              </Input>
              
              <Input label="Kho">
                <select
                  value={wasteForm.warehouseCode}
                  onChange={(e) => setWasteForm({ ...wasteForm, warehouseCode: e.target.value })}
                  className="control"
                >
                  <option value="KHO_HCM">Kho Cửa hàng 1</option>
                  <option value="KHO_HN">Kho Cửa hàng 2</option>
                </select>
              </Input>
            </div>
            
            <Input label="Mã giao dịch POS">
              <input data-input-kind="code" className="control" value={wasteForm.referenceCode} onChange={(e) => setWasteForm({ ...wasteForm, referenceCode: e.target.value })} />
            </Input>
            
            <Input label="Ghi chú">
              <textarea className="control h-20 resize-none" value={wasteForm.note} onChange={(e) => setWasteForm({ ...wasteForm, note: e.target.value })} />
            </Input>
            
            <button className="primary-button w-full">
              <span className="material-symbols-outlined text-lg">delete_sweep</span>Ghi nhận hủy
            </button>
          </form>
        </div>
      )}
    </ModuleFrame>
  );
}

function movementTypeLabel(type: string): string {
  const map: Record<string, string> = {
    NHAP_MUA: "Nhập mua",
    NHAP_KHAC: "Nhập khác",
    NHAP_CHE_BIEN: "Nhập chế biến",
    NHAP_KIEM_KE: "Nhập kiểm kê",
    XUAT_BAN: "Xuất bán",
    XUAT_HUY: "Xuất hủy / hao hụt",
    XUAT_KHAC: "Xuất khác",
    XUAT_CHE_BIEN: "Xuất chế biến",
    XUAT_KIEM_KE: "Xuất kiểm kê",
    DIEU_CHUYEN: "Điều chuyển kho",
  };
  return map[type] || type;
}

function Input({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block text-xs font-bold text-slate-600">{label}{children}</label>; }
function ItemSelect({ items, value, onChange }: { items: Item[]; value: string; onChange: (value: string) => void }) { return <select className="control" value={value} onChange={(e) => onChange(e.target.value)}><option value="">Chọn mặt hàng</option>{items.map((item) => <option key={item.id} value={item.id}>{item.code} - {item.name}</option>)}</select>; }
function Panel({ title, reload }: { title: string; reload: () => void }) { return <div className="p-5 flex justify-between"><h2 className="font-bold text-slate-800">{title}</h2><button type="button" title="Tải lại" onClick={reload} className="icon-button"><span className="material-symbols-outlined text-lg">refresh</span></button></div>; }

function Table({ headers, children }: { headers: { label: string; align?: "left" | "right" }[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto max-h-[580px] overflow-y-auto custom-scrollbar">
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

function Cell({ children, right = false }: { children: React.ReactNode; right?: boolean }) { return <td className={`cell ${right ? "text-right" : ""}`}>{children}</td>; }
