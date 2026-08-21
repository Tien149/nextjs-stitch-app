"use client";

import { useEffect, useMemo, useState } from "react";
import { ModuleFrame, ModuleTabs } from "@/components/ModuleFrame";
import { storeLabel, visibleStoreOptions } from "@/lib/branch-labels";
import { canPerformMenuAction, SESSION_KEY, filterModuleTabs } from "@/lib/auth-demo";
import { useModuleAuth } from "@/lib/use-module-auth";
import CopyableText from "@/components/CopyableText";
import StickyFilterBar from "@/components/StickyFilterBar";

type UnitConversion = { id: string; unitCode: string; unitName: string | null; conversionRate: number; isDefaultPurchase: boolean };
type Item = { id: string; code: string; name: string; unit: string; itemType: string; category?: string | null; minStock: number; requiresImage: boolean; unitConversions?: UnitConversion[] };
type ItemGroup = { id: string; code: string; name: string; group: string | null; subGroup: string | null };
type Balance = { id: string; warehouseCode: string; quantity: number; averageCost: number; item: Item };
type Transaction = { id: string; code: string; transactionType: string; subType: string | null; transactionDate: string; branchCode: string; warehouseCode: string; toWarehouseCode: string | null; toBranchCode: string | null; internalReceivableDebtCode: string | null; internalPayableDebtCode: string | null; referenceCode: string | null; note?: string | null; lines: Array<{ id: string; inputQuantity: number | null; inputUnitCode: string | null; conversionRate: number; quantity: number; unitCost: number; inputUnitCost: number | null; totalCost: number; item: Item }> };
type Recipe = { id: string; code: string; productCode: string; productName: string; unit: string; outputConversionRate: number; sellingPrice: number; estimatedCost: number; estimatedUnitCost: number; version: number; effectiveFrom: string; status: string; lines: Array<{ quantity: number; unitCode: string | null; conversionRate: number; wasteRate: number; item: Item }> };
type CostSummaryRow = { productCode: string; productName: string; group: string; stockUnit: string; batchUnit: string; outputConversionRate: number; sellingPrice: number; unitCost: number; costRatio: number | null; version: number };
type WasteReportRow = { itemCode: string; itemName: string; unit: string; itemType: string; totalQuantity: number; totalValue: number; documentCount: number; bySubType: Record<string, { quantity: number; value: number }> };
type PendingSales = { total: number; byDay: Array<{ saleDate: string; branchCode: string; rowCount: number; totalQuantity: number }> };
type Warehouse = { id: string; code: string; name: string; branch: string | null };
type MovementByType = Record<string, { inbound: number; outbound: number; value: number }>;
type StockSummary = { item: Item; warehouseCode: string; openingQuantity: number; inboundQuantity: number; outboundQuantity: number; closingQuantity: number; averageCost: number; closingValue: number; movementByType?: MovementByType };
type StockMovement = { transactionId: string; code: string; transactionType: string; transactionDate: string; warehouseCode: string; toWarehouseCode: string | null; itemCode: string; itemName: string; unit: string; quantity: number; inboundQuantity: number; outboundQuantity: number; value: number; referenceCode: string | null };
type Stocktake = { id: string; code: string; stocktakeDate: string; branchCode: string; warehouseCode: string; status: string; lines: Array<{ id: string; systemQuantity: number; actualQuantity: number; varianceQuantity: number; item: Item }> };
type ReceivablePOLine = { id: string; itemId: string; orderedQuantity: number; receivedQuantity: number; unitCost: number; item: { code: string; name: string; unit: string } };
type ReceivablePO = { id: string; code: string; supplierName: string; branchCode: string; warehouseCode: string; status: string; lines: ReceivablePOLine[] };
type StocktakeDraftRow = { itemId: string; itemCode: string; itemName: string; unit: string; systemQuantity: number; actualQuantity: string; reason: string };
type Data = { items: Item[]; balances: Balance[]; transactions: Transaction[]; recipes: Recipe[]; warehouses: Warehouse[]; stocktakes: Stocktake[]; stockSummary: StockSummary[]; stockMovements: StockMovement[]; itemGroups: ItemGroup[]; costSummary: CostSummaryRow[]; wasteReport: WasteReportRow[]; pendingSales: PendingSales };
const money = (value: number) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(value);
const movementTypes = ["NHAP_MUA", "NHAP_KHAC", "NHAP_CHE_BIEN", "NHAP_KIEM_KE", "XUAT_BAN", "XUAT_HUY", "XUAT_TEST_MON", "XUAT_KHAC", "XUAT_CHE_BIEN", "XUAT_KIEM_KE", "DIEU_CHUYEN"];
/** Loại hiển thị trên hai màn hình Nhập/Xuất. Điều chuyển hiện ở CẢ hai: vế xuất ở kho đi, vế nhập ở kho nhận. */
const inboundTypes = ["NHAP_MUA", "NHAP_CHE_BIEN", "NHAP_DIEU_CHUYEN", "NHAP_KHAC", "NHAP_KIEM_KE"];
const outboundTypes = ["XUAT_BAN", "XUAT_CHE_BIEN", "XUAT_HUY", "XUAT_DIEU_CHUYEN", "XUAT_TEST_MON", "XUAT_KHAC", "XUAT_KIEM_KE"];
const wasteTypeOptions = [
  { code: "HET_HAN_SU_DUNG", label: "Xuất hủy do hết hạn sử dụng" },
  { code: "KHONG_DAM_BAO_CHAT_LUONG", label: "Xuất hủy do không đảm bảo chất lượng" },
];
const today = () => new Date().toISOString().slice(0, 10);

/** Kiểm kê kho bao gồm mọi mặt hàng TRỪ CCDC & Tài sản (kiểm kê ở màn Tài sản & Khấu hao). */
const stocktakeExcludedTypes = ["TOOL", "ASSET"];

function buildStocktakeRows(warehouseCode: string, balances: Balance[], fallbackItems: Item[]): StocktakeDraftRow[] {
  const rows = balances
    .filter((balance) => balance.warehouseCode === warehouseCode && !stocktakeExcludedTypes.includes(balance.item.itemType))
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
  return fallbackItems.filter((item) => !stocktakeExcludedTypes.includes(item.itemType)).slice(0, 20).map((item) => ({
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
  const [data, setData] = useState<Data>({ items: [], balances: [], transactions: [], recipes: [], warehouses: [], stocktakes: [], stockSummary: [], stockMovements: [], itemGroups: [], costSummary: [], wasteReport: [], pendingSales: { total: 0, byDay: [] } });
  const [message, setMessage] = useState("");
  const [reportWarehouse, setReportWarehouse] = useState("ALL");
  const [reportType, setReportType] = useState("ALL");
  // Bộ lọc hai màn hình Nhập kho / Xuất kho: theo nhà hàng + theo loại nhập/xuất.
  const [flowBranch, setFlowBranch] = useState("ALL");
  const [inboundType, setInboundType] = useState("ALL");
  const [outboundType, setOutboundType] = useState("ALL");

  const [itemForm, setItemForm] = useState({ code: "NVL_001", name: "Nguyên liệu mẫu", unit: "g", itemType: "RAW_MATERIAL", category: "", purchaseUnit: "kg", conversionRate: "1000", minStock: "500", requiresImage: false });
  const [itemSearch, setItemSearch] = useState("");
  const [itemTypeFilter, setItemTypeFilter] = useState("ALL");
  const [conversionForm, setConversionForm] = useState({ itemId: "", purchaseUnit: "thung", conversionRate: "24", note: "" });
  const [stockForm, setStockForm] = useState({ transactionType: "NHAP_MUA", branchCode: "HCM", warehouseCode: "KHO_HCM", toWarehouseCode: "KHO_HN", itemId: "", inputUnitCode: "", quantity: "10", unitCost: "100000", referenceCode: "", note: "Nhap kho van hanh" });
  /** Nhập mua theo PO (GRPO): PO đã duyệt còn hàng chưa nhận + số lượng nhận trên từng dòng. */
  const [receivablePOs, setReceivablePOs] = useState<ReceivablePO[]>([]);
  const [grpoOrderId, setGrpoOrderId] = useState("");
  const [grpoQuantities, setGrpoQuantities] = useState<Record<string, string>>({});
  const [recipeForm, setRecipeForm] = useState({ productCode: "SP_COMBO01", productName: "Combo ban POS", sellingPrice: "45000", unit: "", outputConversionRate: "1", effectiveFrom: today(), itemId: "", quantity: "0.02", wasteRate: "3" });
  const [recipeRows, setRecipeRows] = useState([{ itemId: "", quantity: "1", unitCode: "", wasteRate: "0" }, { itemId: "", quantity: "20", unitCode: "", wasteRate: "5" }]);
  const [productionForm, setProductionForm] = useState({ productCode: "BTP_SOTCACHUA", productQuantity: "2", branchCode: "HCM", warehouseCode: "KHO_HCM", toWarehouseCode: "KHO_HCM", referenceCode: "", note: "Che bien ban thanh pham" });
  /** Nút Rã nguyên liệu: rã doanh thu chờ (PENDING) theo định lượng, tự sinh phiếu chế biến + xuất bán. */
  const [explodeForm, setExplodeForm] = useState({ branchCode: "HCM", warehouseCode: "KHO_HCM", toWarehouseCode: "KHO_HCM", dateFrom: today(), dateTo: today(), note: "" });
  const [exploding, setExploding] = useState(false);
  /** Điều chuyển kho: nhiều dòng hàng, kho nhận có thể thuộc nhà hàng khác. */
  const [transferForm, setTransferForm] = useState({ branchCode: "HCM", warehouseCode: "KHO_HCM", toWarehouseCode: "", transactionDate: today(), referenceCode: "", note: "" });
  const [transferRows, setTransferRows] = useState([{ itemId: "", quantity: "1", unitCode: "" }]);
  const [stocktakeForm, setStocktakeForm] = useState({ branchCode: "HCM", warehouseCode: "KHO_HCM", itemId: "", actualQuantity: "0", reason: "Kiem ke thuc te" });
  const [stocktakeRows, setStocktakeRows] = useState<StocktakeDraftRow[]>([]);
  const [wasteForm, setWasteForm] = useState({ wasteType: "HET_HAN_SU_DUNG", mode: "ITEMS", recipeId: "", productQuantity: "1", branchCode: "HCM", warehouseCode: "KHO_HCM", referenceCode: "", note: "" });
  const [wasteRows, setWasteRows] = useState([{ itemId: "", quantity: "1", unitCode: "" }]);
  
  const visibleTabs = useMemo(() => filterModuleTabs(user, href), [user]);

  // Tab mặc định có thể nằm ngoài quyền -> chuyển về tab đầu tiên được phép.
  useEffect(() => {
    if (visibleTabs.length === 0) return;
    if (visibleTabs.some((tab) => tab.id === active)) return;
    const fallback = visibleTabs[0].id;
    window.setTimeout(() => setActive(fallback), 0);
  }, [active, visibleTabs]);
  // Form Nhập/Xuất dùng chung state: đổi tab thì đưa Loại về đúng chiều của tab đó.
  const switchTab = (tab: string) => {
    setActive(tab);
    if (tab === "inbound") {
      setStockForm((form) => form.transactionType.startsWith("NHAP_") ? form : { ...form, transactionType: "NHAP_MUA" });
    }
    if (tab === "outbound") {
      setStockForm((form) => ["XUAT_KHAC", "XUAT_TEST_MON"].includes(form.transactionType) ? form : { ...form, transactionType: "XUAT_KHAC" });
    }
  };

  const canCreate = user ? canPerformMenuAction(user, href, "create") : false;
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

  /**
   * Phiếu kho quy về hai chiều Nhập/Xuất. Điều chuyển góp một dòng cho MỖI màn hình:
   * "Xuất điều chuyển" đứng ở cửa hàng/kho đi, "Nhập điều chuyển" ở cửa hàng/kho nhận.
   */
  const flowRows = (direction: "IN" | "OUT") => data.transactions.flatMap((transaction) => {
    const rows: Array<{ transaction: Transaction; displayType: string; branchCode: string; warehouseCode: string }> = [];
    if (transaction.transactionType === "DIEU_CHUYEN") {
      if (direction === "OUT") rows.push({ transaction, displayType: "XUAT_DIEU_CHUYEN", branchCode: transaction.branchCode, warehouseCode: transaction.warehouseCode });
      if (direction === "IN" && transaction.toWarehouseCode) rows.push({ transaction, displayType: "NHAP_DIEU_CHUYEN", branchCode: transaction.toBranchCode || transaction.branchCode, warehouseCode: transaction.toWarehouseCode });
    } else if (direction === "IN" && transaction.transactionType.startsWith("NHAP_")) {
      rows.push({ transaction, displayType: transaction.transactionType, branchCode: transaction.branchCode, warehouseCode: transaction.warehouseCode });
    } else if (direction === "OUT" && transaction.transactionType.startsWith("XUAT_")) {
      rows.push({ transaction, displayType: transaction.transactionType, branchCode: transaction.branchCode, warehouseCode: transaction.warehouseCode });
    }
    return rows;
  });
  const inboundRows = flowRows("IN").filter((row) =>
    (flowBranch === "ALL" || row.branchCode === flowBranch) && (inboundType === "ALL" || row.displayType === inboundType));
  const outboundRows = flowRows("OUT").filter((row) =>
    (flowBranch === "ALL" || row.branchCode === flowBranch) && (outboundType === "ALL" || row.displayType === outboundType));
  const transferTransactions = data.transactions.filter((transaction) => transaction.transactionType === "DIEU_CHUYEN");

  // Điều chuyển không nhận nhóm FINISHED; hủy hàng thì nhận đủ (kể cả FINISHED).
  const transferableItems = data.items.filter((item) => item.itemType !== "FINISHED");
  const transferDestination = warehouseOptions.find((warehouse) => warehouse.code === transferForm.toWarehouseCode);
  const transferCrossBranch = !!transferDestination && !!transferDestination.branch && transferDestination.branch !== transferForm.branchCode;

  const filteredItems = data.items.filter((item) => {
    if (itemTypeFilter !== "ALL" && item.itemType !== itemTypeFilter) return false;
    const keyword = itemSearch.trim().toLowerCase();
    if (!keyword) return true;
    return item.code.toLowerCase().includes(keyword) || item.name.toLowerCase().includes(keyword);
  });

  const getSessionHeaders = (): Record<string, string> => {
    if (typeof window === "undefined") return {};
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? { "x-demo-session": encodeURIComponent(raw) } : {};
  };

  /** Người dùng không có quyền menu Mua hàng thì bỏ qua, form vẫn nhập thủ công được. */
  const loadReceivablePOs = async () => {
    try {
      const response = await fetch("/api/procurement", { headers: getSessionHeaders() });
      if (!response.ok) {
        setReceivablePOs([]);
        return;
      }
      const payload = await response.json() as { orders?: ReceivablePO[] };
      setReceivablePOs((payload.orders || []).filter((order) =>
        ["APPROVED", "PARTIALLY_RECEIVED"].includes(order.status) &&
        order.lines.some((line) => line.orderedQuantity - line.receivedQuantity > 0)));
    } catch {
      setReceivablePOs([]);
    }
  };

  const loadData = async () => {
    void loadReceivablePOs();
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

  const grpoOrder = stockForm.transactionType === "NHAP_MUA"
    ? receivablePOs.find((order) => order.id === grpoOrderId) || null
    : null;

  /** Chọn PO -> điền sẵn số lượng còn phải nhận trên từng dòng. */
  const selectGrpoOrder = (orderId: string) => {
    setGrpoOrderId(orderId);
    const order = receivablePOs.find((candidate) => candidate.id === orderId);
    const quantities: Record<string, string> = {};
    for (const line of order?.lines || []) {
      quantities[line.id] = String(line.orderedQuantity - line.receivedQuantity);
    }
    setGrpoQuantities(quantities);
  };

  /** GRPO: nhận hàng từ PO — tồn kho, công nợ NCC và tài sản/CCDC do /api/procurement xử lý. */
  const receiveFromPO = async () => {
    if (!grpoOrder) return;
    setMessage("");
    const lines = grpoOrder.lines
      .map((line) => ({ itemId: line.itemId, quantity: Number(grpoQuantities[line.id] ?? 0) }))
      .filter((line) => line.quantity > 0);
    if (lines.length === 0) {
      setMessage("Chưa nhập số lượng cần nhận từ PO.");
      return;
    }
    const response = await fetch("/api/procurement", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...getSessionHeaders() },
      body: JSON.stringify({ action: "RECEIVE_ORDER", orderId: grpoOrder.id, lines, note: stockForm.note }),
    });
    const payload = await response.json();
    setMessage(response.ok
      ? `Đã nhập mua hàng từ ${grpoOrder.code} vào kho ${grpoOrder.warehouseCode}.`
      : payload.error || "Không nhận được hàng từ PO");
    if (response.ok) {
      setGrpoOrderId("");
      setGrpoQuantities({});
      await loadData();
    }
  };

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
    <ModuleFrame
      title="Kho & Định lượng"
      subtitle="Giai đoạn 3 • Quản lý kho hàng, tính giá bình quân, công thức định lượng và hủy hàng"
      role={user?.role}
      contentClassName="max-w-[1680px]"
    >
      {/* Operational Summary Cards */}
      <StickyFilterBar>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
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

      <ModuleTabs active={active} onChange={switchTab} tabs={visibleTabs} />
      </StickyFilterBar>
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
                  <b><CopyableText value={row.item.code} /> - {row.item.name}</b>
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
                <Cell><CopyableText value={row.code}><b>{row.code}</b></CopyableText><small>{row.referenceCode || "-"}</small></Cell>
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
                  <b><CopyableText value={row.item.code} /> - {row.item.name}</b>
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
        <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
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
                <select className="control" value={itemForm.itemType} onChange={(e) => setItemForm({ ...itemForm, itemType: e.target.value, category: "" })}>
                  <option value="RAW_MATERIAL">Nguyên liệu thô</option>
                  <option value="SEMI_FINISHED">Bán thành phẩm</option>
                  <option value="FINISHED">Thành phẩm</option>
                  <option value="PACKAGING">Bao bì</option>
                  <option value="TOOL">CCDC</option>
                  <option value="ASSET">Tài sản</option>
                </select>
              </Input>

              <Input label="Phân nhóm (đi theo kho tương ứng)">
                <select className="control" value={itemForm.category} onChange={(e) => setItemForm({ ...itemForm, category: e.target.value })}>
                  <option value="">-- Chưa gán phân nhóm --</option>
                  {data.itemGroups
                    .filter((group) => !group.group || group.group === "OTHER" || group.group === itemForm.itemType)
                    .map((group) => (
                      <option key={group.code} value={group.code}>
                        {group.name}{group.subGroup ? ` (kho ${group.subGroup})` : ""}
                      </option>
                    ))}
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
            <div className="px-5 pb-4 grid sm:grid-cols-[minmax(0,1fr)_220px] gap-3">
              <Input label="Tìm kiếm">
                <input className="control" placeholder="Gõ mã hoặc tên mặt hàng..." value={itemSearch} onChange={(e) => setItemSearch(e.target.value)} />
              </Input>
              <Input label="Loại">
                <select className="control" value={itemTypeFilter} onChange={(e) => setItemTypeFilter(e.target.value)}>
                  <option value="ALL">Tất cả loại</option>
                  <option value="RAW_MATERIAL">Nguyên liệu thô</option>
                  <option value="SEMI_FINISHED">Bán thành phẩm</option>
                  <option value="FINISHED">Thành phẩm</option>
                  <option value="PACKAGING">Bao bì</option>
                  <option value="TOOL">CCDC</option>
                  <option value="ASSET">Tài sản</option>
                </select>
              </Input>
            </div>
            <p className="px-5 pb-2 text-[11px] text-slate-500">{filteredItems.length}/{data.items.length} mặt hàng</p>
            <Table
              tableClassName="min-w-[1050px]"
              headers={[
                { label: "Mã" },
                { label: "Tên" },
                { label: "Loại" },
                { label: "Phân nhóm" },
                { label: "Đơn vị" },
                { label: "Quy đổi mua" },
                { label: "Tồn tối thiểu", align: "right" },
                { label: "Yêu cầu ảnh" },
              ]}
            >
              {filteredItems.map((item) => (
                <tr key={item.id} className="border-t border-slate-100">
                  <Cell><CopyableText value={item.code}><b>{item.code}</b></CopyableText></Cell>
                  <Cell>{item.name}</Cell>
                  <Cell>{item.itemType}</Cell>
                  <Cell>{data.itemGroups.find((group) => group.code === item.category)?.name || item.category || "-"}</Cell>
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

      {(active === "inbound" || active === "outbound") && (
        <div className="grid lg:grid-cols-[380px_1fr] gap-5">
          {canCreate && (
            <form onSubmit={(e) => { e.preventDefault(); if (grpoOrder) { void receiveFromPO(); return; } void send({ action: "STOCK_TRANSACTION", ...stockForm, lines: [{ itemId: stockForm.itemId, inputQuantity: stockForm.quantity, inputUnitCode: stockForm.inputUnitCode || selectedStockUnit?.unitCode, inputUnitCost: active === "inbound" ? stockForm.unitCost : "0" }] }, active === "inbound" ? "Đã ghi nhận phiếu nhập kho." : "Đã ghi nhận phiếu xuất kho."); }} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 h-fit shadow-sm">
              <h2 className="font-bold text-slate-800">{active === "inbound" ? "Ghi nhận nhập kho" : "Ghi nhận xuất kho"}</h2>

              <Input label="Loại">
                <select className="control" value={stockForm.transactionType} onChange={(e) => setStockForm({ ...stockForm, transactionType: e.target.value })}>
                  {active === "inbound" ? (<>
                    <option value="NHAP_MUA">Nhập mua hàng NCC</option>
                    <option value="NHAP_KHAC">Nhập khác</option>
                  </>) : (<>
                    <option value="XUAT_KHAC">Xuất khác</option>
                    <option value="XUAT_TEST_MON">Xuất test món</option>
                  </>)}
                </select>
              </Input>

              <p className="text-[11px] text-slate-500 leading-relaxed !mt-2">
                {active === "inbound"
                  ? "Nhập chế biến, nhập điều chuyển và nhập điều chỉnh kiểm kê do hệ thống tự sinh từ tab Chế biến / Điều chuyển / Kiểm kê."
                  : "Xuất bán sinh từ import doanh thu + nút Rã nguyên liệu; xuất hủy ghi ở tab Hủy hàng; xuất điều chuyển ghi ở tab Điều chuyển."}
              </p>

              {stockForm.transactionType === "NHAP_MUA" && (
                <Input label="Đơn mua hàng (PO)">
                  <select className="control" value={grpoOrderId} onChange={(e) => selectGrpoOrder(e.target.value)}>
                    <option value="">Nhập thủ công (không theo PO)</option>
                    {receivablePOs.map((order) => (
                      <option key={order.id} value={order.id}>{order.code} — {order.supplierName}</option>
                    ))}
                  </select>
                </Input>
              )}

              {grpoOrder && (
                <div className="space-y-3">
                  <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                    <b>{grpoOrder.code}</b> · {grpoOrder.supplierName} · Kho nhận theo PO: <b>{grpoOrder.warehouseCode}</b> ({storeLabel(grpoOrder.branchCode)}).
                    Hệ thống tự tăng tồn kho và ghi công nợ NCC theo số lượng nhận.
                  </div>
                  <div className="space-y-2">
                    {grpoOrder.lines.map((line) => {
                      const remaining = line.orderedQuantity - line.receivedQuantity;
                      if (remaining <= 0) return null;
                      return (
                        <div key={line.id} className="flex items-center gap-2 text-sm">
                          <div className="flex-1 min-w-0">
                            <b className="block truncate">{line.item.name}</b>
                            <small className="text-slate-500">Còn phải nhận: {money(remaining)} {line.item.unit} · {money(line.unitCost)} đ/{line.item.unit}</small>
                          </div>
                          <input
                            type="number"
                            min="0"
                            max={remaining}
                            step="any"
                            className="control w-24 text-right"
                            value={grpoQuantities[line.id] ?? String(remaining)}
                            onChange={(e) => setGrpoQuantities({ ...grpoQuantities, [line.id]: e.target.value })}
                            aria-label={`Số lượng nhận ${line.item.name}`}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {!grpoOrder && (<>
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
                    {visibleStoreOptions(user).map((option) => (
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

              <div className={`grid gap-3 ${active === "inbound" ? "grid-cols-3" : "grid-cols-2"}`}>
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
                {active === "inbound" && (
                  <Input label="Đơn giá nhập">
                    <input type="number" className="control" value={stockForm.unitCost} onChange={(e) => setStockForm({ ...stockForm, unitCost: e.target.value })} />
                  </Input>
                )}
              </div>

              {selectedStockItem && (
                <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                  <b>Preview:</b> {money(stockInputQuantity)} {selectedStockUnit?.unitName || selectedStockUnit?.unitCode || selectedStockItem.unit}
                  {" = "}
                  {money(stockBaseQuantity)} {selectedStockItem.unit}
                  {active === "inbound" && stockBaseUnitCost > 0 ? ` · Don gia quy doi ${money(stockBaseUnitCost)} d/${selectedStockItem.unit} · Thanh tien ${money(stockLineValue)} d` : ""}
                </div>
              )}

              <Input label="Tham chiếu">
                <input data-input-kind="code" className="control" value={stockForm.referenceCode} onChange={(e) => setStockForm({ ...stockForm, referenceCode: e.target.value })} />
              </Input>
              </>)}

              <button className="primary-button w-full">{grpoOrder ? "Nhận hàng từ PO" : "Ghi nhận"}</button>
            </form>
          )}

          <section className="table-panel shadow-sm">
            <Panel title={active === "inbound" ? "Phiếu nhập kho gần nhất" : "Phiếu xuất kho gần nhất"} reload={loadData} />
            <div className="px-5 pb-4 grid sm:grid-cols-2 gap-3">
              <Input label="Nhà hàng">
                <select className="control" value={flowBranch} onChange={(e) => setFlowBranch(e.target.value)}>
                  <option value="ALL">Tất cả nhà hàng</option>
                  {visibleStoreOptions(user).map((option) => <option key={option.code} value={option.code}>{storeLabel(option.code)}</option>)}
                </select>
              </Input>
              <Input label={active === "inbound" ? "Loại nhập" : "Loại xuất"}>
                {active === "inbound" ? (
                  <select className="control" value={inboundType} onChange={(e) => setInboundType(e.target.value)}>
                    <option value="ALL">Tất cả loại nhập</option>
                    {inboundTypes.map((type) => <option key={type} value={type}>{movementTypeLabel(type)}</option>)}
                  </select>
                ) : (
                  <select className="control" value={outboundType} onChange={(e) => setOutboundType(e.target.value)}>
                    <option value="ALL">Tất cả loại xuất</option>
                    {outboundTypes.map((type) => <option key={type} value={type}>{movementTypeLabel(type)}</option>)}
                  </select>
                )}
              </Input>
            </div>
            <Table
              headers={[
                { label: "Chứng từ" },
                { label: "Loại" },
                { label: "Nhà hàng" },
                { label: "Kho" },
                { label: "Mặt hàng" },
                { label: "Giá trị", align: "right" },
              ]}
            >
              {(active === "inbound" ? inboundRows : outboundRows).map((row) => (
                <tr key={`${row.transaction.id}-${row.displayType}`} className="border-t border-slate-100">
                  <Cell><CopyableText value={row.transaction.code}><b>{row.transaction.code}</b></CopyableText><small>{new Date(row.transaction.transactionDate).toLocaleDateString("vi-VN")}{row.transaction.referenceCode ? ` · ${row.transaction.referenceCode}` : ""}</small></Cell>
                  <Cell>
                    <span className="status bg-slate-100">{movementTypeLabel(row.displayType)}</span>
                    {row.transaction.transactionType === "XUAT_HUY" && row.transaction.subType ? <small>{wasteSubTypeLabel(row.transaction.subType)}</small> : null}
                  </Cell>
                  <Cell>{storeLabel(row.branchCode)}</Cell>
                  <Cell>{row.transaction.transactionType === "DIEU_CHUYEN" ? `${row.transaction.warehouseCode} → ${row.transaction.toWarehouseCode}` : row.warehouseCode}</Cell>
                  <Cell>{row.transaction.lines.map((line) => `${line.item.name}: ${money(line.inputQuantity || line.quantity)} ${line.inputUnitCode || line.item.unit} = ${money(line.quantity)} ${line.item.unit}`).join(", ")}</Cell>
                  <Cell right><b>{money(row.transaction.lines.reduce((sum, line) => sum + line.totalCost, 0))} đ</b></Cell>
                </tr>
              ))}
            </Table>
          </section>
        </div>
      )}

      {active === "transfer" && (
        <div className="grid lg:grid-cols-[420px_1fr] gap-5">
          {canCreate && (
            <form onSubmit={(e) => {
              e.preventDefault();
              void send({
                action: "TRANSFER_STOCK",
                ...transferForm,
                lines: transferRows.filter((row) => row.itemId).map((row) => ({ itemId: row.itemId, inputQuantity: row.quantity, inputUnitCode: row.unitCode || undefined })),
              }, transferCrossBranch ? "Đã điều chuyển liên nhà hàng và ghi công nợ nội bộ." : "Đã điều chuyển giữa hai kho.");
            }} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 h-fit shadow-sm">
              <h2 className="font-bold text-slate-800">Điều chuyển hàng hóa</h2>

              <div className="grid grid-cols-2 gap-3">
                <Input label="Nhà hàng chuyển">
                  <select className="control" value={transferForm.branchCode} onChange={(e) => {
                    const branchCode = e.target.value;
                    const firstWarehouse = warehouseOptions.find((warehouse) => warehouse.branch === branchCode || !warehouse.branch);
                    setTransferForm({ ...transferForm, branchCode, warehouseCode: firstWarehouse?.code || "" });
                  }}>
                    {visibleStoreOptions(user).map((option) => <option key={option.code} value={option.code}>{storeLabel(option.code)}</option>)}
                  </select>
                </Input>
                <Input label="Kho xuất">
                  <select className="control" value={transferForm.warehouseCode} onChange={(e) => setTransferForm({ ...transferForm, warehouseCode: e.target.value })}>
                    {warehouseOptions.filter((warehouse) => warehouse.branch === transferForm.branchCode || !warehouse.branch).map((warehouse) => (
                      <option key={warehouse.code} value={warehouse.code}>{warehouse.name || warehouse.code}</option>
                    ))}
                  </select>
                </Input>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Input label="Kho nhận (mọi nhà hàng)">
                  <select className="control" value={transferForm.toWarehouseCode} onChange={(e) => setTransferForm({ ...transferForm, toWarehouseCode: e.target.value })}>
                    <option value="">Chọn kho nhận</option>
                    {warehouseOptions.filter((warehouse) => warehouse.code !== transferForm.warehouseCode).map((warehouse) => (
                      <option key={warehouse.code} value={warehouse.code}>{warehouse.name || warehouse.code}{warehouse.branch ? ` · ${storeLabel(warehouse.branch)}` : ""}</option>
                    ))}
                  </select>
                </Input>
                <Input label="Ngày điều chuyển">
                  <input type="date" className="control" value={transferForm.transactionDate} onChange={(e) => setTransferForm({ ...transferForm, transactionDate: e.target.value })} />
                </Input>
              </div>

              <div className={`rounded-lg border px-3 py-2 text-xs ${transferCrossBranch ? "border-amber-200 bg-amber-50 text-amber-800" : "border-blue-100 bg-blue-50 text-blue-800"}`}>
                {transferCrossBranch
                  ? <>Kho nhận thuộc <b>{storeLabel(transferDestination?.branch || "")}</b> — điều chuyển LIÊN nhà hàng: hệ thống sẽ ghi <b>phải thu nội bộ</b> cho bên chuyển và <b>phải trả nội bộ</b> cho bên nhận theo trị giá xuất kho.</>
                  : <>Hai kho cùng một nhà hàng: chỉ cộng trừ trên báo cáo nhập xuất tồn, không phát sinh công nợ nội bộ.</>}
                {" "}Nhóm FINISHED không được điều chuyển.
              </div>

              <div className="space-y-3 border border-slate-100 rounded-lg p-3.5 bg-slate-50/50">
                <div className="flex items-center justify-between border-b border-slate-200/60 pb-2">
                  <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Dòng hàng điều chuyển</h3>
                  <button type="button" className="text-xs font-bold text-blue-600 hover:underline flex items-center gap-0.5" onClick={() => setTransferRows([...transferRows, { itemId: "", quantity: "1", unitCode: "" }])}>
                    <span className="material-symbols-outlined text-sm font-bold">add</span>Thêm dòng
                  </button>
                </div>
                {transferRows.map((row, index) => {
                  const rowItem = transferableItems.find((item) => item.id === row.itemId);
                  const rowUnits = rowItem?.unitConversions?.length ? rowItem.unitConversions : rowItem ? [{ id: "base", unitCode: rowItem.unit.toUpperCase(), unitName: rowItem.unit, conversionRate: 1, isDefaultPurchase: true }] : [];
                  return (
                    <div key={index} className="bg-white border border-slate-200 rounded-xl p-3 space-y-2 shadow-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Hàng #{index + 1}</span>
                        {transferRows.length > 1 && (
                          <button type="button" className="text-xs font-bold text-rose-600 hover:underline" onClick={() => setTransferRows(transferRows.filter((_, rowIndex) => rowIndex !== index))}>Xóa</button>
                        )}
                      </div>
                      <ItemSelect items={transferableItems} value={row.itemId} onChange={(itemId) => {
                        const item = transferableItems.find((candidate) => candidate.id === itemId);
                        setTransferRows(transferRows.map((candidate, rowIndex) => rowIndex === index ? { ...candidate, itemId, unitCode: item?.unit.toUpperCase() || "" } : candidate));
                      }} />
                      <div className="grid grid-cols-2 gap-3">
                        <input type="number" step="0.001" min="0" className="control" value={row.quantity} placeholder="Số lượng"
                          onChange={(e) => setTransferRows(transferRows.map((candidate, rowIndex) => rowIndex === index ? { ...candidate, quantity: e.target.value } : candidate))} />
                        <select className="control" value={row.unitCode} onChange={(e) => setTransferRows(transferRows.map((candidate, rowIndex) => rowIndex === index ? { ...candidate, unitCode: e.target.value } : candidate))}>
                          {rowUnits.map((unit) => <option key={unit.unitCode} value={unit.unitCode}>{unit.unitName || unit.unitCode}</option>)}
                        </select>
                      </div>
                    </div>
                  );
                })}
              </div>

              <Input label="Tham chiếu">
                <input data-input-kind="code" className="control" value={transferForm.referenceCode} onChange={(e) => setTransferForm({ ...transferForm, referenceCode: e.target.value })} />
              </Input>
              <Input label="Ghi chú">
                <input className="control" value={transferForm.note} onChange={(e) => setTransferForm({ ...transferForm, note: e.target.value })} />
              </Input>
              <button className="primary-button w-full">
                <span className="material-symbols-outlined text-lg">sync_alt</span>
                {transferCrossBranch ? "Điều chuyển + ghi công nợ nội bộ" : "Điều chuyển kho"}
              </button>
            </form>
          )}

          <section className="table-panel shadow-sm">
            <Panel title="Phiếu điều chuyển gần nhất" reload={loadData} />
            <Table
              headers={[
                { label: "Chứng từ" },
                { label: "Tuyến điều chuyển" },
                { label: "Phạm vi" },
                { label: "Mặt hàng" },
                { label: "Công nợ nội bộ" },
                { label: "Trị giá", align: "right" },
              ]}
            >
              {transferTransactions.map((row) => {
                const crossBranch = !!row.toBranchCode && row.toBranchCode !== row.branchCode;
                return (
                  <tr key={row.id} className="border-t border-slate-100">
                    <Cell><CopyableText value={row.code}><b>{row.code}</b></CopyableText><small>{new Date(row.transactionDate).toLocaleDateString("vi-VN")}</small></Cell>
                    <Cell>
                      <b>{row.warehouseCode} → {row.toWarehouseCode}</b>
                      <small>{storeLabel(row.branchCode)} → {storeLabel(row.toBranchCode || row.branchCode)}</small>
                    </Cell>
                    <Cell>{crossBranch
                      ? <span className="status bg-amber-50 text-amber-700">Liên nhà hàng</span>
                      : <span className="status bg-slate-100">Nội bộ 1 nhà hàng</span>}
                    </Cell>
                    <Cell>{row.lines.map((line) => `${line.item.name}: ${money(line.quantity)} ${line.item.unit}`).join(", ")}</Cell>
                    <Cell>{crossBranch && row.internalReceivableDebtCode
                      ? <><b><CopyableText value={row.internalReceivableDebtCode} /></b><small>Phải trả: {row.internalPayableDebtCode}</small></>
                      : <span className="text-slate-400">-</span>}
                    </Cell>
                    <Cell right><b>{money(row.lines.reduce((sum, line) => sum + line.totalCost, 0))} đ</b></Cell>
                  </tr>
                );
              })}
            </Table>
          </section>
        </div>
      )}

      {active === "recipes" && (
        <div className="grid lg:grid-cols-[380px_1fr] gap-5">
          {canCreate && (
            <form onSubmit={(e) => { e.preventDefault(); void send({ action: "CREATE_RECIPE", ...recipeForm, lines: recipeRows.filter((row) => row.itemId).map((row) => ({ itemId: row.itemId, quantity: row.quantity, unitCode: row.unitCode || undefined, wasteRate: row.wasteRate })) }, "Đã tạo phiên bản định lượng mới."); }} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 h-fit shadow-sm">
              <h2 className="font-bold text-slate-800">Tạo định lượng</h2>

              <div className="grid grid-cols-2 gap-3">
                <Input label="Mã món (SP_/BTP_)">
                  <input data-input-kind="code" className="control" value={recipeForm.productCode} onChange={(e) => setRecipeForm({ ...recipeForm, productCode: e.target.value })} />
                </Input>
                <Input label="Giá bán (BTP bỏ trống)">
                  <input type="number" className="control" value={recipeForm.sellingPrice} onChange={(e) => setRecipeForm({ ...recipeForm, sellingPrice: e.target.value })} />
                </Input>
              </div>

              <Input label="Tên món">
                <input className="control" value={recipeForm.productName} onChange={(e) => setRecipeForm({ ...recipeForm, productName: e.target.value })} />
              </Input>

              <div className="grid grid-cols-3 gap-3">
                <Input label="ĐVT mẻ chuẩn bị">
                  <input className="control" placeholder="vd: 1kg, lít sốt" value={recipeForm.unit} onChange={(e) => setRecipeForm({ ...recipeForm, unit: e.target.value })} />
                </Input>
                <Input label="Quy đổi về ĐVT tồn">
                  <input type="number" min="0" step="0.001" className="control" value={recipeForm.outputConversionRate} onChange={(e) => setRecipeForm({ ...recipeForm, outputConversionRate: e.target.value })} />
                </Input>
                <Input label="Ngày áp dụng">
                  <input type="date" className="control" value={recipeForm.effectiveFrom} onChange={(e) => setRecipeForm({ ...recipeForm, effectiveFrom: e.target.value })} />
                </Input>
              </div>
              <p className="text-[11px] text-slate-500 leading-relaxed !mt-1">
                Định lượng khai cho <b>một mẻ</b> ĐVT chuẩn bị. Ví dụ BTP nấu mẻ 1kg (tồn kho gr) thì quy đổi = 1000. Món bán theo phần để trống (=1).
              </p>
              
              <div className="space-y-4 border border-slate-100 rounded-lg p-3.5 bg-slate-50/50">
                <div className="flex items-center justify-between border-b border-slate-200/60 pb-2">
                  <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Thành phần nguyên liệu</h3>
                  <button type="button" className="text-xs font-bold text-blue-600 hover:underline flex items-center gap-0.5" onClick={() => setRecipeRows([...recipeRows, { itemId: "", quantity: "1", unitCode: "", wasteRate: "0" }])}>
                    <span className="material-symbols-outlined text-sm font-bold">add</span>Thêm dòng
                  </button>
                </div>
                {recipeRows.map((row, index) => {
                  const rowItem = data.items.find((item) => item.id === row.itemId);
                  const rowUnits = rowItem?.unitConversions?.length ? rowItem.unitConversions : rowItem ? [{ id: "base", unitCode: rowItem.unit.toUpperCase(), unitName: rowItem.unit, conversionRate: 1, isDefaultPurchase: true }] : [];
                  return (
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
                      <ItemSelect items={data.items} value={row.itemId} onChange={(itemId) => setRecipeRows(recipeRows.map((candidate, rowIndex) => rowIndex === index ? { ...candidate, itemId, unitCode: "" } : candidate))} />
                    </div>

                    <div className="grid grid-cols-3 gap-3">
                      <div className="flex flex-col gap-1">
                        <span className="text-xs font-bold text-slate-600">Định lượng</span>
                        <input type="number" step="0.001" className="control !mt-0" value={row.quantity} onChange={(e) => setRecipeRows(recipeRows.map((candidate, rowIndex) => rowIndex === index ? { ...candidate, quantity: e.target.value } : candidate))} />
                      </div>

                      <div className="flex flex-col gap-1">
                        <span className="text-xs font-bold text-slate-600">ĐVT</span>
                        <select className="control !mt-0" value={row.unitCode} onChange={(e) => setRecipeRows(recipeRows.map((candidate, rowIndex) => rowIndex === index ? { ...candidate, unitCode: e.target.value } : candidate))}>
                          <option value="">{rowItem ? `${rowItem.unit} (ĐVT tồn kho)` : "ĐVT tồn kho"}</option>
                          {rowUnits.filter((unit) => unit.conversionRate !== 1).map((unit) => (
                            <option key={unit.unitCode} value={unit.unitCode}>{unit.unitName || unit.unitCode}</option>
                          ))}
                        </select>
                      </div>

                      <div className="flex flex-col gap-1">
                        <span className="text-xs font-bold text-slate-600">Hao hụt (%)</span>
                        <input type="number" step="0.1" className="control !mt-0" value={row.wasteRate} onChange={(e) => setRecipeRows(recipeRows.map((candidate, rowIndex) => rowIndex === index ? { ...candidate, wasteRate: e.target.value } : candidate))} />
                      </div>
                    </div>
                  </div>
                  );
                })}
              </div>
              
              <button className="primary-button w-full">Lưu phiên bản</button>
            </form>
          )}
          
          <div className="space-y-5 min-w-0">
            <section className="table-panel shadow-sm">
              <Panel title="Sheet tổng hợp — Giá vốn & giá thành theo định lượng đang áp dụng" reload={loadData} />
              <Table
                headers={[
                  { label: "Nhóm" },
                  { label: "Mã sản phẩm" },
                  { label: "Tên sản phẩm" },
                  { label: "ĐVT tồn kho" },
                  { label: "Giá bán", align: "right" },
                  { label: "Giá cost", align: "right" },
                  { label: "% Cost", align: "right" },
                ]}
              >
                {data.costSummary.map((row) => (
                  <tr key={row.productCode} className="border-t border-slate-100">
                    <Cell><span className={`status ${row.group === "FINISHED" ? "bg-blue-50 text-blue-700" : "bg-violet-50 text-violet-700"}`}>{row.group}</span></Cell>
                    <Cell><CopyableText value={row.productCode}><b>{row.productCode}</b></CopyableText><small>V{row.version}</small></Cell>
                    <Cell>{row.productName}</Cell>
                    <Cell>{row.stockUnit}{row.outputConversionRate !== 1 ? <small>1 {row.batchUnit} = {money(row.outputConversionRate)} {row.stockUnit}</small> : null}</Cell>
                    <Cell right>{row.group === "FINISHED" ? `${money(row.sellingPrice)} đ` : "-"}</Cell>
                    <Cell right><b>{row.unitCost >= 100 ? money(row.unitCost) : row.unitCost.toFixed(2)} đ</b></Cell>
                    <Cell right>{row.costRatio !== null ? <b className={row.costRatio > 0.4 ? "text-rose-600" : "text-emerald-700"}>{(row.costRatio * 100).toFixed(1)}%</b> : "-"}</Cell>
                  </tr>
                ))}
              </Table>
            </section>

            <section className="table-panel shadow-sm">
              <Panel title="Chi tiết các phiên bản định lượng" reload={loadData} />
              <Table
                headers={[
                  { label: "Sản phẩm" },
                  { label: "Phiên bản" },
                  { label: "Nguyên liệu" },
                  { label: "Cost / mẻ", align: "right" },
                  { label: "Giá bán", align: "right" },
                  { label: "Tỷ lệ cost", align: "right" },
                ]}
              >
                {data.recipes.map((recipe) => (
                  <tr key={recipe.id} className="border-t border-slate-100">
                    <Cell><b>{recipe.productCode} - {recipe.productName}</b><small>Mẻ: {recipe.unit}{recipe.outputConversionRate !== 1 ? ` (= ${money(recipe.outputConversionRate)} ĐVT tồn)` : ""}</small></Cell>
                    <Cell>V{recipe.version}<small>Áp dụng {new Date(recipe.effectiveFrom).toLocaleDateString("vi-VN")}{recipe.status === "ACTIVE" ? "" : " · cũ"}</small></Cell>
                    <Cell>{recipe.lines.map((line) => `${line.item.name}: ${line.quantity}${line.unitCode ? ` ${line.unitCode}` : ""} (+${line.wasteRate}%)`).join(", ")}</Cell>
                    <Cell right><b>{money(recipe.estimatedCost)} đ</b></Cell>
                    <Cell right>{money(recipe.sellingPrice)} đ</Cell>
                    <Cell right>{recipe.sellingPrice > 0 ? `${(recipe.estimatedCost / recipe.sellingPrice * 100).toFixed(1)}%` : "-"}</Cell>
                  </tr>
                ))}
              </Table>
            </section>
          </div>
        </div>
      )}

      {active === "production" && canCreate && (
        <section className="bg-white border border-indigo-200 rounded-lg p-5 shadow-sm mb-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-bold text-slate-800 flex items-center gap-2">
                <span className="material-symbols-outlined text-indigo-600">account_tree</span>
                Rã nguyên liệu từ doanh thu
              </h2>
              <p className="text-xs text-slate-500 mt-1 max-w-2xl leading-relaxed">
                Lấy số món đã bán từ import doanh thu (chưa cần import thêm file nào), rã theo định lượng đang áp dụng
                theo thứ tự <b>bán thành phẩm → thành phẩm → combo</b>, rồi tự sinh phiếu xuất chế biến, nhập chế biến và xuất bán.
              </p>
            </div>
            <div className="rounded-lg border border-indigo-100 bg-indigo-50 px-3 py-2 text-xs text-indigo-800">
              Đang chờ rã: <b>{data.pendingSales.total}</b> dòng doanh thu
            </div>
          </div>
          <div className="grid md:grid-cols-5 gap-3 mt-4">
            <Input label="Cửa hàng">
              <select className="control" value={explodeForm.branchCode} onChange={(e) => setExplodeForm({ ...explodeForm, branchCode: e.target.value })}>
                {visibleStoreOptions(user).map((option) => <option key={option.code} value={option.code}>{storeLabel(option.code)}</option>)}
              </select>
            </Input>
            <Input label="Từ ngày bán">
              <input type="date" className="control" value={explodeForm.dateFrom} onChange={(e) => setExplodeForm({ ...explodeForm, dateFrom: e.target.value })} />
            </Input>
            <Input label="Đến ngày bán">
              <input type="date" className="control" value={explodeForm.dateTo} onChange={(e) => setExplodeForm({ ...explodeForm, dateTo: e.target.value })} />
            </Input>
            <Input label="Kho xuất NVL">
              <select className="control" value={explodeForm.warehouseCode} onChange={(e) => setExplodeForm({ ...explodeForm, warehouseCode: e.target.value })}>
                {warehouseOptions.filter((warehouse) => warehouse.branch === explodeForm.branchCode || !warehouse.branch).map((warehouse) => (
                  <option key={warehouse.code} value={warehouse.code}>{warehouse.name || warehouse.code}</option>
                ))}
              </select>
            </Input>
            <Input label="Kho nhập BTP/TP">
              <select className="control" value={explodeForm.toWarehouseCode} onChange={(e) => setExplodeForm({ ...explodeForm, toWarehouseCode: e.target.value })}>
                {warehouseOptions.filter((warehouse) => warehouse.branch === explodeForm.branchCode || !warehouse.branch).map((warehouse) => (
                  <option key={warehouse.code} value={warehouse.code}>{warehouse.name || warehouse.code}</option>
                ))}
              </select>
            </Input>
          </div>
          {data.pendingSales.byDay.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {data.pendingSales.byDay.slice(0, 12).map((day) => (
                <span key={`${day.saleDate}-${day.branchCode}`} className="status bg-slate-100 text-slate-600">
                  {new Date(day.saleDate).toLocaleDateString("vi-VN")} · {storeLabel(day.branchCode)}: {day.rowCount} dòng / {money(day.totalQuantity)} món
                </span>
              ))}
            </div>
          )}
          <button
            type="button"
            disabled={exploding}
            className="primary-button mt-4"
            onClick={async () => {
              setExploding(true);
              try {
                await send({ action: "EXPLODE_PRODUCTION", ...explodeForm }, "Đã rã nguyên liệu và sinh phiếu chế biến + xuất bán.");
              } finally {
                setExploding(false);
              }
            }}
          >
            <span className="material-symbols-outlined text-lg">bolt</span>
            {exploding ? "Đang rã nguyên liệu..." : "Rã nguyên liệu & sinh phiếu"}
          </button>
        </section>
      )}

      {active === "production" && (
        <div className="grid lg:grid-cols-[380px_1fr] gap-5">
          {canCreate && (
            <form onSubmit={(e) => { e.preventDefault(); void send({ action: "PRODUCE_SEMI_FINISHED", ...productionForm }, "Đã ghi nhận chế biến bán thành phẩm."); }} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 h-fit shadow-sm">
              <h2 className="font-bold text-slate-800">Chế biến bán thành phẩm (thủ công)</h2>
              <Input label="Mã bán thành phẩm">
                <input data-input-kind="code" className="control" value={productionForm.productCode} onChange={(e) => setProductionForm({ ...productionForm, productCode: e.target.value })} />
              </Input>
              <div className="grid grid-cols-2 gap-3">
                <Input label="Số lượng">
                  <input type="number" step="0.001" className="control" value={productionForm.productQuantity} onChange={(e) => setProductionForm({ ...productionForm, productQuantity: e.target.value })} />
                </Input>
                <Input label="Cửa hàng">
                  <select className="control" value={productionForm.branchCode} onChange={(e) => setProductionForm({ ...productionForm, branchCode: e.target.value })}>
                    {visibleStoreOptions(user).map((option) => <option key={option.code} value={option.code}>{storeLabel(option.code)}</option>)}
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
            {canCreate && (() => {
              const runCodes = [...new Set(data.transactions
                .filter((row) => (row.referenceCode || "").startsWith("RA-"))
                .map((row) => row.referenceCode as string))].slice(0, 6);
              if (runCodes.length === 0) return null;
              return (
                <div className="px-5 pb-3 flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-bold text-slate-600">Hoàn tác lần rã:</span>
                  {runCodes.map((runCode) => (
                    <button
                      key={runCode}
                      type="button"
                      className="status bg-rose-50 text-rose-700 hover:bg-rose-100 cursor-pointer"
                      title={`Hoàn kho + xoá mọi phiếu của ${runCode}, trả doanh thu về trạng thái chờ rã`}
                      onClick={() => { if (window.confirm(`Hoàn tác toàn bộ lần rã ${runCode}?`)) void send({ action: "REVERT_EXPLOSION", runCode }, `Đã hoàn tác lần rã ${runCode}.`); }}
                    >
                      ↩ {runCode}
                    </button>
                  ))}
                </div>
              );
            })()}
            <Table headers={[{ label: "Chứng từ" }, { label: "Loại" }, { label: "Kho" }, { label: "Mặt hàng" }]}>
              {data.transactions.filter((row) => row.transactionType.includes("CHE_BIEN") || (row.referenceCode || "").startsWith("RA-")).map((row) => (
                <tr key={row.id} className="border-t border-slate-100">
                  <Cell><CopyableText value={row.code}><b>{row.code}</b></CopyableText><small>{new Date(row.transactionDate).toLocaleDateString("vi-VN")}{row.referenceCode ? ` · ${row.referenceCode}` : ""}</small></Cell>
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
                    {visibleStoreOptions(user).map((option) => <option key={option.code} value={option.code}>{storeLabel(option.code)}</option>)}
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
                  <Cell><CopyableText value={row.code}><b>{row.code}</b></CopyableText><small>{new Date(row.stocktakeDate).toLocaleDateString("vi-VN")} · {row.status}</small></Cell>
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
        <div className="grid lg:grid-cols-[420px_1fr] gap-5">
          {canCreate && (
            <form onSubmit={(e) => {
              e.preventDefault();
              if (wasteForm.mode === "RECIPE") {
                void send({ action: "RECORD_WASTE", ...wasteForm }, "Đã xuất hủy nguyên liệu theo định lượng món.");
                return;
              }
              void send({
                action: "RECORD_WASTE",
                ...wasteForm,
                recipeId: "",
                lines: wasteRows.filter((row) => row.itemId).map((row) => ({ itemId: row.itemId, inputQuantity: row.quantity, inputUnitCode: row.unitCode || undefined })),
              }, "Đã ghi nhận phiếu xuất hủy.");
            }} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 h-fit shadow-sm">
              <h2 className="font-bold text-slate-800">Ghi nhận hủy hàng</h2>

              <Input label="Loại hủy">
                <select className="control" value={wasteForm.wasteType} onChange={(e) => setWasteForm({ ...wasteForm, wasteType: e.target.value })}>
                  {wasteTypeOptions.map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}
                </select>
              </Input>

              <Input label="Hủy theo">
                <select className="control" value={wasteForm.mode} onChange={(e) => setWasteForm({ ...wasteForm, mode: e.target.value })}>
                  <option value="ITEMS">Chọn mặt hàng trực tiếp (kể cả thành phẩm)</option>
                  <option value="RECIPE">Theo món — rã định lượng ra nguyên liệu</option>
                </select>
              </Input>

              {wasteForm.mode === "RECIPE" ? (<>
                <Input label="Sản phẩm">
                  <select className="control" value={wasteForm.recipeId} onChange={(e) => setWasteForm({ ...wasteForm, recipeId: e.target.value })}>{data.recipes.map((recipe) => <option key={recipe.id} value={recipe.id}>{recipe.productCode} - {recipe.productName} (V{recipe.version})</option>)}</select>
                </Input>
                <Input label="Số lượng món hủy">
                  <input type="number" min="0.01" step="0.01" className="control" value={wasteForm.productQuantity} onChange={(e) => setWasteForm({ ...wasteForm, productQuantity: e.target.value })} />
                </Input>
              </>) : (
                <div className="space-y-3 border border-slate-100 rounded-lg p-3.5 bg-slate-50/50">
                  <div className="flex items-center justify-between border-b border-slate-200/60 pb-2">
                    <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Mặt hàng hủy</h3>
                    <button type="button" className="text-xs font-bold text-blue-600 hover:underline flex items-center gap-0.5" onClick={() => setWasteRows([...wasteRows, { itemId: "", quantity: "1", unitCode: "" }])}>
                      <span className="material-symbols-outlined text-sm font-bold">add</span>Thêm dòng
                    </button>
                  </div>
                  {wasteRows.map((row, index) => {
                    const rowItem = data.items.find((item) => item.id === row.itemId);
                    const rowUnits = rowItem?.unitConversions?.length ? rowItem.unitConversions : rowItem ? [{ id: "base", unitCode: rowItem.unit.toUpperCase(), unitName: rowItem.unit, conversionRate: 1, isDefaultPurchase: true }] : [];
                    return (
                      <div key={index} className="bg-white border border-slate-200 rounded-xl p-3 space-y-2 shadow-sm">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Hàng #{index + 1}</span>
                          {wasteRows.length > 1 && (
                            <button type="button" className="text-xs font-bold text-rose-600 hover:underline" onClick={() => setWasteRows(wasteRows.filter((_, rowIndex) => rowIndex !== index))}>Xóa</button>
                          )}
                        </div>
                        <ItemSelect items={data.items} value={row.itemId} onChange={(itemId) => {
                          const item = data.items.find((candidate) => candidate.id === itemId);
                          setWasteRows(wasteRows.map((candidate, rowIndex) => rowIndex === index ? { ...candidate, itemId, unitCode: item?.unit.toUpperCase() || "" } : candidate));
                        }} />
                        <div className="grid grid-cols-2 gap-3">
                          <input type="number" step="0.001" min="0" className="control" value={row.quantity} placeholder="Số lượng"
                            onChange={(e) => setWasteRows(wasteRows.map((candidate, rowIndex) => rowIndex === index ? { ...candidate, quantity: e.target.value } : candidate))} />
                          <select className="control" value={row.unitCode} onChange={(e) => setWasteRows(wasteRows.map((candidate, rowIndex) => rowIndex === index ? { ...candidate, unitCode: e.target.value } : candidate))}>
                            {rowUnits.map((unit) => <option key={unit.unitCode} value={unit.unitCode}>{unit.unitName || unit.unitCode}</option>)}
                          </select>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <Input label="Cửa hàng">
                  <select
                    value={wasteForm.branchCode}
                    onChange={(e) => setWasteForm({ ...wasteForm, branchCode: e.target.value })}
                    className="control"
                  >
                    {visibleStoreOptions(user).map((option) => (
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
                    {warehouseOptions.filter((warehouse) => warehouse.branch === wasteForm.branchCode || !warehouse.branch).map((warehouse) => (
                      <option key={warehouse.code} value={warehouse.code}>{warehouse.name || warehouse.code}</option>
                    ))}
                  </select>
                </Input>
              </div>

              <Input label="Mã giao dịch POS / tham chiếu">
                <input data-input-kind="code" className="control" value={wasteForm.referenceCode} onChange={(e) => setWasteForm({ ...wasteForm, referenceCode: e.target.value })} />
              </Input>

              <Input label="Ghi chú">
                <textarea className="control h-20 resize-none" value={wasteForm.note} onChange={(e) => setWasteForm({ ...wasteForm, note: e.target.value })} />
              </Input>

              <button className="primary-button w-full">
                <span className="material-symbols-outlined text-lg">delete_sweep</span>Ghi nhận hủy
              </button>
            </form>
          )}

          <div className="space-y-5 min-w-0">
            <section className="table-panel shadow-sm">
              <Panel title="Mã hàng hủy nhiều nhất (theo trị giá)" reload={loadData} />
              <Table
                headers={[
                  { label: "Mặt hàng" },
                  { label: "Loại" },
                  { label: "SL hủy", align: "right" },
                  { label: "Hết hạn sử dụng", align: "right" },
                  { label: "Không đảm bảo chất lượng", align: "right" },
                  { label: "Trị giá hủy", align: "right" },
                ]}
              >
                {data.wasteReport.map((row) => (
                  <tr key={row.itemCode} className="border-t border-slate-100">
                    <Cell><b><CopyableText value={row.itemCode} /></b><small>{row.itemName}</small></Cell>
                    <Cell>{row.itemType}</Cell>
                    <Cell right><b>{money(row.totalQuantity)}</b> {row.unit}</Cell>
                    <Cell right>{row.bySubType.HET_HAN_SU_DUNG ? `${money(row.bySubType.HET_HAN_SU_DUNG.quantity)} ${row.unit}` : "-"}</Cell>
                    <Cell right>{row.bySubType.KHONG_DAM_BAO_CHAT_LUONG ? `${money(row.bySubType.KHONG_DAM_BAO_CHAT_LUONG.quantity)} ${row.unit}` : "-"}</Cell>
                    <Cell right><b className="text-rose-600">{money(row.totalValue)} đ</b></Cell>
                  </tr>
                ))}
              </Table>
            </section>

            <section className="table-panel shadow-sm">
              <Panel title="Phiếu hủy gần nhất" reload={loadData} />
              <Table headers={[{ label: "Chứng từ" }, { label: "Loại hủy" }, { label: "Nhà hàng / Kho" }, { label: "Mặt hàng" }, { label: "Trị giá", align: "right" }]}>
                {data.transactions.filter((row) => row.transactionType === "XUAT_HUY").map((row) => (
                  <tr key={row.id} className="border-t border-slate-100">
                    <Cell><CopyableText value={row.code}><b>{row.code}</b></CopyableText><small>{new Date(row.transactionDate).toLocaleDateString("vi-VN")}</small></Cell>
                    <Cell><span className="status bg-rose-50 text-rose-700">{wasteSubTypeLabel(row.subType)}</span></Cell>
                    <Cell>{storeLabel(row.branchCode)}<small>{row.warehouseCode}</small></Cell>
                    <Cell>{row.lines.map((line) => `${line.item.name}: ${money(line.quantity)} ${line.item.unit}`).join(", ")}</Cell>
                    <Cell right><b>{money(row.lines.reduce((sum, line) => sum + line.totalCost, 0))} đ</b></Cell>
                  </tr>
                ))}
              </Table>
            </section>
          </div>
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
    NHAP_KIEM_KE: "Nhập điều chỉnh kiểm kê",
    NHAP_DIEU_CHUYEN: "Nhập điều chuyển",
    XUAT_BAN: "Xuất bán",
    XUAT_HUY: "Xuất hủy",
    XUAT_TEST_MON: "Xuất test món",
    XUAT_KHAC: "Xuất khác",
    XUAT_CHE_BIEN: "Xuất chế biến",
    XUAT_KIEM_KE: "Xuất điều chỉnh kiểm kê",
    XUAT_DIEU_CHUYEN: "Xuất điều chuyển",
    DIEU_CHUYEN: "Điều chuyển kho",
  };
  return map[type] || type;
}

function wasteSubTypeLabel(subType: string | null): string {
  if (subType === "HET_HAN_SU_DUNG") return "Hết hạn sử dụng";
  if (subType === "KHONG_DAM_BAO_CHAT_LUONG") return "Không đảm bảo chất lượng";
  return "Chưa phân loại";
}

function Input({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block text-xs font-bold text-slate-600">{label}{children}</label>; }
function ItemSelect({ items, value, onChange }: { items: Item[]; value: string; onChange: (value: string) => void }) { return <select className="control" value={value} onChange={(e) => onChange(e.target.value)}><option value="">Chọn mặt hàng</option>{items.map((item) => <option key={item.id} value={item.id}>{item.code} - {item.name}</option>)}</select>; }
function Panel({ title, reload }: { title: string; reload: () => void }) { return <div className="p-5 flex justify-between"><h2 className="font-bold text-slate-800">{title}</h2><button type="button" title="Tải lại" onClick={reload} className="icon-button"><span className="material-symbols-outlined text-lg">refresh</span></button></div>; }

function Table({
  headers,
  children,
  tableClassName = "",
}: {
  headers: { label: string; align?: "left" | "right" }[];
  children: React.ReactNode;
  tableClassName?: string;
}) {
  return (
    <div className="overflow-x-auto max-h-[580px] overflow-y-auto custom-scrollbar">
      <table className={`w-full text-sm ${tableClassName}`}>
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
