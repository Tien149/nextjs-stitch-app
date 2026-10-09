"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { priceDeviation } from "@/lib/supplier-price-list";
import { ModuleFrame, ModuleTabs } from "@/components/ModuleFrame";
import { storeLabel, visibleStoreOptions } from "@/lib/branch-labels";
import { movementTypeLabel } from "@/lib/inventory-movement-labels";
import { goodsGroupKey, normalizeGoodsGroup } from "@/lib/goods-group";
import { recipeValidity, validityInMonth, type RecipeValidity } from "@/lib/recipe-validity";
import { canPerformMenuAction, canOpenPath, SESSION_KEY, filterModuleTabs } from "@/lib/auth-demo";
import { useModuleAuth } from "@/lib/use-module-auth";
import CopyableText from "@/components/CopyableText";
import { ConfirmDeleteDialog, RowActions } from "@/components/RowActions";
import ExportExcelButton from "@/components/ExportExcelButton";
import StickyFilterBar from "@/components/StickyFilterBar";
import { SearchableSelect } from "@/components/SearchableSelect";
import { WAREHOUSE_ITEM_TYPES, inventoryItemTypeLabel, isWarehouseStocktakeItemType } from "@/lib/inventory-scope";
import StocktakeByLocation from "@/components/inventory/StocktakeByLocation";
import StockReportsPanel from "@/components/inventory/StockReportsPanel";
import { DateRangeFilter } from "@/components/DateRangeFilter";
import MissingRecipesPanel from "@/components/inventory/MissingRecipesPanel";
import TransferRequestsPanel, { type TransferRequest } from "@/components/inventory/TransferRequestsPanel";
import StocktakeDocumentsPanel from "@/components/inventory/StocktakeDocumentsPanel";
import StocktakeExplanationPanel from "@/components/inventory/StocktakeExplanationPanel";
import StocktakeResultsPanel from "@/components/inventory/StocktakeResultsPanel";
import { safeConversionRate } from "@/lib/unit-conversion";
import { money, quantity as qty, unitPrice } from "@/lib/format-number";
import { parseVatRate, VAT_RATE_OPTIONS, vatAmountOf, vatRateLabel } from "@/lib/inventory-vat";
import { cogsRepostMessage, type CogsRepostResult } from "@/lib/inventory-cogs";
import { roundVnd } from "@/lib/round-vnd";
import { sumRoundedByRow, sumStockDocuments } from "@/lib/table-subtotal";
import { statValueTextClass } from "@/components/reports/report-ui";
import { STOCKTAKE_APPROVED, STOCKTAKE_PENDING, STOCKTAKE_RETURNED, isStocktakeEditable, stocktakeStatusLabel, stocktakeStatusTone } from "@/lib/stocktake-status";

type UnitConversion = { id: string; unitCode: string; unitName: string | null; conversionRate: number; isDefaultPurchase: boolean };
type Item = { id: string; code: string; name: string; unit: string; itemType: string; category?: string | null; revenueGroup?: string | null; goodsGroup?: string | null; minStock: number; requiresImage: boolean; status?: string | null; note?: string | null; unitConversions?: UnitConversion[] };
type ItemGroup = { id: string; code: string; name: string; group: string | null; subGroup: string | null };
/**
 * Nhóm doanh thu của mặt hàng: danh mục Thu/Chi khai ở nhóm NHÓM DOANH THU (REVENUE_SOURCE).
 * `receiptCategories` là các LOẠI THU quỹ còn lại (thu tiền thừa, thu đặt cọc, NCC hoàn tiền...)
 * — không gán được cho mặt hàng, chỉ dùng để gọi tên mã mà dữ liệu cũ lỡ gán vào đây.
 */
type RevenueGroup = { id: string; code: string; name: string; group: string | null };
type Balance = { id: string; warehouseCode: string; quantity: number; averageCost: number; item: Item };
type Transaction = { id: string; code: string; transactionType: string; subType: string | null; transactionDate: string; branchCode: string; warehouseCode: string; toWarehouseCode: string | null; toBranchCode: string | null; partnerCode: string | null; referenceType: string | null; internalReceivableDebtCode: string | null; internalPayableDebtCode: string | null; referenceCode: string | null; note?: string | null; explosionStatus?: string | null;
  /** Phiếu chế biến của rã BOM trên danh sách Nhập/Xuất kho chỉ mang 3 dòng đầu — số tổng nằm ở đây (xem compactFlowDocument). */
  lineSummary?: { count: number; totalCost: number; vatAmount: number; quantity: number; units: string[]; searchText: string };
  lines: Array<{ id: string; inputQuantity: number | null; inputUnitCode: string | null; conversionRate: number; quantity: number; unitCost: number; inputUnitCost: number | null; totalCost: number; vatRate: number | null; vatAmount: number; item: Item }> };
type Recipe = { id: string; code: string; productCode: string; branchCode?: string | null; productName: string; unit: string; outputConversionRate: number; sellingPrice: number; estimatedCost: number; estimatedUnitCost: number; version: number; effectiveFrom: string; status: string; lines: Array<{ quantity: number; unitCode: string | null; conversionRate: number; wasteRate: number; item: Item; quantityBase?: number; componentUnitCost?: number; lineCost?: number }> };
type CostSummaryRow = { productCode: string; branchCode: string; productName: string; group: string; stockUnit: string; batchUnit: string; outputConversionRate: number; sellingPrice: number; unitCost: number; costRatio: number | null; version: number; appliedFrom?: string; appliedTo?: string };
type WasteReportRow = { itemCode: string; itemName: string; unit: string; itemType: string; totalQuantity: number; totalValue: number; documentCount: number; bySubType: Record<string, { quantity: number; value: number }> };
/** Một dòng gom của GET view=waste-report: mặt hàng × loại hủy × nhà hàng trong khoảng thời gian. */
type WasteReportLine = { itemCode: string; itemName: string; unit: string; itemType: string; goodsGroup: string | null; subType: string; branchCode: string; quantity: number; value: number; documentCount: number };
type PendingSales = {
  total: number;
  byDay: Array<{ saleDate: string; branchCode: string; rowCount: number; totalQuantity: number }>;
  /** Danh sách xuất bán chờ rã gom theo mã hàng — số lượng sẽ chạy định lượng (chỉ Đồ ăn / Đồ uống). */
  byItem: Array<{ productCode: string; productName: string; revenueSource: string; rowCount: number; totalQuantity: number }>;
  /** Điều chuyển bán thành phẩm + kiểm dư bán thành phẩm chờ rã (khách chốt 28/09/2026). */
  sources?: Array<{
    kind: "TRANSFER" | "STOCKTAKE";
    code: string;
    date: string;
    branchCode: string;
    warehouseCode: string;
    items: Array<{ itemCode: string; itemName: string; unit: string; quantity: number }>;
  }>;
};
type CostingProduct = { productCode: string; productName: string; itemType: string; batchCost: number; unitCost: number; outputConversionRate: number; sellingPrice: number };
type CostingResult = { costingDate: string; branchCode: string; materialCount: number; updatedBalances: number; levels: Array<{ level: number; products: CostingProduct[] }> };
type Warehouse = { id: string; code: string; name: string; branch: string | null; group?: string | null };
type Partner = { code: string; name: string; group: string | null; status: string };
type MovementByType = Record<string, { inbound: number; outbound: number; inboundValue?: number; outboundValue?: number }>;
type StockSummary = { item: Item; warehouseCode: string; openingQuantity: number; openingValue?: number; inboundQuantity: number; inboundValue?: number; outboundQuantity: number; outboundValue?: number; closingQuantity: number; averageCost: number; closingValue: number; movementByType?: MovementByType };
type StockMovement = { transactionId: string; code: string; transactionType: string; subType?: string | null; transactionDate: string; branchCode?: string; warehouseCode: string; toWarehouseCode: string | null; counterpartWarehouseCode?: string | null; itemCode: string; itemName: string; unit: string; itemType?: string; goodsGroup?: string | null; quantity: number; inboundQuantity: number; outboundQuantity: number; unitCost?: number; value: number; referenceCode: string | null; partnerCode?: string | null; partnerName?: string | null; note?: string | null };
type Stocktake = {
  id: string; code: string; stocktakeDate: string; branchCode: string; warehouseCode: string; status: string; explosionStatus?: string | null;
  /** Phiếu đếm theo vị trí — quản lý ở components/inventory/StocktakeByLocation, không ở danh sách kiểu cũ. */
  locationCode?: string | null;
  note?: string | null; createdBy?: string | null; approvedBy?: string | null; returnedReason?: string | null; returnedBy?: string | null;
  lines: Array<{ id: string; systemQuantity: number; actualQuantity: number; varianceQuantity: number; unitCost?: number | null; reason?: string | null; item: Item }>;
};
type ReceivablePOLine = { id: string; itemId: string; orderedQuantity: number; receivedQuantity: number; unitCost: number; item: { code: string; name: string; unit: string } };
type ReceivablePO = { id: string; code: string; supplierName: string; branchCode: string; warehouseCode: string; status: string; lines: ReceivablePOLine[] };
type StocktakeDraftRow = { itemId: string; itemCode: string; itemName: string; unit: string; systemQuantity: number; averageCost: number; actualQuantity: string; unitCost: string; reason: string };
/**
 * Bộ đếm lượt tải (lượt cũ về muộn thì bỏ) và khoảng ngày nhật ký nhập/xuất đang nằm trong
 * `data.stockMovements`. Để ngoài component vì loadData được gọi qua các hàm dựng trong lúc
 * render — useRef/state ở đó bị React Compiler chặn. Mỗi lúc chỉ có một màn Kho mở.
 */
const loadTracker = { seq: 0, movementSeq: 0, movementRange: "" };

/** Tham số khoảng ngày của nhật ký nhập/xuất gửi lên API — ô ngày bỏ trống thì không chặn đầu đó. */
function movementRangeQuery(range: { from: string; to: string }) {
  return new URLSearchParams({ reportFrom: range.from, reportTo: range.to }).toString();
}
type RecipeView = "cost" | "recipes" | "monthly";
const RECIPE_VIEWS: Array<{ id: RecipeView; label: string; icon: string }> = [
  { id: "cost", label: "Giá thành sản phẩm", icon: "price_check" },
  { id: "recipes", label: "Định lượng", icon: "menu_book" },
  { id: "monthly", label: "Thông tin định lượng trong tháng", icon: "fact_check" },
];
type Data = { items: Item[]; balances: Balance[]; transactions: Transaction[]; flowTransactions: Transaction[]; flowTruncated?: boolean; transferRequests?: TransferRequest[]; transferDestinations?: Array<{ code: string; name: string; branch: string | null }>; transferTransactions?: Transaction[]; wasteTransactions?: Transaction[]; warehouseBranches?: Array<{ code: string; branch: string | null }>; recipes: Recipe[]; warehouses: Warehouse[]; stocktakes: Stocktake[]; stockSummary: StockSummary[]; stockMovements: StockMovement[]; itemGroups: ItemGroup[]; revenueGroups: RevenueGroup[]; itemRevenueGroups?: RevenueGroup[]; receiptCategories: RevenueGroup[]; costSummary: CostSummaryRow[]; wasteReport: WasteReportRow[]; pendingSales: PendingSales; partners: Partner[] };
/** Loại hiển thị trên hai màn hình Nhập/Xuất. Điều chuyển hiện ở CẢ hai: vế xuất ở kho đi, vế nhập ở kho nhận. */
const inboundTypes = ["NHAP_MUA", "NHAP_CHE_BIEN", "NHAP_DIEU_CHUYEN", "NHAP_KHAC", "NHAP_KIEM_KE"];
const outboundTypes = ["XUAT_BAN", "XUAT_CHE_BIEN", "XUAT_HUY", "XUAT_DIEU_CHUYEN", "XUAT_TEST_MON", "XUAT_KHAC", "XUAT_KIEM_KE"];
const wasteTypeOptions = [
  { code: "HET_HAN_SU_DUNG", label: "Xuất hủy do hết hạn sử dụng" },
  { code: "KHONG_DAM_BAO_CHAT_LUONG", label: "Xuất hủy do không đảm bảo chất lượng" },
];
// Ngày hôm nay theo giờ Việt Nam: toISOString() là giờ UTC nên trước 7h sáng ra ngày hôm qua.
const today = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

/**
 * Cột SL của phiếu nhập/xuất. Phiếu một mặt hàng thì ghi thẳng số + đơn vị; phiếu xuất bán sinh
 * từ rã nguyên liệu có hàng trăm dòng nhiều đơn vị khác nhau nên cộng dồn là vô nghĩa — ghi tổng
 * theo đơn vị khi cả phiếu cùng đơn vị, còn lại ghi số mặt hàng (bảng Sổ kho xem chi tiết từng dòng).
 */
function flowQuantityText(lines: Array<{ quantity: number; item: { unit: string } }>) {
  if (lines.length === 0) return "-";
  const units = new Set(lines.map((line) => line.item.unit));
  const total = lines.reduce((sum, line) => sum + line.quantity, 0);
  if (units.size === 1) return `${qty(total)} ${lines[0].item.unit}`;
  return `${qty(lines.length)} mặt hàng`;
}

/** Số dòng / tổng tiền / thuế / SL của phiếu — đọc `lineSummary` khi phiếu đã bị rút gọn dòng. */
function documentLineCount(transaction: Transaction) {
  return transaction.lineSummary?.count ?? transaction.lines.length;
}
function documentTotalCost(transaction: Transaction) {
  return transaction.lineSummary?.totalCost ?? transaction.lines.reduce((sum, line) => sum + line.totalCost, 0);
}
function documentVat(transaction: Transaction) {
  return transaction.lineSummary?.vatAmount ?? transaction.lines.reduce((sum, line) => sum + (line.vatAmount || 0), 0);
}
function documentQuantityText(transaction: Transaction) {
  const summary = transaction.lineSummary;
  if (!summary) return flowQuantityText(transaction.lines);
  return summary.units.length === 1 ? `${qty(summary.quantity)} ${summary.units[0]}` : `${qty(summary.count)} mặt hàng`;
}

function buildStocktakeRows(warehouseCode: string, balances: Balance[], fallbackItems: Item[]): StocktakeDraftRow[] {
  // Chưa có kho (cửa hàng chưa khai kho) thì không dựng danh sách — trước đây rơi xuống 20 mặt
  // hàng đầu tiên của danh mục, trông như đang kiểm một kho nào đó.
  if (!warehouseCode) return [];
  const rows = balances
    .filter((balance) => balance.warehouseCode === warehouseCode && isWarehouseStocktakeItemType(balance.item.itemType))
    .map((balance) => ({
      itemId: balance.item.id,
      itemCode: balance.item.code,
      itemName: balance.item.name,
      unit: balance.item.unit,
      systemQuantity: balance.quantity,
      averageCost: balance.averageCost,
      actualQuantity: String(balance.quantity),
      unitCost: "",
      reason: "",
    }));
  if (rows.length > 0) return rows;
  return fallbackItems.filter((item) => isWarehouseStocktakeItemType(item.itemType)).slice(0, 20).map((item) => ({
    itemId: item.id,
    itemCode: item.code,
    itemName: item.name,
    unit: item.unit,
    systemQuantity: 0,
    averageCost: 0,
    actualQuantity: "0",
    unitCost: "",
    reason: "",
  }));
}

export default function InventoryPage() {
  const href = "/inventory";
  const { user, loading } = useModuleAuth(href);
  const [active, setActive] = useState("stock");
  const [data, setData] = useState<Data>({ items: [], balances: [], transactions: [], flowTransactions: [], recipes: [], warehouses: [], stocktakes: [], stockSummary: [], stockMovements: [], itemGroups: [], revenueGroups: [], receiptCategories: [], costSummary: [], wasteReport: [], pendingSales: { total: 0, byDay: [], byItem: [] }, partners: [] });
  const [message, setMessageText] = useState("");
  /**
   * Bấm lại một nút và nhận ĐÚNG lời báo lỗi như lần trước thì `message` không đổi giá trị,
   * React không render lại gì và hiệu ứng cuộn cũng không chạy — nhìn y như nút chết, không
   * có phản hồi nào (khách báo 21/09/2026: "bấm rã cả tháng không thấy trigger gì").
   * Bộ đếm này để mỗi lần đặt thông báo đều là một sự kiện mới, kể cả khi chữ giống hệt.
   */
  const [messageSeq, setMessageSeq] = useState(0);
  const setMessage = (text: string) => { setMessageText(text); setMessageSeq((seq) => seq + 1); };
  const messageRef = useRef<HTMLParagraphElement>(null);
  const [reportStore, setReportStore] = useState("ALL");
  // Ô tìm mã / tên hàng của tab Tồn kho — áp cho cả ba bảng của tab.
  const [stockSearch, setStockSearch] = useState("");
  const [reportWarehouse, setReportWarehouse] = useState("ALL");
  /** Nhóm hàng hóa của bộ lọc tab Tồn kho: "ALL", tên nhóm, hoặc "__NONE__" = chưa gán nhóm. */
  const [reportGoodsGroup, setReportGoodsGroup] = useState("ALL");
  /** Khoảng ngày của bảng "Chi tiết phát sinh theo loại giao dịch" — trước đây luôn cắt 100 dòng cuối. */
  const [reportRange, setReportRange] = useState({ from: daysAgo(90), to: today() });
  // Bộ lọc hai màn hình Nhập kho / Xuất kho: theo nhà hàng + theo loại nhập/xuất.
  const [flowBranch, setFlowBranch] = useState("ALL");
  /** Lọc theo NCC / đối tác của phiếu. "NONE" = chỉ những phiếu chưa khai đối tác. */
  const [flowPartner, setFlowPartner] = useState("ALL");
  /** Lọc theo kho của dòng (điều chuyển: kho đi ở màn Xuất, kho nhận ở màn Nhập) — khách yêu cầu 03/10/2026. */
  const [flowWarehouse, setFlowWarehouse] = useState("ALL");
  // Ô tìm mã / tên hàng (hoặc số phiếu) của hai màn Nhập kho / Xuất kho.
  const [flowSearch, setFlowSearch] = useState("");
  // Bộ lọc danh sách phiếu điều chuyển — khoảng ngày dùng chung flowRange (tải lại từ máy chủ).
  const [transferFromWarehouse, setTransferFromWarehouse] = useState("ALL");
  const [transferToWarehouse, setTransferToWarehouse] = useState("ALL");
  // Cửa hàng: phiếu mà cửa hàng này là bên chuyển HOẶC bên nhận. Ô tìm: mã / tên hàng, số phiếu.
  const [transferStore, setTransferStore] = useState("ALL");
  const [transferSearch, setTransferSearch] = useState("");
  // Bộ lọc danh sách phiếu hủy — khoảng ngày cũng dùng chung flowRange (tải lại từ máy chủ).
  const [wasteStore, setWasteStore] = useState("ALL");
  /** Lọc danh sách phiếu hủy theo loại hủy (NONE = chưa phân loại) + chọn nhiều phiếu để gán loại hủy (03/10/2026). */
  const [wasteSubTypeFilter, setWasteSubTypeFilter] = useState("ALL");
  const [selectedWasteIds, setSelectedWasteIds] = useState<string[]>([]);
  const [bulkWasteSubType, setBulkWasteSubType] = useState("HET_HAN_SU_DUNG");
  /** Bộ lọc "Mã hàng hủy nhiều nhất": tháng ("" = mọi thời gian), loại hủy, nhà hàng, loại hàng, nhóm hàng hóa. */
  const [wasteReportFilter, setWasteReportFilter] = useState({ from: "", to: "", subType: "ALL", branch: "ALL", itemType: "ALL", goodsGroup: "ALL", search: "" });
  const [wasteReportRows, setWasteReportRows] = useState<WasteReportLine[] | null>(null);
  const [inboundType, setInboundType] = useState("ALL");
  const [outboundType, setOutboundType] = useState("ALL");
  /** Khoảng NGÀY CHỨNG TỪ của danh sách phiếu nhập/xuất — mặc định 90 ngày gần nhất, gửi lên server. */
  const [flowRange, setFlowRange] = useState({ from: daysAgo(90), to: today() });

  const [itemForm, setItemForm] = useState({ code: "NVL_001", name: "Nguyên liệu mẫu", unit: "g", itemType: "RAW_MATERIAL", category: "", revenueGroup: "", goodsGroup: "", purchaseUnit: "kg", conversionRate: "1000", minStock: "500", requiresImage: false });
  /** Sửa mặt hàng trên bảng danh mục: mã hàng KHÔNG nằm trong form vì API không cho đổi mã. */
  const [editingItem, setEditingItem] = useState<Item | null>(null);
  const [itemEditForm, setItemEditForm] = useState({ name: "", unit: "", itemType: "RAW_MATERIAL", category: "", revenueGroup: "", goodsGroup: "", minStock: "0", requiresImage: false, status: "ACTIVE", note: "" });
  const [itemEditError, setItemEditError] = useState<string | null>(null);
  const [itemEditSaving, setItemEditSaving] = useState(false);
  const [deletingItem, setDeletingItem] = useState<Item | null>(null);
  /** Sửa / xoá phiếu kho ngay trên bảng phiếu của ba tab Nhập / Xuất / Điều chuyển. */
  const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null);
  const [transactionEditForm, setTransactionEditForm] = useState({ transactionDate: "", warehouseCode: "", toWarehouseCode: "", partnerCode: "", subType: "", referenceCode: "", note: "" });
  const [transactionEditLines, setTransactionEditLines] = useState<Array<{ key: string; itemId: string; quantity: string; unitCode: string; unitCost: string; baseUnitCost: number; vatRate: string; vatAmount: string }>>([]);
  const [transactionEditError, setTransactionEditError] = useState<string | null>(null);
  const [transactionEditSaving, setTransactionEditSaving] = useState(false);
  const [deletingTransaction, setDeletingTransaction] = useState<Transaction | null>(null);
  const [transactionDeleteError, setTransactionDeleteError] = useState<string | null>(null);
  const [transactionDeleting, setTransactionDeleting] = useState(false);
  const [itemDeleteError, setItemDeleteError] = useState<string | null>(null);
  const [itemDeleting, setItemDeleting] = useState(false);
  const [itemSearch, setItemSearch] = useState("");
  const [recipeSearch, setRecipeSearch] = useState("");
  const [approvingStocktake, setApprovingStocktake] = useState<{ stocktake: Stocktake; cutoff: string; original: string; max: string } | null>(null);
  /** Lọc kiểu Excel theo nguyên liệu: chỉ hiện ĐÚNG dòng nguyên liệu khớp (kèm món của nó) — 03/10/2026. */
  const [recipeIngredientSearch, setRecipeIngredientSearch] = useState("");
  /** Tháng áp dụng ("" = mọi phiên bản): phiên bản có hiệu lực ngày nào trong tháng thì hiện. */
  const [recipeMonth, setRecipeMonth] = useState("");
  /** Tab nhỏ của tab Định lượng: Giá thành sản phẩm / Định lượng / Thông tin định lượng trong tháng. */
  const [recipeView, setRecipeView] = useState<RecipeView>("cost");
  // Bộ lọc Sheet tổng hợp giá vốn & giá thành: nhóm hàng (thành phẩm / bán thành phẩm) và cửa hàng.
  const [costGroupFilter, setCostGroupFilter] = useState("ALL");
  const [costStoreFilter, setCostStoreFilter] = useState("ALL");
  /**
   * Tháng của sheet giá vốn & giá thành ("" = định lượng đang áp dụng hôm nay). Chọn tháng thì mỗi
   * phiên bản áp dụng trong tháng một dòng kèm khoảng ngày — đổi giá giữa tháng ra nhiều dòng (03/10/2026).
   */
  const [costMonth, setCostMonth] = useState("");
  const [monthlyCost, setMonthlyCost] = useState<{ month: string; rows: CostSummaryRow[]; error?: string } | null>(null);
  const [itemTypeFilter, setItemTypeFilter] = useState("ALL");
  /** ALL / MISSING (chưa gán) / mã danh mục Thu cụ thể — lọc để gán hàng loạt cho nhanh. */
  const [revenueGroupFilter, setRevenueGroupFilter] = useState("ALL");
  /** ALL / MISSING (chưa có nhóm) / khoá nhóm hàng hóa (goodsGroupKey) — khách lọc khi giải trình kiểm kê. */
  const [goodsGroupFilter, setGoodsGroupFilter] = useState("ALL");
  /** ALL / ACTIVE / INACTIVE — mã bị ngưng vẫn phải nhìn thấy được để bật lại hàng loạt. */
  const [itemStatusFilter, setItemStatusFilter] = useState("ALL");
  const [bulkStatusRunning, setBulkStatusRunning] = useState(false);
  const [conversionForm, setConversionForm] = useState({ itemId: "", purchaseUnit: "thung", conversionRate: "24", note: "" });
  const [supplierPrices, setSupplierPrices] = useState<{ key: string; prices: Array<{ itemId: string; unitCode: string; unitPrice: number; vatRate: number | null; stockUnitPrice: number; priceListCode: string; effectiveFrom: string; effectiveTo: string | null }> }>({ key: "", prices: [] });
  const [stockForm, setStockForm] = useState({ transactionType: "NHAP_MUA", branchCode: "HCM", warehouseCode: "KHO_HCM", toWarehouseCode: "KHO_HN", itemId: "", inputUnitCode: "", quantity: "10", unitCost: "100000", vatRate: "KKKNT", vatAmount: "", partnerCode: "", paymentDueDate: "", referenceCode: "", note: "Nhap kho van hanh", allocationMonths: "", transactionDate: today() });
  /** Nhập mua theo PO (GRPO): PO đã duyệt còn hàng chưa nhận + số lượng nhận trên từng dòng. */
  const [receivablePOs, setReceivablePOs] = useState<ReceivablePO[]>([]);
  const [grpoOrderId, setGrpoOrderId] = useState("");
  const [grpoQuantities, setGrpoQuantities] = useState<Record<string, string>>({});
  const [recipeForm, setRecipeForm] = useState({ productCode: "SP_COMBO01", productName: "Combo ban POS", sellingPrice: "45000", unit: "", outputConversionRate: "1", effectiveFrom: today(), itemId: "", quantity: "0.02", wasteRate: "3" });
  /** Cửa hàng áp dụng công thức: rỗng = dùng chung, nhiều mã = các nơi pha giống hệt nhau. */
  const [recipeBranchCodes, setRecipeBranchCodes] = useState<string[]>([]);
  /**
   * `conversionRate` giữ hệ số quy đổi đang lưu trên dòng khi Sửa / Sao chép một định lượng có
   * sẵn (dòng import khai hệ số thẳng, không có trong danh mục quy đổi). Đổi nguyên liệu hay
   * ĐVT thì xoá trống để máy chủ tra lại theo danh mục.
   */
  const [recipeRows, setRecipeRows] = useState([{ itemId: "", quantity: "1", unitCode: "", conversionRate: "", wasteRate: "0" }, { itemId: "", quantity: "20", unitCode: "", conversionRate: "", wasteRate: "5" }]);
  /** Đang sửa thẳng một dòng của bảng phiên bản (gồm mọi bản ghi cửa hàng gom chung dòng đó). Null = form tạo mới. */
  const [recipeEditing, setRecipeEditing] = useState<{ ids: string[]; label: string } | null>(null);
  const recipeFormRef = useRef<HTMLFormElement>(null);
  const [productionForm, setProductionForm] = useState({ productCode: "BTP_SOTCACHUA", productQuantity: "2", branchCode: "HCM", warehouseCode: "KHO_HCM", toWarehouseCode: "KHO_HCM", referenceCode: "", note: "Che bien ban thanh pham" });
  /** Nút Rã nguyên liệu: rã doanh thu chờ (PENDING) theo định lượng, tự sinh phiếu chế biến + xuất bán. */
  /**
   * `kitchenWarehouseCode` / `barWarehouseCode`: đồ ăn trừ kho Bếp, đồ uống trừ kho Bar.
   * Để trống ô nào thì món của bộ phận đó đi theo kho mặc định như trước.
   */
  /** timeTo: "" = rã cả ngày cuối; "11" = chỉ doanh thu ngày cuối bán trước 11:00 (kiểm kê chốt theo giờ). */
  const [explodeForm, setExplodeForm] = useState({ branchCode: "HCM", warehouseCode: "KHO_HCM", toWarehouseCode: "KHO_HCM", kitchenWarehouseCode: "", barWarehouseCode: "", dateFrom: today(), dateTo: today(), timeTo: "", note: "" });
  const [exploding, setExploding] = useState(false);
  /** Nút Tính giá vốn & giá thành cuối kỳ: chạy tuần tự NVL → BTP các cấp → TP → combo. */
  const [costingForm, setCostingForm] = useState({ branchCode: "HCM", costingDate: today() });
  const [costing, setCosting] = useState(false);
  const [costingResult, setCostingResult] = useState<CostingResult | null>(null);
  /** Điều chuyển kho: nhiều dòng hàng, kho nhận có thể thuộc nhà hàng khác. */
  const [transferForm, setTransferForm] = useState({ branchCode: "HCM", warehouseCode: "KHO_HCM", toWarehouseCode: "", transactionDate: today(), referenceCode: "", note: "" });
  const [transferRows, setTransferRows] = useState([{ itemId: "", quantity: "1", unitCode: "" }]);
  const [stocktakeForm, setStocktakeForm] = useState({ branchCode: "HCM", warehouseCode: "KHO_HCM", itemId: "", actualQuantity: "0", reason: "Kiem ke thuc te", stocktakeDate: today() });
  const [stocktakeRows, setStocktakeRows] = useState<StocktakeDraftRow[]>([]);
  /** Phiếu kiểm kê đang sửa (chưa duyệt / bị trả lại) — null = đang lập phiếu mới. */
  const [editingStocktake, setEditingStocktake] = useState<{ id: string; code: string; returnedReason?: string | null } | null>(null);
  /** Tìm nhanh mặt hàng khi kiểm kê trên điện thoại — danh sách kho dài, cuộn tay rất lâu. */
  const [stocktakeSearch, setStocktakeSearch] = useState("");
  /**
   * Nguyên liệu & bao bì đếm THEO VỊ TRÍ rồi kế toán duyệt gộp theo giờ chốt (khách chốt
   * 28/09/2026); "Cả kho" là form cũ — so từng phiếu với tồn kho, vẫn dùng cho bán thành phẩm.
   */
  const [stocktakeMode, setStocktakeMode] = useState<"location" | "warehouse">("location");
  const [wasteForm, setWasteForm] = useState({ wasteType: "HET_HAN_SU_DUNG", mode: "ITEMS", recipeId: "", productQuantity: "1", branchCode: "HCM", warehouseCode: "KHO_HCM", transactionDate: today(), referenceCode: "", note: "" });
  const [wasteRows, setWasteRows] = useState([{ itemId: "", quantity: "1", unitCode: "" }]);
  
  const visibleTabs = useMemo(() => filterModuleTabs(user, href), [user]);

  // Thông báo nằm ở đầu trang nhưng các nút hành động ở tận cuối tab -> cuộn lên cho người dùng thấy kết quả.
  useEffect(() => {
    if (!message) return;
    messageRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    // Nhấp nháy một nhịp để lần báo lỗi thứ hai giống hệt lần đầu vẫn nhìn thấy được.
    const node = messageRef.current;
    if (!node) return;
    node.animate?.(
      [{ opacity: 1 }, { opacity: 0.35 }, { opacity: 1 }],
      { duration: 420, easing: "ease-in-out" },
    );
  }, [message, messageSeq]);

  // Tab mặc định có thể nằm ngoài quyền -> chuyển về tab đầu tiên được phép.
  useEffect(() => {
    if (visibleTabs.length === 0) return;
    if (visibleTabs.some((tab) => tab.id === active)) return;
    const fallback = visibleTabs[0].id;
    window.setTimeout(() => setActive(fallback), 0);
  }, [active, visibleTabs]);
  /**
   * Mọi form trên màn này khởi tạo cứng `branchCode: "HCM"` / `warehouseCode: "KHO_HCM"` —
   * đúng với DB demo, SAI với production (khách đặt mã cửa hàng khác). Select thì hiện option
   * đầu tiên, còn state vẫn ôm mã chết: lọc kho ra rỗng, cảnh báo in tên "cửa hàng HCM" trong
   * khi ô đang chọn NAM MÊ (khách gặp 22/09/2026 ở nút Rã nguyên liệu). Khi biết được danh
   * sách cửa hàng thật của người dùng thì đưa mọi form về cửa hàng đầu tiên trong đó.
   */
  useEffect(() => {
    if (!user) return;
    const codes = visibleStoreOptions(user).map((option) => option.code);
    if (codes.length === 0) return;
    const fix = <T extends { branchCode: string }>(form: T): T =>
      (codes.includes(form.branchCode) ? form : { ...form, branchCode: codes[0], warehouseCode: "", toWarehouseCode: "" });
    // Đẩy sang tick sau như effect chuyển tab ở trên: luật lint của dự án không cho setState
    // đồng bộ trong effect.
    const timer = window.setTimeout(() => {
      setStockForm((form) => fix(form));
      setProductionForm((form) => fix(form));
      setExplodeForm((form) => fix(form));
      setCostingForm((form) => (codes.includes(form.branchCode) ? form : { ...form, branchCode: codes[0] }));
      setTransferForm((form) => fix(form));
      setStocktakeForm((form) => fix(form));
      setWasteForm((form) => fix(form));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [user]);

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
  /**
   * Nút "Import ..." trước đây chỉ xét quyền TẠO của màn Kho, trong khi màn Import là một menu
   * riêng mà vai Quản lý/Viewer không có. Bấm vào là bị đá ngược về Dashboard không một lời
   * giải thích, nên người dùng kết luận "hệ thống không có chỗ đẩy file" (phản hồi 19/09/2026).
   */
  const canOpenImports = user ? canOpenPath(user, "/imports") : false;
  /** Gán Nhóm doanh thu ngay trên bảng danh mục là hành vi SỬA mặt hàng, không phải tạo mới. */
  const canEditItem = user ? canPerformMenuAction(user, href, "edit") : false;
  /** Kế toán: duyệt / trả lại / mở lại phiếu kiểm kê (nhà hàng chỉ Gửi duyệt và sửa). */
  const canApprove = user ? canPerformMenuAction(user, href, "approve") : false;
  /** Ô Nhà hàng của 3 màn kiểm kê: "Tất cả" chỉ khi người xem có hơn một cửa hàng. */
  const stocktakeBranchOptions = [
    ...(visibleStoreOptions(user).length > 1 ? [{ code: "ALL", label: "Tất cả nhà hàng" }] : []),
    ...visibleStoreOptions(user).map((option) => ({ code: option.code, label: storeLabel(option.code) })),
  ];
  /** Gán loại hủy hàng loạt cần quyền sửa (máy chủ chặn BULK_SET_WASTE_SUBTYPE bằng "edit"). */
  const canEditWaste = canEditItem;
  const importTarget = active === "stock"
    ? { tab: "opening-balance", label: "Import tồn kho đầu kỳ" }
    : active === "items"
      ? { tab: "inventory-item", label: "Import danh mục mặt hàng" }
    : active === "recipes"
      ? { tab: "bom", label: "Import định lượng/BOM" }
      : active === "stocktake"
        ? { tab: "stocktake", label: "Import kiểm kê kho" }
        : active === "production"
          ? { tab: "production", label: "Import lệnh chế biến" }
          : active === "waste"
            ? { tab: "waste", label: "Import hủy hàng theo món" }
            : { tab: "inventory-transaction", label: "Import nhập/xuất kho" };
  const selectedStockItem = data.items.find((item) => item.id === stockForm.itemId);
  const stockUnits = selectedStockItem?.unitConversions?.length
    ? selectedStockItem.unitConversions
    : selectedStockItem
      ? [{ id: "base", unitCode: selectedStockItem.unit.toUpperCase(), unitName: selectedStockItem.unit, conversionRate: 1, isDefaultPurchase: true }]
      : [];
  const selectedStockUnit = stockUnits.find((unit) => unit.unitCode === stockForm.inputUnitCode) || stockUnits[0];
  /** Mặt hàng đang chọn ở form "Cập nhật ĐVT quy đổi", để soi ngay ĐVT mua hiện có của nó. */
  const conversionItem = data.items.find((item) => item.id === conversionForm.itemId);
  /**
   * Câu báo sau khi lưu quy đổi. Nói thẳng vừa ghi được gì, vì khai ĐVT mua TRÙNG ĐVT tồn kho
   * thì bảng danh mục không đổi một chữ nào (không có gì để quy đổi) — người khai tưởng nút
   * Lưu không ăn và bấm đi bấm lại.
   */
  const conversionSavedMessage = () => {
    const unit = conversionItem?.unit || "";
    const purchaseUnit = conversionForm.purchaseUnit.trim();
    const label = conversionItem ? `${conversionItem.code}` : "mặt hàng";
    if (unit && purchaseUnit.toUpperCase() === unit.trim().toUpperCase()) {
      return `${label}: ĐVT mua [${purchaseUnit}] trùng ĐVT tồn kho nên không sinh dòng quy đổi — phiếu nhập/xuất vẫn tính theo ${unit}.`;
    }
    return `Đã lưu quy đổi cho ${label}: 1 ${purchaseUnit} = ${conversionForm.conversionRate} ${unit}.`;
  };
  const stockInputQuantity = Number(stockForm.quantity || 0);
  // Dùng chung luật quy đổi với máy chủ (lib/unit-conversion.ts). Đọc thẳng conversionRate thì
  // với mã khai sai "1 LIT = 1000 LIT", ô xem trước ghi 1.000.000 lít trong khi lưu vào chỉ 1.000.
  const stockConversionRate = safeConversionRate(selectedStockItem?.unit || "", selectedStockUnit);
  const stockBaseQuantity = stockInputQuantity * stockConversionRate;
  const stockInputUnitCost = Number(stockForm.unitCost || 0);
  const stockBaseUnitCost = stockInputUnitCost > 0 ? stockInputUnitCost / stockConversionRate : 0;
  const stockLineValue = stockInputUnitCost * stockInputQuantity;
  // Đúng công thức khách chốt: thành tiền trước thuế = SL x ĐG, sau thuế = trước thuế x (1 + thuế suất).
  const stockVatRate = parseVatRate(stockForm.vatRate);
  const stockAmountBeforeTax = roundVnd(stockLineValue);
  const stockAutoVatAmount = vatAmountOf(stockAmountBeforeTax, stockVatRate.ok ? stockVatRate.rate : null);
  // Ô "Tiền thuế" để trống = tự tính; khai số khác thì xem trước phải hiện đúng số sẽ lưu.
  const stockVatAmount = stockForm.vatAmount.trim() === "" ? stockAutoVatAmount : Number(stockForm.vatAmount || 0);
  const stockAmountAfterTax = stockAmountBeforeTax + stockVatAmount;
  // Chuẩn hoá ngay tại chỗ dùng, không chờ effect: render đầu tiên đã phải đúng.
  const explodeStoreCodes = visibleStoreOptions(user).map((option) => option.code);
  const explodeBranchCode = explodeStoreCodes.includes(explodeForm.branchCode)
    ? explodeForm.branchCode
    : (explodeStoreCodes[0] || explodeForm.branchCode);
  const explodeWarehouses = (data.warehouses || []).filter((warehouse) => warehouse.branch === explodeBranchCode || !warehouse.branch);
  /** Gợi ý sẵn kho Bếp / kho Bar theo Nhóm kho đã khai trong danh mục, người dùng vẫn đổi được. */
  const warehouseByGroup = (keyword: string) => explodeWarehouses.find((warehouse) => {
    const group = (warehouse.group || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
    return group.includes(keyword);
  })?.code || "";
  /**
   * Ô để trống = lấy gợi ý theo Nhóm kho đã khai; chọn "NONE" = không tách theo bộ phận, mọi
   * món đi kho mặc định như trước. Giữ lựa chọn của người dùng trong state, phần gợi ý tính
   * tại chỗ nên đổi cửa hàng là ô tự cập nhật mà không cần ghi đè state.
   */
  const pickedDepartmentWarehouse = (picked: string, keyword: string) => {
    if (picked === "NONE") return "";
    const suggestion = warehouseByGroup(keyword);
    const code = picked || suggestion;
    return explodeWarehouses.some((warehouse) => warehouse.code === code) ? code : "";
  };
  const kitchenWarehouseCode = pickedDepartmentWarehouse(explodeForm.kitchenWarehouseCode, "BEP");
  const barWarehouseCode = pickedDepartmentWarehouse(explodeForm.barWarehouseCode, "BAR");
  /**
   * Chế biến chỉ diễn ra ở kho BẾP / kho BAR (khách chốt 27/09/2026): các ô kho của form Rã chỉ
   * liệt kê kho thuộc nhóm bếp / bar của cửa hàng, không còn kho văn phòng / kho tổng. Cửa hàng
   * chưa khai nhóm kho nào thì hiện đủ như cũ để không khoá cứng form. Máy chủ cũng tự đổi kho
   * mặc định lạc về kho bếp — xem resolveExplosionWarehouses.
   */
  const warehousesOfGroup = (keyword: string) => explodeWarehouses.filter((warehouse) =>
    (warehouse.group || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().includes(keyword));
  const kitchenWarehouses = warehousesOfGroup("BEP");
  const barWarehouses = warehousesOfGroup("BAR");
  const productionWarehouses = kitchenWarehouses.length + barWarehouses.length > 0
    ? [...kitchenWarehouses, ...barWarehouses]
    : explodeWarehouses;
  /**
   * Danh mục kho thật (API đã lọc theo cửa hàng và phạm vi kho của người dùng). Từng có hai kho
   * giả "Kho Cua hang 1/2" làm dự phòng khi danh sách rỗng — người dùng kiểm kê NAM MÊ thấy hai
   * kho đó và tưởng hệ thống gán sai kho (28/09/2026). Rỗng thì để rỗng và nói rõ lý do.
   */
  const warehouseOptions = data.warehouses;
  const warehousesOfBranch = (branchCode: string) => warehouseOptions.filter((warehouse) =>
    !warehouse.branch || warehouse.branch.toUpperCase() === (branchCode || "").toUpperCase());
  // Form khởi tạo cứng mã kho demo và đổi cửa hàng không đổi kho: ô select hiện kho đầu tiên
  // trong khi state vẫn giữ mã cũ. Lấy mã hợp lệ theo cửa hàng đang chọn, không thì kho đầu tiên.
  const validWarehouse = (options: Warehouse[], code: string) =>
    (options.some((warehouse) => warehouse.code === code) ? code : options[0]?.code || "");
  const stocktakeWarehouseOptions = warehousesOfBranch(stocktakeForm.branchCode);
  const stocktakeWarehouseCode = validWarehouse(stocktakeWarehouseOptions, stocktakeForm.warehouseCode);
  const productionWarehouseOptions = warehousesOfBranch(productionForm.branchCode);
  const productionWarehouseCode = validWarehouse(productionWarehouseOptions, productionForm.warehouseCode);
  const productionToWarehouseCode = validWarehouse(productionWarehouseOptions, productionForm.toWarehouseCode || productionWarehouseCode);
  /**
   * Danh sách đếm đi theo kho đang chọn: đổi cửa hàng / kho, hoặc tải lại dữ liệu sau khi lưu
   * phiếu thì dựng lại. Đang sửa một phiếu thì giữ nguyên số đã đếm của phiếu đó.
   */
  useEffect(() => {
    if (editingStocktake) return;
    const timer = window.setTimeout(() => {
      setStocktakeForm((form) => (form.warehouseCode === stocktakeWarehouseCode ? form : { ...form, warehouseCode: stocktakeWarehouseCode }));
      setStocktakeRows(buildStocktakeRows(stocktakeWarehouseCode, data.balances, data.items));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [stocktakeWarehouseCode, data.balances, data.items, editingStocktake]);
  const sourceWarehouseOptions = warehouseOptions.filter((warehouse) => warehouse.branch === stockForm.branchCode || !warehouse.branch);
  /**
   * Kho thật của form Nhập/Xuất, Hủy hàng, Điều chuyển — cùng luật với kiểm kê ở trên. Đổi cửa
   * hàng (kể cả lúc tự đưa form về cửa hàng đầu tiên của người dùng) làm mã kho rỗng, ô select
   * vẫn HIỆN kho đầu tiên nên người dùng tưởng đã chọn; bấm Ghi nhận thì máy chủ báo "Cửa hàng và
   * kho là bắt buộc" và phiếu không được tạo (khách gặp 09/10/2026 khi nhập đồng phục).
   */
  const stockWarehouseCode = validWarehouse(sourceWarehouseOptions, stockForm.warehouseCode);
  const wasteWarehouseCode = validWarehouse(warehouseOptions.filter((warehouse) => warehouse.branch === wasteForm.branchCode || !warehouse.branch), wasteForm.warehouseCode);
  const transferWarehouseCode = validWarehouse(warehouseOptions.filter((warehouse) => warehouse.branch === transferForm.branchCode || !warehouse.branch), transferForm.warehouseCode);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setStockForm((form) => (form.warehouseCode === stockWarehouseCode ? form : { ...form, warehouseCode: stockWarehouseCode }));
      setWasteForm((form) => (form.warehouseCode === wasteWarehouseCode ? form : { ...form, warehouseCode: wasteWarehouseCode }));
      setTransferForm((form) => (form.warehouseCode === transferWarehouseCode ? form : { ...form, warehouseCode: transferWarehouseCode }));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [stockWarehouseCode, wasteWarehouseCode, transferWarehouseCode]);
  /**
   * Bộ lọc Cửa hàng của tab Tồn kho: dòng tồn / phát sinh chỉ mang mã kho, nên tra cửa hàng qua
   * danh mục kho (cả kho đã ngưng). Kho không khai cửa hàng thì chỉ hiện khi chọn "Tất cả".
   */
  const branchByWarehouse = new Map<string, string>();
  for (const warehouse of [...warehouseOptions, ...(data.warehouseBranches || [])]) {
    if (warehouse.branch) branchByWarehouse.set(warehouse.code, warehouse.branch.toUpperCase());
  }
  const reportStoreKey = reportStore.toUpperCase();
  const inReportStore = (warehouseCode: string) => reportStore === "ALL" || branchByWarehouse.get(warehouseCode) === reportStoreKey;
  const stockKeyword = foldSearchText(stockSearch.trim());
  const matchesStockGroup = (group: string | null | undefined) => reportGoodsGroup === "ALL" || (reportGoodsGroup === "__NONE__" ? !group : group === reportGoodsGroup);
  const matchesStockSearch = (code: string, name: string) => !stockKeyword
    || foldSearchText(code).includes(stockKeyword) || foldSearchText(name).includes(stockKeyword);
  /**
   * Phiếu kho quy về hai chiều Nhập/Xuất. Điều chuyển góp một dòng cho MỖI màn hình:
   * "Xuất điều chuyển" đứng ở cửa hàng/kho đi, "Nhập điều chuyển" ở cửa hàng/kho nhận.
   */
  const flowRows = (direction: "IN" | "OUT") => data.flowTransactions.flatMap((transaction) => {
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
  /**
   * Form nhập/xuất tay chỉ cho chọn đối tác đang hoạt động, gom theo nhóm của danh mục.
   * Màn Nhập kho đẩy NCC lên đầu, màn Xuất kho đẩy khách hàng lên đầu — đó là nhóm hay chọn nhất
   * ở mỗi màn, khỏi phải cuộn qua nhóm không liên quan.
   */
  const activePartners = data.partners.filter((partner) => partner.status === "ACTIVE");
  /** Nhập mua có khai NCC thì phiếu sinh kèm công nợ phải trả — nói trước để khỏi bất ngờ. */
  const createsPurchasePayable = active === "inbound" && stockForm.transactionType === "NHAP_MUA" && !!stockForm.partnerCode;
  /** Giá Bảng giá NCC của mặt hàng đang nhập (khách yêu cầu 03/10/2026): tham chiếu + cảnh báo lệch. */
  const supplierPriceKey = active === "inbound" && stockForm.transactionType === "NHAP_MUA" && stockForm.partnerCode ? `${stockForm.partnerCode}|${stockForm.branchCode}` : "";
  const listPrice = supplierPrices.key === supplierPriceKey ? supplierPrices.prices.find((price) => price.itemId === stockForm.itemId) : undefined;
  const listPriceDeviation = listPrice && stockBaseUnitCost > 0 ? priceDeviation(stockBaseUnitCost, listPrice.stockUnitPrice) : null;
  const partnerFormGroups = (() => {
    const order = active === "inbound"
      ? ["SUPPLIER", "CUSTOMER", "OTHER_PARTNER"]
      : ["CUSTOMER", "SUPPLIER", "OTHER_PARTNER"];
    const labels: Record<string, string> = { SUPPLIER: "Nhà cung cấp", CUSTOMER: "Khách hàng", OTHER_PARTNER: "Đối tác khác" };
    return order
      .map((group) => ({
        group,
        label: labels[group],
        // Nhóm lạ (hoặc trống) dồn hết vào "Đối tác khác" để không có đối tác nào bị rơi khỏi ô chọn.
        partners: activePartners.filter((partner) => (order.includes(partner.group || "") ? partner.group : "OTHER_PARTNER") === group),
      }))
      .filter((bucket) => bucket.partners.length > 0);
  })();
  /** Tên đối tác để bảng phiếu đọc được — phiếu chỉ lưu mã. Không tra ra thì trả lại chính mã. */
  const partnerName = (code?: string | null) => {
    if (!code) return "";
    return data.partners.find((partner) => partner.code === code)?.name || code;
  };
  const matchesFlowPartner = (row: { transaction: Transaction }) => {
    if (flowPartner === "ALL") return true;
    if (flowPartner === "NONE") return !row.transaction.partnerCode;
    return row.transaction.partnerCode === flowPartner;
  };
  /**
   * Dòng CỘNG cuối bảng (khách yêu cầu 21/09/2026: "cho chị 1 dòng CỘNG bên dưới, kiểu giống
   * subtotal trên excel").
   *
   * Cộng đúng những dòng ĐANG HIỆN sau bộ lọc — giống subtotal của Excel, không phải tổng cả
   * kỳ. Vì vậy luôn in kèm số phiếu để người xem biết mình đang cộng trên bao nhiêu dòng.
   *
   * Số lượng KHÔNG cộng được: mỗi phiếu một ĐVT (GR, ML, CUC, CHAI...), cộng lại thành một số
   * vô nghĩa còn tệ hơn để trống.
   */
  const sumTransactions = (rows: Array<{ transaction: Transaction }>) =>
    sumStockDocuments(rows.map((row) => ({ lines: [{ totalCost: documentTotalCost(row.transaction), vatAmount: documentVat(row.transaction) }] })));

  /**
   * Kho của màn "Rã nguyên liệu từ doanh thu", CHUẨN HOÁ theo cửa hàng đang chọn.
   *
   * Form khởi tạo cứng `warehouseCode: "KHO_HCM"`, mà đổi cửa hàng thì chỉ đổi `branchCode`.
   * Mã kho cũ không còn trong danh sách option nên trình duyệt hiện ô TRỐNG, còn state vẫn
   * giữ mã cũ và `onChange` không bao giờ chạy vì người dùng đâu có đụng vào. Bấm nút là gửi
   * đi mã kho của cửa hàng khác rồi nhận lỗi "Kho X không thuộc cửa hàng Y" — đúng lỗi khách
   * gặp 21/09/2026, và vì lỗi lặp lại y hệt nên nhìn như nút không phản ứng gì.
   */
  const pickWarehouse = (code: string, fallback: string) =>
    (productionWarehouses.some((warehouse) => warehouse.code === code) ? code : fallback);
  // Mặc định kho BẾP của cửa hàng.
  const explodeWarehouseCode = pickWarehouse(explodeForm.warehouseCode, kitchenWarehouseCode || productionWarehouses[0]?.code || "");
  const explodeToWarehouseCode = pickWarehouse(explodeForm.toWarehouseCode, explodeWarehouseCode);

  /** Phiếu chế biến / rã nguyên liệu đang hiện. */
  // Giao dịch chế biến theo khoảng ngày chứng từ (khách yêu cầu 03/10/2026): lấy từ danh sách phiếu
  // theo flowRange. Trước đây lọc từ 100 phiếu mới nhất MỌI loại nên gần như rỗng. Bảng chỉ vẽ
  // PRODUCTION_RENDER_LIMIT phiếu; dòng CỘNG vẫn cộng đủ.
  const productionTransactions = (data.flowTransactions || []).filter((row) =>
    row.transactionType.includes("CHE_BIEN") || (row.referenceCode || "").startsWith("RA-"));

  /** Phiếu hủy đang hiện — dùng chung cho bảng và dòng CỘNG để hai chỗ không lệch nhau. */
  const wasteTransactions = (data.wasteTransactions || [])
    .filter((row) => wasteStore === "ALL" || row.branchCode.toUpperCase() === wasteStore.toUpperCase())
    .filter((row) => wasteSubTypeFilter === "ALL" || (wasteSubTypeFilter === "NONE" ? !row.subType : row.subType === wasteSubTypeFilter));
  const visibleWasteIds = new Set(wasteTransactions.map((row) => row.id));
  const selectedVisibleWasteIds = selectedWasteIds.filter((id) => visibleWasteIds.has(id));
  const allWasteSelected = wasteTransactions.length > 0 && selectedVisibleWasteIds.length === wasteTransactions.length;
  const toggleWasteSelection = (id: string) =>
    setSelectedWasteIds((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]));
  const bulkSetWasteSubType = async () => {
    const ids = selectedVisibleWasteIds;
    if (ids.length === 0) return;
    const payload = await send({ action: "BULK_SET_WASTE_SUBTYPE", ids, subType: bulkWasteSubType }, `Đã cập nhật loại hủy “${wasteSubTypeLabel(bulkWasteSubType)}” cho ${ids.length} phiếu.`) as { updated?: number; locked?: string[] } | null;
    if (!payload) return;
    setSelectedWasteIds([]);
    if (payload.locked?.length) {
      setMessage(`Đã cập nhật ${payload.updated} phiếu. Bỏ qua ${payload.locked.length} phiếu thuộc kỳ đã khoá: ${payload.locked.slice(0, 8).join(", ")}${payload.locked.length > 8 ? "..." : ""}`);
    }
  };

  /**
   * "Mã hàng hủy nhiều nhất": tải theo tháng từ máy chủ (gom mặt hàng × loại hủy × nhà hàng), lọc
   * tiếp loại hủy / nhà hàng / loại hàng / nhóm hàng hóa / mã ngay trên màn hình rồi gom theo mặt hàng.
   */
  const wasteReportLines = wasteReportRows || [];
  const wasteGoodsGroups = [...new Map(wasteReportLines
    .map((line) => normalizeGoodsGroup(line.goodsGroup))
    .filter((name): name is string => Boolean(name))
    .map((name) => [goodsGroupKey(name), name] as const)).entries()].sort((a, b) => a[1].localeCompare(b[1], "vi"));
  const wasteReportKeyword = foldSearchText(wasteReportFilter.search.trim());
  const filteredWasteReport: WasteReportRow[] = (() => {
    const byItem = new Map<string, WasteReportRow>();
    for (const line of wasteReportLines) {
      if (wasteReportFilter.subType !== "ALL" && line.subType !== wasteReportFilter.subType) continue;
      if (wasteReportFilter.branch !== "ALL" && line.branchCode !== wasteReportFilter.branch.toUpperCase()) continue;
      if (wasteReportFilter.itemType !== "ALL" && line.itemType !== wasteReportFilter.itemType) continue;
      if (wasteReportFilter.goodsGroup === "MISSING" && normalizeGoodsGroup(line.goodsGroup)) continue;
      if (!["ALL", "MISSING"].includes(wasteReportFilter.goodsGroup) && goodsGroupKey(line.goodsGroup) !== wasteReportFilter.goodsGroup) continue;
      if (wasteReportKeyword && !foldSearchText(`${line.itemCode} ${line.itemName}`).includes(wasteReportKeyword)) continue;
      const row = byItem.get(line.itemCode) || { itemCode: line.itemCode, itemName: line.itemName, unit: line.unit, itemType: line.itemType, totalQuantity: 0, totalValue: 0, documentCount: 0, bySubType: {} };
      row.totalQuantity += line.quantity;
      row.totalValue += line.value;
      row.documentCount += line.documentCount;
      row.bySubType[line.subType] ||= { quantity: 0, value: 0 };
      row.bySubType[line.subType].quantity += line.quantity;
      row.bySubType[line.subType].value += line.value;
      byItem.set(line.itemCode, row);
    }
    return [...byItem.values()].sort((a, b) => b.totalValue - a.totalValue);
  })();
  const goodsGroupByItemCode = new Map(wasteReportLines.map((line) => [line.itemCode, normalizeGoodsGroup(line.goodsGroup)]));

  /** Phiếu có ít nhất một mặt hàng khớp mã / tên (không phân biệt dấu), hoặc khớp số phiếu. */
  const flowKeyword = foldSearchText(flowSearch.trim());
  const transactionMatchesSearch = (transaction: Transaction, keyword: string) => !keyword
    || foldSearchText(transaction.code).includes(keyword)
    || foldSearchText(transaction.lineSummary?.searchText || "").includes(keyword)
    || transaction.lines.some((line) => foldSearchText(line.item.code).includes(keyword) || foldSearchText(line.item.name).includes(keyword));
  /** Kho chọn được ở ô lọc: kho của nhà hàng đang lọc (hoặc mọi kho khi xem tất cả nhà hàng). */
  const flowWarehouseOptions = warehouseOptions.filter((warehouse) => flowBranch === "ALL" || warehouse.branch === flowBranch || !warehouse.branch);
  const matchesFlowWarehouse = (row: { warehouseCode: string }) =>
    flowWarehouse === "ALL" || (row.warehouseCode || "").toUpperCase() === flowWarehouse.toUpperCase();
  const inboundRows = flowRows("IN").filter((row) =>
    (flowBranch === "ALL" || row.branchCode === flowBranch) && matchesFlowWarehouse(row) && (inboundType === "ALL" || row.displayType === inboundType) && matchesFlowPartner(row)
    && transactionMatchesSearch(row.transaction, flowKeyword));
  const outboundRows = flowRows("OUT").filter((row) =>
    (flowBranch === "ALL" || row.branchCode === flowBranch) && matchesFlowWarehouse(row) && (outboundType === "ALL" || row.displayType === outboundType) && matchesFlowPartner(row)
    && transactionMatchesSearch(row.transaction, flowKeyword));
  /**
   * Chọn loại "Xuất bán" ở màn Xuất kho thì bảng TRẢI TỪNG MẶT HÀNG (khách chốt 03/10/2026):
   * mỗi lần rã gộp cả kỳ thành một phiếu / kho với vài trăm mặt hàng, bảng phiếu chỉ hiện 3 dòng
   * đầu. Ô tìm mã / tên lọc tới từng dòng (gõ số phiếu thì ra cả phiếu).
   */
  const showSaleLines = active === "outbound" && outboundType === "XUAT_BAN";
  const saleLineRows = showSaleLines
    ? outboundRows.flatMap((row) => {
      const wholeDocument = !flowKeyword || foldSearchText(row.transaction.code).includes(flowKeyword);
      return row.transaction.lines
        .filter((line) => wholeDocument || foldSearchText(line.item.code).includes(flowKeyword) || foldSearchText(line.item.name).includes(flowKeyword))
        .map((line) => ({ row, line }));
    }).sort((a, b) =>
      b.row.transaction.transactionDate.localeCompare(a.row.transaction.transactionDate)
      || a.row.warehouseCode.localeCompare(b.row.warehouseCode)
      || a.line.item.name.localeCompare(b.line.item.name, "vi"))
    : [];
  /**
   * Ô chọn NCC chỉ liệt kê đối tác CÓ trên phiếu của màn hình đang xem (đã lọc nhà hàng/loại),
   * để khỏi phải dò giữa hàng trăm đối tác chưa từng phát sinh nhập kho.
   */
  const flowPartnerOptions = (() => {
    const scope = flowRows(active === "inbound" ? "IN" : "OUT").filter((row) =>
      (flowBranch === "ALL" || row.branchCode === flowBranch) && matchesFlowWarehouse(row)
      && (active === "inbound" ? inboundType === "ALL" || row.displayType === inboundType : outboundType === "ALL" || row.displayType === outboundType));
    const codes = new Set<string>();
    let hasBlank = false;
    for (const row of scope) {
      if (row.transaction.partnerCode) codes.add(row.transaction.partnerCode);
      else hasBlank = true;
    }
    // Giữ lại lựa chọn đang chọn dù kỳ/nhà hàng đang xem không có phiếu nào của đối tác đó,
    // nếu không ô chọn tự nhảy về "Tất cả" và bảng lặng lẽ đổi kết quả.
    if (flowPartner !== "ALL" && flowPartner !== "NONE") codes.add(flowPartner);
    const options = [...codes].map((code) => ({ code, name: partnerName(code) }));
    options.sort((left, right) => left.name.localeCompare(right.name, "vi"));
    return { options, hasBlank: hasBlank || flowPartner === "NONE" };
  })();
  const transfersInRange = data.transferTransactions || [];
  const transferKeyword = foldSearchText(transferSearch.trim());
  const transferTransactions = transfersInRange.filter((transaction) => (
    (transferFromWarehouse === "ALL" || transaction.warehouseCode === transferFromWarehouse)
    && (transferToWarehouse === "ALL" || transaction.toWarehouseCode === transferToWarehouse)
    && (transferStore === "ALL"
      || transaction.branchCode.toUpperCase() === transferStore.toUpperCase()
      || (transaction.toBranchCode || transaction.branchCode).toUpperCase() === transferStore.toUpperCase())
    && transactionMatchesSearch(transaction, transferKeyword)
  ));
  // Ô chọn kho lấy từ chính các phiếu trong khoảng ngày (có cả kho đã ngưng / kho nhà hàng
  // khác), gọi tên theo danh mục kho nếu có.
  const transferWarehouseOptions = (pick: (transaction: Transaction) => string | null, selected: string) => {
    const codes = new Set(transfersInRange.map(pick).filter((code): code is string => !!code));
    if (selected !== "ALL") codes.add(selected);
    return [...codes].sort().map((code) => {
      const warehouse = warehouseOptions.find((candidate) => candidate.code === code);
      return { code, name: warehouse ? `${code} — ${warehouse.name}` : code };
    });
  };

  // Điều chuyển không nhận nhóm FINISHED; hủy hàng thì nhận đủ (kể cả FINISHED).
  const transferableItems = data.items.filter((item) => item.itemType !== "FINISHED");
  /** Kho nhận chọn được ở MỌI nhà hàng (máy chủ gửi riêng — `warehouses` chỉ có kho của người xem). */
  const transferDestinationOptions = data.transferDestinations?.length ? data.transferDestinations : warehouseOptions;
  const transferDestination = transferDestinationOptions.find((warehouse) => warehouse.code === transferForm.toWarehouseCode);
  const transferCrossBranch = !!transferDestination && !!transferDestination.branch && transferDestination.branch !== transferForm.branchCode;

  /**
   * Mã đang gán ở ô Nhóm doanh thu nhưng KHÔNG nằm trong danh mục nhóm doanh thu: hoặc là loại
   * thu quỹ gán nhầm từ trước, hoặc là mã đã bị bỏ khỏi danh mục.
   */
  /** Nhóm doanh thu chọn được cho mặt hàng: chỉ nhóm món Bếp / Bar / Phụ thu (máy chủ lọc — 03/10/2026). */
  const itemRevenueOptions = data.itemRevenueGroups ?? data.revenueGroups;
  const isMisassignedRevenueGroup = (code?: string | null) =>
    Boolean(code) && !itemRevenueOptions.some((group) => group.code === code);
  /** Nhãn cho mã gán sai: gọi đúng tên loại thu nếu tra được, không thì nói thẳng là ngoài danh mục. */
  const revenueGroupIssueLabel = (code: string) => {
    const revenueGroup = data.revenueGroups.find((category) => category.code === code);
    if (revenueGroup) return `${code} - ${revenueGroup.name} (không phải nhóm món — chọn lại)`;
    const receipt = data.receiptCategories.find((category) => category.code === code);
    return receipt ? `${code} - ${receipt.name} (loại thu, không phải nhóm doanh thu)` : `${code} (ngoài danh mục nhóm doanh thu)`;
  };

  /** Các nhóm hàng hóa đang có trên danh mục (gom không phân biệt hoa thường), kèm số mã. */
  const goodsGroupOptions = (() => {
    const groups = new Map<string, { key: string; name: string; count: number }>();
    for (const item of data.items) {
      const name = normalizeGoodsGroup(item.goodsGroup);
      if (!name) continue;
      const key = goodsGroupKey(name);
      const current = groups.get(key) || { key, name, count: 0 };
      current.count += 1;
      groups.set(key, current);
    }
    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, "vi"));
  })();
  const itemStatusOf = (item: Item) => (item.status || "ACTIVE").toUpperCase();
  const filteredItems = data.items.filter((item) => {
    if (itemTypeFilter !== "ALL" && item.itemType !== itemTypeFilter) return false;
    if (goodsGroupFilter === "MISSING" && normalizeGoodsGroup(item.goodsGroup)) return false;
    if (!["ALL", "MISSING"].includes(goodsGroupFilter) && goodsGroupKey(item.goodsGroup) !== goodsGroupFilter) return false;
    if (itemStatusFilter !== "ALL" && itemStatusOf(item) !== itemStatusFilter) return false;
    if (revenueGroupFilter === "MISSING" && item.revenueGroup) return false;
    if (revenueGroupFilter === "INVALID" && !isMisassignedRevenueGroup(item.revenueGroup)) return false;
    if (!["ALL", "MISSING", "INVALID"].includes(revenueGroupFilter) && item.revenueGroup !== revenueGroupFilter) return false;
    const keyword = itemSearch.trim().toLowerCase();
    if (!keyword) return true;
    return item.code.toLowerCase().includes(keyword) || item.name.toLowerCase().includes(keyword);
  });
  // Chỉ món bán (thành phẩm, hàng hóa) mới lên doanh thu POS — nguyên liệu thô không cần nhóm
  // doanh thu, đếm cả kho vào đây thì con số cảnh báo vô nghĩa.
  const missingRevenueGroupCount = data.items.filter((item) => (item.itemType === "FINISHED" || item.itemType === "GOODS") && !item.revenueGroup).length;
  // Dữ liệu cũ gán nhầm LOẠI THU (thu tiền thừa, thu đặt cọc...) vào ô nhóm doanh thu: giữ
  // nguyên để không mất dữ liệu, nhưng phải đập vào mắt để người dùng gán lại cho đúng.
  const misassignedRevenueGroupCount = data.items.filter((item) => isMisassignedRevenueGroup(item.revenueGroup)).length;

  // Định lượng khai theo cửa hàng: mỗi nơi lưu một bản, nhưng các nơi pha GIỐNG HỆT nhau thì
  // bảng gom về một dòng và liệt kê cửa hàng — đúng kiểu một mặt hàng có một ĐVT tồn kho kèm
  // nhiều ĐVT mua. Bản dùng chung luôn đứng riêng vì ý nghĩa khác: nó áp cho mọi nơi CHƯA khai.
  const recipeSignature = (recipe: Recipe) => JSON.stringify({
    product: recipe.productCode.toUpperCase(),
    effectiveFrom: String(recipe.effectiveFrom).slice(0, 10),
    unit: recipe.unit,
    outputConversionRate: recipe.outputConversionRate,
    sellingPrice: recipe.sellingPrice,
    status: recipe.status,
    lines: recipe.lines
      .map((line) => [line.item.code, line.quantity, line.unitCode || "", line.conversionRate, line.wasteRate].join("|"))
      .sort(),
  });
  type RecipeGroup = { key: string; recipe: Recipe; branchCodes: string[]; versions: number[]; ids: string[] };
  const groupedRecipes: RecipeGroup[] = (() => {
    const groups = new Map<string, RecipeGroup>();
    for (const recipe of data.recipes) {
      const branchCode = (recipe.branchCode || "").toUpperCase();
      const key = branchCode ? `BRANCH|${recipeSignature(recipe)}` : `SHARED|${recipe.id}`;
      const existing = groups.get(key);
      if (existing) {
        if (branchCode && !existing.branchCodes.includes(branchCode)) existing.branchCodes.push(branchCode);
        if (!existing.versions.includes(recipe.version)) existing.versions.push(recipe.version);
        existing.ids.push(recipe.id);
      } else {
        groups.set(key, { key, recipe, branchCodes: branchCode ? [branchCode] : [], versions: [recipe.version], ids: [recipe.id] });
      }
    }
    return [...groups.values()];
  })();

  // Ô tìm của bảng "Chi tiết các phiên bản định lượng": theo mã / tên món, và cả mã / tên
  // nguyên liệu (tra xem món nào đang dùng một nguyên liệu). Không phân biệt dấu, hoa thường.
  const recipeKeyword = foldSearchText(recipeSearch.trim());
  const ingredientKeyword = foldSearchText(recipeIngredientSearch.trim());
  /** Khoảng hiệu lực từng phiên bản — cùng luật chọn phiên bản lúc rã (lib/recipe-validity.ts). */
  const recipeValidityById = recipeValidity(data.recipes);
  const groupValidity = (ids: string[]): RecipeValidity | null => {
    const ranges = ids.map((id) => recipeValidityById.get(id)).filter((range): range is RecipeValidity => Boolean(range));
    if (ranges.length === 0) return null;
    // Các cửa hàng gom chung một dòng có thể có bản kế tiếp khác ngày: lấy ngày kết thúc muộn nhất.
    return ranges.reduce((acc, range) => ({ from: acc.from < range.from ? acc.from : range.from, to: !acc.to || !range.to ? null : acc.to > range.to ? acc.to : range.to }));
  };
  const lineMatchesIngredient = (line: Recipe["lines"][number]) =>
    !ingredientKeyword || foldSearchText(line.item.code).includes(ingredientKeyword) || foldSearchText(line.item.name).includes(ingredientKeyword);
  const filteredRecipeGroups = groupedRecipes.filter(({ recipe, ids }) => {
    if (recipeMonth && !ids.some((id) => validityInMonth(recipeValidityById.get(id), recipeMonth))) return false;
    if (ingredientKeyword && !recipe.lines.some(lineMatchesIngredient)) return false;
    if (!recipeKeyword) return true;
    return [
      recipe.productCode,
      recipe.productName,
      ...recipe.lines.flatMap((line) => [line.item.code, line.item.name]),
    ].some((value) => foldSearchText(value || "").includes(recipeKeyword));
  });
  const recipeFilterActive = Boolean(recipeKeyword || ingredientKeyword || recipeMonth);
  const dayLabel = (day: string | null | undefined) => (day ? `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}` : "");
  /**
   * Xuất Excel bảng phiên bản định lượng PHẲNG: mỗi nguyên liệu một dòng và thông tin món (mã, tên,
   * cửa hàng, phiên bản, ngày áp dụng, cost / giá bán) LẶP LẠI ở từng dòng để lọc / pivot trong Excel
   * (khách yêu cầu 03/10/2026 — xuất theo bảng gộp ô thì các dòng sau trống thông tin món).
   * Theo đúng bộ lọc đang xem, kể cả lọc nguyên liệu.
   */
  const exportRecipeVersionsFlat = async () => {
    const XLSX = await import("xlsx");
    const rows: Array<Array<string | number>> = [[
      "Mã món", "Tên món", "Cửa hàng", "Phiên bản", "Áp dụng từ", "Áp dụng đến", "Mẻ (ĐVT)", "1 mẻ = ĐVT tồn",
      "Mã nguyên liệu", "Tên nguyên liệu", "Định lượng", "ĐVT", "Hao hụt %", "Cost NL", "Cost / mẻ", "Giá bán", "Tỷ lệ cost %",
    ]];
    for (const { recipe, branchCodes, versions, ids } of filteredRecipeGroups) {
      const validity = groupValidity(ids);
      const head = [
        recipe.productCode,
        recipe.productName,
        branchCodes.length ? branchCodes.map((code) => storeLabel(code)).join(", ") : "Dùng chung",
        [...versions].sort((a, b) => a - b).map((version) => `V${version}`).join(" / "),
        dayLabel(validity?.from),
        validity?.to ? dayLabel(validity.to) : "",
        recipe.unit,
        recipe.outputConversionRate,
      ];
      const tail = [
        Math.round(recipe.estimatedCost),
        recipe.sellingPrice || 0,
        recipe.sellingPrice > 0 ? Math.round(recipe.estimatedCost / recipe.sellingPrice * 1000) / 10 : "",
      ];
      const lines = recipe.lines.filter(lineMatchesIngredient);
      if (lines.length === 0) rows.push([...head, "", "", "", "", "", "", ...tail]);
      for (const line of lines) {
        rows.push([
          ...head,
          line.item.code,
          line.item.name,
          line.quantity,
          line.unitCode || line.item.unit,
          line.wasteRate || 0,
          line.lineCost !== undefined ? Math.round(line.lineCost) : "",
          ...tail,
        ]);
      }
    }
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Phien ban dinh luong");
    XLSX.writeFile(workbook, `phien_ban_dinh_luong${recipeMonth ? `_${recipeMonth}` : ""}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  type CostSummaryGroup = { key: string; row: CostSummaryRow; branchCodes: string[]; versions: number[] };
  const costMonthLoaded = Boolean(costMonth) && monthlyCost?.month === costMonth;
  const costRows: CostSummaryRow[] = costMonth ? (costMonthLoaded ? monthlyCost!.rows : []) : data.costSummary;
  const groupedCostSummary: CostSummaryGroup[] = (() => {
    const groups = new Map<string, CostSummaryGroup>();
    for (const row of costRows) {
      const branchCode = (row.branchCode || "").toUpperCase();
      const period = row.appliedFrom ? `|${row.appliedFrom}|${row.appliedTo}` : "";
      // Giá thành bằng nhau ở nhiều cửa hàng = một dòng; lệch một đồng là tách ra để thấy ngay.
      const key = branchCode
        ? `BRANCH|${row.productCode}|${row.unitCost}|${row.sellingPrice}|${row.outputConversionRate}${period}`
        : `SHARED|${row.productCode}${period}`;
      const existing = groups.get(key);
      if (existing) {
        if (branchCode && !existing.branchCodes.includes(branchCode)) existing.branchCodes.push(branchCode);
        if (!existing.versions.includes(row.version)) existing.versions.push(row.version);
      } else {
        groups.set(key, { key, row, branchCodes: branchCode ? [branchCode] : [], versions: [row.version] });
      }
    }
    return [...groups.values()];
  })();

  /**
   * Lọc cửa hàng đúng như lúc hệ thống chọn định lượng: cửa hàng có bản riêng thì hiện bản riêng,
   * món chưa có bản riêng cho cửa hàng đó thì hiện bản dùng chung (cửa hàng đang dùng bản chung).
   */
  const costStoreKey = costStoreFilter.toUpperCase();
  const productsWithStoreVersion = new Set(groupedCostSummary
    .filter((group) => group.branchCodes.includes(costStoreKey))
    .map((group) => group.row.productCode.toUpperCase()));
  const filteredCostSummary = groupedCostSummary.filter((group) => {
    if (costGroupFilter !== "ALL" && group.row.group !== costGroupFilter) return false;
    if (costStoreFilter === "ALL") return true;
    if (group.branchCodes.includes(costStoreKey)) return true;
    return group.branchCodes.length === 0 && !productsWithStoreVersion.has(group.row.productCode.toUpperCase());
  });

  /** Ô "Cửa hàng" của hai bảng định lượng: không có cửa hàng nào = bản dùng chung. */
  const branchScopeCell = (branchCodes: string[]) => (
    branchCodes.length === 0
      ? <span className="status bg-slate-100 text-slate-600">Dùng chung</span>
      : <span className="flex flex-wrap gap-1">
          {branchCodes.map((code) => <span key={code} className="status bg-amber-50 text-amber-700">{storeLabel(code)}</span>)}
        </span>
  );
  // Rollback một lô import ngưng cả danh mục mặt hàng, và import lại KHÔNG bật lại được nếu file
  // thiếu cột Trạng thái — mã kẹt "Ngưng" thì mọi file BOM/nhập kho đều bị chặn. Cho bật lại
  // theo đúng bộ lọc đang xem thay vì bắt sửa tay từng mã.
  const inactiveItemCount = data.items.filter((item) => itemStatusOf(item) !== "ACTIVE").length;
  const inactiveFilteredItems = filteredItems.filter((item) => itemStatusOf(item) !== "ACTIVE");
  /**
   * File "Đơn vị quy đổi" theo bảng khách gửi 03/10/2026: mỗi ĐVT quy đổi một dòng — Mã hàng | Tên
   * hàng | Mã ĐVT quy đổi | ĐVT tồn kho | Hệ số quy đổi. Bỏ dòng ĐVT cơ bản (hệ số 1 với chính nó).
   * Theo đúng bộ lọc đang xem của danh mục.
   */
  const exportUnitConversions = async () => {
    const XLSX = await import("xlsx");
    const rows: Array<Array<string | number>> = [["Mã hàng", "Tên hàng", "Mã ĐVT quy đổi", "ĐVT tồn kho", "Hệ số quy đổi"]];
    const sorted = [...filteredItems].sort((a, b) => a.name.localeCompare(b.name, "vi") || a.code.localeCompare(b.code));
    for (const item of sorted) {
      const conversions = (item.unitConversions || [])
        .filter((unit) => unit.unitCode.trim().toUpperCase() !== item.unit.trim().toUpperCase())
        .sort((a, b) => a.unitCode.localeCompare(b.unitCode));
      for (const unit of conversions) rows.push([item.code, item.name, unit.unitCode, item.unit.toUpperCase(), unit.conversionRate]);
    }
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet["!cols"] = [{ wch: 16 }, { wch: 40 }, { wch: 22 }, { wch: 12 }, { wch: 14 }];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Don vi quy doi");
    XLSX.writeFile(workbook, `don_vi_quy_doi_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

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
    const seq = ++loadTracker.seq;
    const movementRange = movementRangeQuery(reportRange);
    // Lượt tải chính đã mang nhật ký của khoảng ngày này — effect nhật ký khỏi gọi trùng.
    loadTracker.movementRange = movementRange;
    const response = await fetch(`/api/inventory?flowFrom=${flowRange.from}&flowTo=${flowRange.to}&${movementRange}`, {
      headers: getSessionHeaders(),
    });
    // Đổi khoảng ngày liên tục thì lượt tải cũ về muộn không được đè lên số của lượt mới.
    if (!response.ok || seq !== loadTracker.seq) return;
    const payload = await response.json() as Data;
    if (seq !== loadTracker.seq) return;
    // CCDC / tài sản quản lý ở phân hệ Tài sản & khấu hao, không hiện ở Kho & định lượng (08/10/2026).
    payload.items = payload.items.filter((item) => isWarehouseStocktakeItemType(item.itemType));
    // Trong lúc chờ mà người dùng đã đổi khoảng ngày nhật ký thì giữ phần nhật ký mới hơn.
    setData((current) => loadTracker.movementRange === movementRange ? payload : { ...payload, stockMovements: current.stockMovements });
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
    setWasteForm((form) => ({ ...form, recipeId: form.recipeId || firstRecipe }));
    setConversionForm((form) => ({ ...form, itemId: form.itemId || firstItem }));
  };

  /**
   * Nhật ký nhập/xuất ở tab Tồn kho chỉ tải trong khoảng ngày đang lọc (trước đây GET trả nguyên
   * lịch sử mọi dòng phiếu kho từ ngày đầu). Đổi khoảng ngày thì chỉ gọi lại phần nhật ký, chờ
   * người dùng gõ xong ngày rồi mới gọi.
   */
  useEffect(() => {
    if (loading) return;
    const movementRange = movementRangeQuery(reportRange);
    const timer = window.setTimeout(async () => {
      if (movementRange === loadTracker.movementRange) return;
      const seq = ++loadTracker.movementSeq;
      const response = await fetch(`/api/inventory?view=movements&${movementRange}`, { headers: getSessionHeaders() });
      if (!response.ok || seq !== loadTracker.movementSeq) return;
      const payload = await response.json() as Pick<Data, "stockMovements"> & Partial<Pick<Data, "stockSummary">>;
      if (seq !== loadTracker.movementSeq) return;
      loadTracker.movementRange = movementRange;
      // Bảng Nhập - Xuất - Tồn đi theo cùng khoảng ngày nên nhận luôn số theo kỳ mới.
      setData((current) => ({ ...current, stockMovements: payload.stockMovements, ...(payload.stockSummary ? { stockSummary: payload.stockSummary } : {}) }));
    }, 400);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, reportRange.from, reportRange.to]);

  // Đổi khoảng ngày của danh sách phiếu nhập/xuất thì phải hỏi lại server: phiếu ngoài khoảng
  // không nằm sẵn trên trình duyệt.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (!loading) window.setTimeout(() => void loadData(), 0); }, [loading, flowRange.from, flowRange.to]);
  // Bảng giá NCC đang hiệu lực của NCC + cửa hàng trên form Nhập mua.
  const supplierPriceQuery = active === "inbound" && stockForm.transactionType === "NHAP_MUA" && stockForm.partnerCode ? `${stockForm.partnerCode}|${stockForm.branchCode}` : "";
  useEffect(() => {
    if (!supplierPriceQuery) return;
    const [supplierCode, branchCode] = supplierPriceQuery.split("|");
    let cancelled = false;
    void fetch(`/api/inventory?view=supplier-prices&supplierCode=${encodeURIComponent(supplierCode)}&branchCode=${encodeURIComponent(branchCode)}`, { headers: getSessionHeaders() })
      .then(async (response) => (response.ok ? response.json() : { prices: [] }))
      .then((payload) => { if (!cancelled) setSupplierPrices({ key: supplierPriceQuery, prices: payload.prices || [] }); });
    return () => { cancelled = true; };
  }, [supplierPriceQuery]);
  useEffect(() => {
    if (!/^\d{4}-\d{2}$/.test(costMonth)) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/inventory?view=cost-summary&month=${costMonth}`, { headers: getSessionHeaders() });
        const payload = await response.json() as { rows?: CostSummaryRow[]; error?: string };
        if (!cancelled) setMonthlyCost({ month: costMonth, rows: payload.rows || [], error: response.ok ? undefined : payload.error || "Không tải được giá thành theo tháng" });
      } catch {
        if (!cancelled) setMonthlyCost({ month: costMonth, rows: [], error: "Mất kết nối tới máy chủ khi tải giá thành theo tháng." });
      }
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [costMonth]);
  // Tải lại bảng "Mã hàng hủy nhiều nhất" khi đổi tháng hoặc sau mỗi lần tải dữ liệu (ghi / sửa / xoá phiếu hủy).
  useEffect(() => {
    if (active !== "waste") return;
    let cancelled = false;
    // Khoảng ngày (khách yêu cầu 03/10/2026) thay cho ô Tháng; nút "Tháng này / Tháng trước" vẫn có.
    const range = `${wasteReportFilter.from ? `&from=${wasteReportFilter.from}` : ""}${wasteReportFilter.to ? `&to=${wasteReportFilter.to}` : ""}`;
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/inventory?view=waste-report${range}`, { headers: getSessionHeaders() });
        const payload = await response.json() as { rows?: WasteReportLine[] };
        if (!cancelled) setWasteReportRows(response.ok ? payload.rows || [] : []);
      } catch {
        if (!cancelled) setWasteReportRows([]);
      }
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [active, wasteReportFilter.from, wasteReportFilter.to, data.wasteTransactions]);


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
    // Gửi đủ mọi dòng kèm lineId, kể cả dòng để 0 (xem chú thích cùng nội dung ở màn Mua hàng).
    const lines = grpoOrder.lines.map((line) => ({
      lineId: line.id,
      itemId: line.itemId,
      quantity: Number(grpoQuantities[line.id] ?? 0) || 0,
    }));
    if (lines.every((line) => line.quantity <= 0)) {
      setMessage("Chưa nhập số lượng cần nhận từ PO.");
      return;
    }
    const response = await fetch("/api/procurement", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...getSessionHeaders() },
      body: JSON.stringify({ action: "RECEIVE_ORDER", orderId: grpoOrder.id, lines, note: stockForm.note }),
    });
    const payload = await response.json();
    if (response.ok) {
      // Nói rõ hàng đã đi đâu: phiếu nhập kho cho hàng hoá, sổ tài sản cho dòng TOOL/ASSET.
      const parts: string[] = [];
      if (payload.receiptCode) parts.push(`phiếu ${payload.receiptCode} vào kho ${grpoOrder.warehouseCode}`);
      if (payload.assetsCreated > 0) parts.push(`${payload.assetsCreated} tài sản/CCDC đã vào sổ Tài sản & Khấu hao`);
      setMessage(`Đã nhận hàng từ ${grpoOrder.code}: ${parts.join(" · ") || "cập nhật thành công"}.`);
    } else {
      setMessage(payload.error || "Không nhận được hàng từ PO");
    }
    if (response.ok) {
      setGrpoOrderId("");
      setGrpoQuantities({});
      await loadData();
    }
  };

  const send = async (body: object, success: string) => {
    setMessage("");
    let response: Response;
    try {
      response = await fetch("/api/inventory", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getSessionHeaders(),
        },
        body: JSON.stringify(body),
      });
    } catch {
      setMessage("Không thực hiện được thao tác: mất kết nối tới máy chủ. Vui lòng thử lại.");
      return null;
    }
    let payload: any = null;
    try {
      payload = await response.json();
    } catch {
      // Server trả về nội dung không phải JSON (ví dụ trang lỗi do timeout) — vẫn phải báo cho người dùng.
      setMessage(
        response.ok
          ? "Đã gửi yêu cầu nhưng không đọc được phản hồi từ máy chủ. Vui lòng tải lại trang để kiểm tra kết quả."
          : `Không thực hiện được thao tác (máy chủ phản hồi lỗi${response.status ? ` ${response.status}` : ""}). Nếu thao tác xử lý nhiều dữ liệu, có thể đã bị quá thời gian chờ.`,
      );
      return null;
    }
    // Máy chủ cần người dùng xác nhận (vd rã lại ngày đã rã): trả nguyên phản hồi để nơi gọi hỏi.
    if (response.status === 409 && payload?.needsRerunConfirm) return payload;
    setMessage(response.ok ? success : payload.error || "Không thực hiện được thao tác");
    if (response.ok) await loadData();
    return response.ok ? payload : null;
  };

  /** Thao tác trên phiếu điều chuyển chờ duyệt: lỗi trả về cho hộp thoại tự hiện (lớp phủ che thông báo đầu trang). */
  const postTransferRequest = async (body: object, success: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const response = await fetch("/api/inventory", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getSessionHeaders() },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) return { ok: false, error: payload.error || `Máy chủ phản hồi lỗi ${response.status}` };
      setMessage(success);
      await loadData();
      return { ok: true };
    } catch {
      return { ok: false, error: "Mất kết nối tới máy chủ. Vui lòng thử lại." };
    }
  };

  /**
   * Nạp phiếu kiểm kê chưa duyệt / bị trả lại vào form để nhà hàng sửa, bổ sung rồi gửi lại. Dòng đã
   * đếm giữ số sổ sách chốt lúc đếm; mặt hàng chưa có trên phiếu lấy tồn hiện tại như phiếu mới.
   */
  const loadStocktakeIntoForm = (stocktake: Stocktake) => {
    const saved = new Map(stocktake.lines.map((line) => [line.item.id, line]));
    const fromLine = (line: Stocktake["lines"][number]) => ({
      systemQuantity: line.systemQuantity,
      actualQuantity: String(line.actualQuantity),
      unitCost: line.unitCost ? String(line.unitCost) : "",
      reason: line.reason || "",
    });
    const base = buildStocktakeRows(stocktake.warehouseCode, data.balances, data.items);
    const rows = base.map((row) => {
      const line = saved.get(row.itemId);
      return line ? { ...row, ...fromLine(line) } : row;
    });
    for (const line of stocktake.lines) {
      if (rows.some((row) => row.itemId === line.item.id)) continue;
      rows.push({ itemId: line.item.id, itemCode: line.item.code, itemName: line.item.name, unit: line.item.unit, averageCost: 0, ...fromLine(line) });
    }
    setStocktakeForm({ ...stocktakeForm, branchCode: stocktake.branchCode, warehouseCode: stocktake.warehouseCode, stocktakeDate: stocktake.stocktakeDate.slice(0, 10) });
    setStocktakeRows(rows);
    setStocktakeSearch("");
    setEditingStocktake({ id: stocktake.id, code: stocktake.code, returnedReason: stocktake.status === STOCKTAKE_RETURNED ? stocktake.returnedReason : null });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  /** Nút thao tác của một phiếu kiểm kê — dùng chung cho bảng (máy tính) và thẻ (điện thoại). */
  const renderStocktakeActions = (row: Stocktake) => (
    <>
      {canCreate && isStocktakeEditable(row.status) && (
        <button type="button" onClick={() => loadStocktakeIntoForm(row)} className="text-xs font-bold text-blue-700 hover:underline whitespace-nowrap">
          Sửa
        </button>
      )}
      {canApprove && row.status === STOCKTAKE_PENDING && (
        <>
          <button type="button" onClick={() => approveStocktake(row)} className="text-xs font-bold text-emerald-700 hover:underline whitespace-nowrap">Duyệt</button>
          <button type="button" onClick={() => returnStocktake(row)} className="text-xs font-bold text-rose-600 hover:underline whitespace-nowrap">Trả lại</button>
        </>
      )}
      {canApprove && row.status === STOCKTAKE_APPROVED && (
        <button
          type="button"
          onClick={() => {
            if (!window.confirm(`Mở lại phiếu kiểm kê ${row.code}? Phiếu nhập/xuất điều chỉnh của lần duyệt này sẽ được hoàn kho rồi xoá, phiếu quay về Chờ duyệt để nhà hàng sửa và kế toán duyệt lại.`)) return;
            void send({ action: "REOPEN_STOCKTAKE", stocktakeId: row.id }, `Đã mở lại phiếu kiểm kê ${row.code} và hoàn kho — phiếu về Chờ duyệt.`);
          }}
          className="text-xs font-bold text-slate-400 hover:text-rose-600 hover:underline whitespace-nowrap"
          title="Hoàn kho phần đã điều chỉnh và đưa phiếu về Chờ duyệt"
        >
          Mở lại
        </button>
      )}
    </>
  );

  const cancelStocktakeEdit = () => {
    setEditingStocktake(null);
    setStocktakeRows(buildStocktakeRows(stocktakeForm.warehouseCode, data.balances, data.items));
  };

  /** Kế toán chọn giờ chốt lúc duyệt / duyệt lại phiếu kiểm cả kho (khách yêu cầu 03/10/2026). */
  const approveStocktake = (stocktake: Stocktake) => {
    const local = new Date(new Date(stocktake.stocktakeDate).getTime() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    const max = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    setApprovingStocktake({ stocktake, cutoff: local, original: local, max });
  };
  const confirmApproveStocktake = async () => {
    if (!approvingStocktake) return;
    const { stocktake, cutoff, original } = approvingStocktake;
    setApprovingStocktake(null);
    await send(
      { action: "APPROVE_STOCKTAKE", stocktakeId: stocktake.id, ...(cutoff !== original ? { cutoffAt: new Date(cutoff).toISOString() } : {}) },
      `Đã duyệt phiếu kiểm kê ${stocktake.code} (chốt ${new Date(cutoff).toLocaleString("vi-VN")}) và điều chỉnh tồn kho.`,
    );
  };

  const returnStocktake = (stocktake: Stocktake) => {
    const reason = window.prompt(`Lý do trả lại phiếu ${stocktake.code} (nhà hàng sẽ thấy để sửa):`, "");
    if (reason === null) return;
    if (!reason.trim()) {
      setMessage("Cần nhập lý do trả lại để nhà hàng biết phải sửa gì.");
      return;
    }
    void send({ action: "RETURN_STOCKTAKE", stocktakeId: stocktake.id, reason: reason.trim() }, `Đã trả lại phiếu ${stocktake.code} cho nhà hàng.`);
  };

  /**
   * Đổ một định lượng có sẵn vào form bên trái.
   *   - "edit": sửa thẳng phiên bản đó (giữ mã món, cửa hàng, số phiên bản).
   *   - "copy": chép làm bản nháp cho PHIÊN BẢN MỚI — ngày áp dụng đặt về hôm nay để người dùng
   *     chọn lại; lưu ra V+1, bản cũ vẫn áp cho các ngày trước ngày áp dụng mới.
   */
  const loadRecipeIntoForm = (recipe: Recipe, branchCodes: string[], ids: string[], mode: "edit" | "copy") => {
    setRecipeForm((form) => ({
      ...form,
      productCode: recipe.productCode,
      productName: recipe.productName,
      sellingPrice: String(recipe.sellingPrice || 0),
      unit: recipe.unit,
      outputConversionRate: String(recipe.outputConversionRate || 1),
      effectiveFrom: mode === "edit" ? String(recipe.effectiveFrom).slice(0, 10) : today(),
    }));
    setRecipeBranchCodes(branchCodes);
    setRecipeRows(recipe.lines.length === 0
      ? [{ itemId: "", quantity: "1", unitCode: "", conversionRate: "", wasteRate: "0" }]
      : recipe.lines.map((line) => {
        const baseUnit = (line.item.unit || "").toUpperCase();
        const unitCode = line.unitCode && line.unitCode.toUpperCase() !== baseUnit ? line.unitCode : "";
        // Giữ hệ số đã lưu khi dòng dùng ĐVT quy đổi, hoặc khi dòng cũ để trống ĐVT mà vẫn có
        // phép nhân thật (2 chai830gr = 1660 gr) — bỏ đi là lưu lại sẽ đổi số rã.
        const keepRate = unitCode || (!line.unitCode && line.conversionRate > 0 && line.conversionRate !== 1);
        return {
          itemId: line.item.id,
          quantity: String(line.quantity),
          unitCode,
          conversionRate: keepRate ? String(line.conversionRate) : "",
          wasteRate: String(line.wasteRate),
        };
      }));
    setRecipeEditing(mode === "edit" ? { ids, label: `${recipe.productCode} V${recipe.version}` } : null);
    setMessage(mode === "copy"
      ? `Đã chép ${recipe.productCode} V${recipe.version} vào form. Chỉnh nguyên liệu, chọn Ngày áp dụng mới rồi bấm Lưu phiên bản: hệ thống tạo phiên bản mới, bản cũ vẫn áp cho các ngày trước đó.`
      : "");
    recipeFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const cancelRecipeEdit = () => {
    setRecipeEditing(null);
    setRecipeBranchCodes([]);
    setRecipeRows([{ itemId: "", quantity: "1", unitCode: "", conversionRate: "", wasteRate: "0" }]);
    setRecipeForm((form) => ({ ...form, productCode: "", productName: "", sellingPrice: "", unit: "", outputConversionRate: "1", effectiveFrom: today() }));
  };

  /**
   * Lưu form định lượng (tạo phiên bản mới hoặc sửa thẳng). Phiên bản đã được dùng để rã
   * nguyên liệu thì máy chủ trả 409 kèm danh sách lần rã: hỏi người dùng, đồng ý thì gửi lại
   * với confirmRerun — máy chủ gỡ phiếu của các lần rã đó và rã lại theo định lượng mới.
   */
  const saveRecipe = async (confirmRerun = false): Promise<void> => {
    setMessage("");
    const lines = recipeRows.filter((row) => row.itemId).map((row) => ({
      itemId: row.itemId,
      quantity: row.quantity,
      unitCode: row.unitCode || undefined,
      conversionRate: row.conversionRate || undefined,
      wasteRate: row.wasteRate,
    }));
    const editing = recipeEditing;
    const body = editing
      ? {
        action: "UPDATE_RECIPE",
        recipeIds: editing.ids,
        productName: recipeForm.productName,
        sellingPrice: recipeForm.sellingPrice,
        unit: recipeForm.unit,
        outputConversionRate: recipeForm.outputConversionRate,
        effectiveFrom: recipeForm.effectiveFrom,
        lines,
        confirmRerun,
      }
      : { action: "CREATE_RECIPE", ...recipeForm, branchCodes: recipeBranchCodes, lines, confirmRerun };
    let response: Response;
    let payload: {
      error?: string;
      needsRerunConfirm?: boolean;
      affectedRuns?: Array<{ runCode: string; branchCode: string; date: string }>;
      reruns?: Array<{ oldRunCode: string; newRunCode: string | null }>;
      cogsRepost?: CogsRepostResult[];
    } | null = null;
    try {
      response = await fetch("/api/inventory", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json", ...getSessionHeaders() },
        body: JSON.stringify(body),
      });
      payload = await response.json();
    } catch {
      setMessage("Không lưu được định lượng: mất kết nối hoặc máy chủ phản hồi lỗi (rã lại nhiều ngày có thể quá thời gian chờ). Tải lại trang để kiểm tra.");
      return;
    }
    if (response.status === 409 && payload?.needsRerunConfirm) {
      const runs = payload.affectedRuns || [];
      const list = runs.slice(0, 15)
        .map((run) => `• ${run.runCode} · ${storeLabel(run.branchCode)} · ngày ${new Date(run.date).toLocaleDateString("vi-VN")}`)
        .join("\n");
      const more = runs.length > 15 ? `\n… và ${runs.length - 15} lần rã khác` : "";
      const ok = window.confirm(
        `${payload.error}\n\n${list}${more}\n\n`
        + "OK: gỡ toàn bộ phiếu xuất/nhập chế biến và xuất bán của các lần rã trên, rồi rã lại theo định lượng mới (lần rã mới mang mã mới, phiếu cũ vào Thùng rác).\n"
        + "Huỷ: không lưu gì cả.",
      );
      if (ok) await saveRecipe(true);
      else setMessage("Chưa lưu định lượng — đã huỷ, các lần rã cũ giữ nguyên.");
      return;
    }
    if (!response.ok) {
      setMessage(payload?.error || "Không lưu được định lượng");
      return;
    }
    const reruns = payload?.reruns || [];
    const rerunText = reruns.length > 0
      ? ` Đã rã lại ${reruns.length} lần rã: ${reruns.map((rerun) => `${rerun.oldRunCode} → ${rerun.newRunCode || "gỡ bỏ (không còn doanh thu)"}`).join(", ")}. Nếu kỳ này đã bấm Tính giá vốn & giá thành thì bấm lại.`
      : "";
    const cogsText = cogsRepostMessage(payload?.cogsRepost);
    setMessage(`${editing ? `Đã sửa định lượng ${editing.label}.` : "Đã tạo phiên bản định lượng mới."}${rerunText}${cogsText ? ` ${cogsText}` : ""}`);
    if (editing) cancelRecipeEdit();
    await loadData();
  };

  /** Sửa nhanh một trường của mặt hàng ngay trên bảng danh mục (UPDATE_ITEM nằm ở PATCH). */
  const patchItem = async (itemId: string, changes: object, success: string) => {
    setMessage("");
    const response = await fetch("/api/inventory", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...getSessionHeaders() },
      body: JSON.stringify({ action: "UPDATE_ITEM", itemId, ...changes }),
    });
    const payload = await response.json();
    setMessage(response.ok ? success : payload.error || "Không cập nhật được mặt hàng");
    if (response.ok) await loadData();
  };

  /** Bật/ngưng hàng loạt đúng danh sách đang lọc — dùng để cứu danh mục bị ngưng cả loạt. */
  const bulkSetItemStatus = async (items: Item[], status: "ACTIVE" | "INACTIVE") => {
    if (items.length === 0) return;
    const verb = status === "ACTIVE" ? "Bật lại" : "Ngưng";
    if (!window.confirm(`${verb} ${items.length} mặt hàng đang hiển thị?`)) return;
    setMessage("");
    setBulkStatusRunning(true);
    try {
      const response = await fetch("/api/inventory", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...getSessionHeaders() },
        body: JSON.stringify({ action: "BULK_SET_ITEM_STATUS", status, itemIds: items.map((item) => item.id) }),
      });
      const payload = await response.json();
      setMessage(response.ok ? `Đã ${verb.toLowerCase()} ${payload.changed} mặt hàng.` : payload.error || "Không đổi được trạng thái mặt hàng");
      if (response.ok) await loadData();
    } finally {
      setBulkStatusRunning(false);
    }
  };

  const totalSKUs = data.items.length;
  // Tồn tối thiểu khai theo MẶT HÀNG — phải so với tổng tồn mọi kho, so từng kho là hàng nằm
  // 3 kho sẽ báo đỏ giả cả 3 dòng.
  const stockTotalsByItem = new Map<string, number>();
  for (const balance of data.balances) {
    stockTotalsByItem.set(balance.item.id, (stockTotalsByItem.get(balance.item.id) || 0) + balance.quantity);
  }
  const lowStockCount = data.items.filter((item) => (item.minStock || 0) > 0 && (stockTotalsByItem.get(item.id) || 0) < item.minStock).length;
  const totalStockValue = data.balances.reduce((sum, b) => sum + b.quantity * b.averageCost, 0);
  const totalTransactions = data.transactions.length;

  // Mặt hàng đang nằm trong định lượng nào thì API chặn xoá — đếm sẵn để khoá nút ngay trên
  // bảng, người dùng biết lý do trước khi bấm thay vì bấm xong mới ăn lỗi.
  const recipeUsageByItem = new Map<string, number>();
  for (const recipe of data.recipes) {
    for (const itemId of new Set(recipe.lines.map((line) => line.item.id))) {
      recipeUsageByItem.set(itemId, (recipeUsageByItem.get(itemId) || 0) + 1);
    }
  }
  /**
   * Lý do không xoá được mà màn hình tự biết (tồn kho, định lượng). Các điều kiện còn lại —
   * đã phát sinh phiếu nhập/xuất, đang nằm trong đề nghị/đơn mua hàng — chỉ server biết đủ,
   * hộp thoại xác nhận sẽ hiện nguyên văn lỗi trả về.
   */
  const itemDeleteLockReason = (item: Item) => {
    const onHand = stockTotalsByItem.get(item.id) || 0;
    if (Math.abs(onHand) > 0.000001) return `Còn tồn ${qty(onHand)} ${item.unit} nên không xoá được. Hãy xuất hết tồn trước.`;
    const recipeCount = recipeUsageByItem.get(item.id) || 0;
    if (recipeCount > 0) return `Đang dùng trong ${recipeCount} định lượng (BOM) nên không xoá được.`;
    return null;
  };

  const startEditItem = (item: Item) => {
    setItemEditError(null);
    setEditingItem(item);
    setItemEditForm({
      name: item.name,
      unit: item.unit,
      itemType: item.itemType,
      category: item.category || "",
      revenueGroup: item.revenueGroup || "",
      goodsGroup: item.goodsGroup || "",
      minStock: String(item.minStock ?? 0),
      requiresImage: !!item.requiresImage,
      status: (item.status || "ACTIVE").toUpperCase(),
      note: item.note || "",
    });
  };

  /**
   * Phiếu do hệ thống sinh ra từ chứng từ khác thì phải sửa ở gốc — sửa riêng phiếu kho sẽ
   * làm lệch kiểm kê / đơn mua hàng / lần rã nguyên liệu đã ghi.
   */
  /** Phiếu nhập thì đơn giá do người dùng khai; phiếu xuất / điều chuyển lấy giá vốn của kho. */
  const isInboundType = (transactionType: string) => transactionType.startsWith("NHAP_");
  const transactionLockReason = (transaction: Transaction) => {
    const derived: Record<string, string> = {
      STOCKTAKE: "phiếu kiểm kê",
      PURCHASE_ORDER: "đơn mua hàng",
      PRODUCTION: "lệnh chế biến / lần rã nguyên liệu",
    };
    const source = transaction.referenceType ? derived[transaction.referenceType] : undefined;
    if (source) return `Phiếu sinh tự động từ ${source} — xử lý ở chứng từ gốc`;
    return null;
  };
  /**
   * Điều chuyển liên nhà hàng sửa được: máy chủ tính lại giá và đồng bộ cặp công nợ nội bộ
   * theo số mới (chỉ chặn khi công nợ đã gạch nợ — báo lỗi ngay trong hộp thoại sửa).
   */
  const transactionEditLockReason = (transaction: Transaction) => transactionLockReason(transaction);

  const openTransactionEdit = (transaction: Transaction) => {
    setTransactionEditError(null);
    setEditingTransaction(transaction);
    setTransactionEditForm({
      transactionDate: String(transaction.transactionDate).slice(0, 10),
      warehouseCode: transaction.warehouseCode,
      toWarehouseCode: transaction.toWarehouseCode || "",
      partnerCode: transaction.partnerCode || "",
      subType: transaction.subType || "",
      referenceCode: transaction.referenceCode || "",
      note: transaction.note || "",
    });
    setTransactionEditLines(transaction.lines.map((line, index) => {
      /**
       * Phiếu lưu ĐVT nhập theo TÊN quy đổi ("chai 830gr") còn ô chọn ĐVT dùng MÃ ("CHAI830GR"):
       * không tra ngược thì ô chọn lệch giá trị và máy chủ báo "ĐVT không tồn tại" khi lưu.
       */
      const fullItem = data.items.find((candidate) => candidate.id === line.item.id);
      const rawUnit = (line.inputUnitCode || line.item.unit || "").trim();
      const matchedUnit = (fullItem?.unitConversions || []).find((unit) => (
        unit.unitCode.toUpperCase() === rawUnit.toUpperCase() || (unit.unitName || "").toUpperCase() === rawUnit.toUpperCase()
      ));
      const unitCode = matchedUnit ? matchedUnit.unitCode : rawUnit.toUpperCase() === (line.item.unit || "").toUpperCase() ? line.item.unit.toUpperCase() : rawUnit;
      return {
      key: `${line.id}-${index}`,
      itemId: line.item.id,
      // Hiện lại đúng con số người dùng đã gõ (ĐVT mua), không phải số đã quy đổi về ĐVT tồn.
      quantity: String(line.inputQuantity ?? line.quantity),
      unitCode,
      // Ô Đơn giá theo ĐVT ĐANG CHỌN: phiếu nhập thì số đã khai; thiếu số khai (và mọi phiếu
      // xuất / điều chuyển) thì quy giá vốn theo ĐVT tồn (đ/gr) ra ĐVT nhập (đ/chai). Trước đây
      // hiện thẳng đ/gr cạnh chữ "chai" nên nhìn như giá sai — xem repostInventoryTransaction.
      unitCost: String(isInboundType(transaction.transactionType) && line.inputUnitCost !== null
        ? line.inputUnitCost
        : roundUnitCost(line.unitCost * (line.conversionRate || 1))),
      baseUnitCost: line.unitCost,
      // Mã thuế suất ("8%" / "KKKNT") để ô chọn hiện đúng cái đã lưu; ô trống = chưa khai thuế.
      vatRate: vatRateLabel(line.vatRate),
      /**
       * Ô "Tiền thuế" chỉ điền sẵn khi số đã lưu KHÁC số tự tính, tức là người dùng từng khai
       * theo hoá đơn. Điền sẵn cả khi trùng thì sửa số lượng/đơn giá xong tiền thuế vẫn kẹt ở
       * số cũ, mà người dùng không hề biết mình đang khai đè.
       */
      vatAmount: line.vatAmount && line.vatAmount !== vatAmountOf(roundVnd((line.inputQuantity ?? line.quantity) * (line.inputUnitCost ?? line.unitCost * (line.conversionRate || 1))), line.vatRate)
        ? String(line.vatAmount)
        : "",
      };
    }));
  };

  /**
   * Tiền thuế hệ thống TỰ TÍNH cho một dòng đang sửa — dùng làm gợi ý trong ô "Tiền thuế".
   * Tính đúng như máy chủ: số lượng x đơn giá KHAI TRÊN PHIẾU, tròn tới đồng, rồi nhân thuế suất.
   */
  const editLineAutoVat = (line: { quantity: string; unitCost: string; vatRate: string }) => {
    const rate = parseVatRate(line.vatRate);
    return vatAmountOf(roundVnd(Number(line.quantity || 0) * Number(line.unitCost || 0)), rate.ok ? rate.rate : null);
  };

  const submitTransactionEdit = async () => {
    if (!editingTransaction) return;
    setTransactionEditSaving(true);
    setTransactionEditError(null);
    try {
      const response = await fetch("/api/inventory", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...getSessionHeaders() },
        body: JSON.stringify({
          action: "UPDATE_TRANSACTION",
          transactionId: editingTransaction.id,
          transactionDate: transactionEditForm.transactionDate,
          warehouseCode: transactionEditForm.warehouseCode,
          ...(editingTransaction.transactionType === "DIEU_CHUYEN" ? { toWarehouseCode: transactionEditForm.toWarehouseCode } : {}),
          ...(editingTransaction.transactionType === "XUAT_HUY" ? { subType: transactionEditForm.subType } : {}),
          partnerCode: transactionEditForm.partnerCode,
          referenceCode: transactionEditForm.referenceCode,
          note: transactionEditForm.note,
          lines: transactionEditLines.map((line) => ({
            itemId: line.itemId,
            inputQuantity: line.quantity,
            inputUnitCode: line.unitCode,
            // Phiếu xuất / điều chuyển không gửi đơn giá: máy chủ tự định giá theo kho.
            inputUnitCost: isInboundType(editingTransaction.transactionType) ? line.unitCost : "",
            vatRate: line.vatRate,
            vatAmount: line.vatAmount,
          })),
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setTransactionEditError(payload.error || "Không sửa được phiếu kho");
        return;
      }
      setMessage(`Đã sửa phiếu ${editingTransaction.code} và cập nhật lại tồn kho.`);
      setEditingTransaction(null);
      await loadData();
    } finally {
      setTransactionEditSaving(false);
    }
  };

  const confirmDeleteTransaction = async (reason: string) => {
    if (!deletingTransaction) return;
    setTransactionDeleting(true);
    setTransactionDeleteError(null);
    try {
      const query = new URLSearchParams({ id: deletingTransaction.id, type: "TRANSACTION" });
      if (reason) query.set("reason", reason);
      const response = await fetch(`/api/inventory?${query.toString()}`, { method: "DELETE", headers: getSessionHeaders() });
      const payload = await response.json();
      if (!response.ok) {
        setTransactionDeleteError(payload.error || "Không xoá được phiếu kho");
        return;
      }
      setMessage(`Đã xoá phiếu ${deletingTransaction.code} và hoàn lại tồn kho.`);
      setDeletingTransaction(null);
      await loadData();
    } finally {
      setTransactionDeleting(false);
    }
  };

  const submitItemEdit = async () => {
    if (!editingItem) return;
    setItemEditSaving(true);
    setItemEditError(null);
    try {
      const response = await fetch("/api/inventory", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...getSessionHeaders() },
        body: JSON.stringify({
          action: "UPDATE_ITEM",
          itemId: editingItem.id,
          ...itemEditForm,
          minStock: Number(itemEditForm.minStock) || 0,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setItemEditError(payload.error || "Không cập nhật được mặt hàng");
        return;
      }
      setMessage(`Đã cập nhật mặt hàng ${editingItem.code}.`);
      setEditingItem(null);
      await loadData();
    } finally {
      setItemEditSaving(false);
    }
  };

  const confirmDeleteItem = async (reason: string) => {
    if (!deletingItem) return;
    setItemDeleting(true);
    setItemDeleteError(null);
    try {
      const query = new URLSearchParams({ id: deletingItem.id, type: "ITEM" });
      if (reason) query.set("reason", reason);
      const response = await fetch(`/api/inventory?${query.toString()}`, {
        method: "DELETE",
        headers: getSessionHeaders(),
      });
      const payload = await response.json();
      if (!response.ok) {
        setItemDeleteError(payload.error || "Không xoá được mặt hàng");
        return;
      }
      // Xoá mềm vẫn giữ chỗ mã hàng (unique code): phải nói trước, nếu không người dùng tạo lại
      // đúng mã đó sẽ ăn lỗi "đang nằm trong Thùng rác" mà không hiểu vì sao.
      setMessage(`Đã chuyển mặt hàng ${deletingItem.code} vào Thùng rác. Mã ${deletingItem.code} chưa dùng lại được chừng nào bản ghi còn trong Thùng rác.`);
      setDeletingItem(null);
      await loadData();
    } finally {
      setItemDeleting(false);
    }
  };

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
          <p className={`font-bold text-emerald-600 mt-1 leading-tight tabular-nums whitespace-nowrap ${statValueTextClass(`${money(totalStockValue)} đ`)}`}>{money(totalStockValue)} đ</p>
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
      {message && <p ref={messageRef} className="mb-4 px-4 py-3 rounded-lg border border-blue-100 bg-blue-50 text-sm text-blue-700">{message}</p>}

      {canCreate && !["stocktake-explanation", "stocktake-result"].includes(active) && (
        <div className={`mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 ${canOpenImports ? "border-blue-100 bg-blue-50" : "border-amber-200 bg-amber-50"}`}>
          <p className={`text-sm ${canOpenImports ? "text-blue-800" : "text-amber-800"}`}>
            Có thể nhập đầy đủ dữ liệu của màn hình này bằng file Excel theo mẫu chuẩn.
            {active === "stocktake" && " Kiểm kê Kho không bao gồm CCDC và Tài sản."}
            {!canOpenImports && " Tài khoản của bạn chưa được cấp menu Import dữ liệu nên chưa mở được màn hình đẩy file — liên hệ Admin để cấp quyền hoặc nhờ import giúp."}
          </p>
          {canOpenImports && (
            <div className="flex flex-wrap gap-2">
              {/* Danh mục đã có, chỉ thiếu vài cột (Nhóm hàng hóa, Nhóm doanh thu) thì import bổ sung (03/10/2026). */}
              {active === "items" && (
                <a className="secondary-button bg-white" href="/imports?tab=inventory-item-update">
                  <span className="material-symbols-outlined text-lg">edit_note</span>Cập nhật bổ sung mặt hàng
                </a>
              )}
              <a className="secondary-button bg-white" href={`/imports?tab=${importTarget.tab}`}>
                <span className="material-symbols-outlined text-lg">upload_file</span>{importTarget.label}
              </a>
            </div>
          )}
        </div>
      )}

      {active === "stock" && (
        <StockReportsPanel
          summary={data.stockSummary}
          movements={data.stockMovements}
          warehouses={warehouseOptions}
          branchOf={(code) => branchByWarehouse.get(code) || ""}
          storeOptions={visibleStoreOptions(user)}
          storeLabel={storeLabel}
          store={reportStore}
          setStore={setReportStore}
          warehouse={reportWarehouse}
          setWarehouse={setReportWarehouse}
          goodsGroup={reportGoodsGroup}
          setGoodsGroup={setReportGoodsGroup}
          search={stockSearch}
          setSearch={setStockSearch}
          range={reportRange}
          setRange={setReportRange}
          reload={() => void loadData()}
        />
      )}

      {active === "stock" && (
        <section className="table-panel shadow-sm">
          <Panel title="Tồn kho hiện tại theo kho (real time)" reload={loadData} exportFileName="ton_kho_hien_tai_theo_kho" />
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
            {data.balances.filter((row) => inReportStore(row.warehouseCode) && matchesStockGroup(row.item.goodsGroup) && matchesStockSearch(row.item.code, row.item.name) && (reportWarehouse === "ALL" || row.warehouseCode === reportWarehouse)).map((row) => (
              <tr key={row.id} className="border-t border-slate-100">
                <Cell>
                  <b><CopyableText value={row.item.code} /> - {row.item.name}</b>
                  <small>{row.item.itemType} · {row.item.unit}</small>
                </Cell>
                <Cell>{row.warehouseCode}</Cell>
                <Cell right><b>{qty(row.quantity)}</b> {row.item.unit}</Cell>
                <Cell right>{unitPrice(row.averageCost)} đ</Cell>
                <Cell right><b>{money(row.quantity * row.averageCost)} đ</b></Cell>
                <Cell>{(row.item.minStock || 0) > 0 && (stockTotalsByItem.get(row.item.id) || 0) < row.item.minStock ? <span className="status bg-rose-50 text-rose-700">Dưới định mức (tổng mọi kho)</span> : <span className="status bg-emerald-50 text-emerald-700">Đủ tồn</span>}</Cell>
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
                  {WAREHOUSE_ITEM_TYPES.map((type) => <option key={type} value={type}>{inventoryItemTypeLabel(type)}</option>)}
                </select>
              </Input>

              <Input label="Nhóm hàng hóa (lọc khi giải trình kiểm kê)">
                <input className="control" list="goods-group-options" value={itemForm.goodsGroup} onChange={(e) => setItemForm({ ...itemForm, goodsGroup: e.target.value })} placeholder="vd: Thịt, Hải sản, Rau củ, Bia..." />
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

              <Input label="Nhóm doanh thu (dùng khi file POS không khai được)">
                <select className="control" value={itemForm.revenueGroup} onChange={(e) => setItemForm({ ...itemForm, revenueGroup: e.target.value })}>
                  <option value="">-- Chưa gán nhóm doanh thu --</option>
                  {itemRevenueOptions.map((group) => (
                    <option key={group.code} value={group.code}>{group.code} - {group.name}</option>
                  ))}
                </select>
                {itemRevenueOptions.length === 0 && (
                  <p className="mt-1 text-[11px] font-bold text-amber-700">
                    Chưa khai nhóm doanh thu nào. Vào Cài đặt &gt; Thu / Chi, thêm danh mục với nhóm “Thu: Nhóm doanh thu (bán hàng)” — loại thu quỹ (thu tiền thừa, thu đặt cọc...) không gán cho mặt hàng được.
                  </p>
                )}
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
            <form onSubmit={(e) => { e.preventDefault(); void send({ action: "UPSERT_UNIT_CONVERSION", ...conversionForm }, conversionSavedMessage()); }} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 h-fit shadow-sm">
              <h2 className="font-bold text-slate-800">Cập nhật ĐVT quy đổi</h2>
              {/* Khung này sửa LẺ từng mã. Người cần khai vài trăm mã đứng đúng ở đây và không
                  có gì chỉ sang đường đi file Excel, nên kết luận hệ thống không cho đẩy file
                  (phản hồi 19/09/2026). Nói thẳng đường đi ngay tại chỗ. */}
              {canOpenImports ? (
                <p className="text-[11px] leading-5 text-slate-500">
                  Khung này khai lẻ từng mã. Nhiều mã một lúc thì{" "}
                  <a className="font-bold text-blue-700 hover:underline" href="/imports?tab=inventory-item">
                    khai hàng loạt bằng file Excel
                  </a>
                  {" "}— tải file mẫu, điền cột ĐVT mua và Tỷ lệ quy đổi, mã đã có thì cập nhật chứ không tạo trùng.
                </p>
              ) : (
                <p className="text-[11px] leading-5 text-slate-500">
                  Khung này khai lẻ từng mã. Khai hàng loạt bằng file Excel thì cần menu Import dữ liệu — tài khoản của bạn chưa được cấp, liên hệ Admin.
                </p>
              )}
              <Input label="Mặt hàng">
                <ItemSelect items={data.items} value={conversionForm.itemId} onChange={(itemId) => setConversionForm({ ...conversionForm, itemId })} />
              </Input>
              {/* Không có ô này thì bấm Lưu xong màn hình y hệt lúc trước: bảng danh mục nằm xa
                  bên dưới, người khai không biết vừa ghi được gì. */}
              {conversionItem && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] leading-5 text-slate-600">
                  <div>ĐVT tồn kho: <b className="text-slate-800">{conversionItem.unit}</b></div>
                  <div>
                    ĐVT mua đang có:{" "}
                    {purchaseConversionLabel(conversionItem)
                      ? <b className="text-slate-800">{purchaseConversionLabel(conversionItem)}</b>
                      : <span className="text-amber-700 font-bold">chưa khai</span>}
                  </div>
                </div>
              )}
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
            <Panel title="Danh mục mặt hàng" reload={loadData} exportFileName="danh_muc_mat_hang" />
            {/* Gợi ý nhóm hàng hóa đã dùng cho ô nhập ở form thêm / sửa mặt hàng. */}
            <datalist id="goods-group-options">
              {goodsGroupOptions.map((group) => <option key={group.key} value={group.name} />)}
            </datalist>
            <div className="px-5 pb-4 grid sm:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_180px_200px_200px_170px] gap-3">
              <Input label="Tìm kiếm">
                <input className="control" placeholder="Gõ mã hoặc tên mặt hàng..." value={itemSearch} onChange={(e) => setItemSearch(e.target.value)} />
              </Input>
              <Input label="Loại">
                <select className="control" value={itemTypeFilter} onChange={(e) => setItemTypeFilter(e.target.value)}>
                  <option value="ALL">Tất cả loại</option>
                  {WAREHOUSE_ITEM_TYPES.map((type) => <option key={type} value={type}>{inventoryItemTypeLabel(type)}</option>)}
                </select>
              </Input>
              <Input label="Nhóm hàng hóa">
                <select className="control" value={goodsGroupFilter} onChange={(e) => setGoodsGroupFilter(e.target.value)}>
                  <option value="ALL">Tất cả nhóm hàng hóa</option>
                  <option value="MISSING">Chưa có nhóm hàng hóa</option>
                  {goodsGroupOptions.map((group) => (
                    <option key={group.key} value={group.key}>{group.name} ({group.count})</option>
                  ))}
                </select>
              </Input>
              <Input label="Nhóm doanh thu">
                <select className="control" value={revenueGroupFilter} onChange={(e) => setRevenueGroupFilter(e.target.value)}>
                  <option value="ALL">Tất cả nhóm doanh thu</option>
                  <option value="MISSING">Chưa gán nhóm doanh thu</option>
                  <option value="INVALID">Đang gán sai (không phải nhóm món / ngoài danh mục)</option>
                  {itemRevenueOptions.map((group) => (
                    <option key={group.code} value={group.code}>{group.code} - {group.name}</option>
                  ))}
                </select>
              </Input>
              <Input label="Trạng thái">
                <select className="control" value={itemStatusFilter} onChange={(e) => setItemStatusFilter(e.target.value)}>
                  <option value="ALL">Tất cả trạng thái</option>
                  <option value="ACTIVE">Đang dùng</option>
                  <option value="INACTIVE">Đang ngưng</option>
                </select>
              </Input>
            </div>
            <p className="px-5 pb-2 text-[11px] text-slate-500">
              {filteredItems.length}/{data.items.length} mặt hàng
              {missingRevenueGroupCount > 0 && (
                <> · <span className="text-amber-700 font-bold">{missingRevenueGroupCount} món chưa gán Nhóm doanh thu</span> — file POS để trống hoặc ghi chữ lạ ở cột này thì hệ thống lấy theo đây.</>
              )}
              {misassignedRevenueGroupCount > 0 && (
                <> · <span className="text-rose-700 font-bold">{misassignedRevenueGroupCount} món đang gán loại thu thay vì nhóm doanh thu</span> — lọc “Đang gán sai” để sửa; nhóm doanh thu khai ở Cài đặt &gt; Thu / Chi với nhóm “Thu: Nhóm doanh thu (bán hàng)”.</>
              )}
              {inactiveItemCount > 0 && (
                <> · <span className="text-rose-700 font-bold">{inactiveItemCount} mã đang Ngưng</span> — mã Ngưng bị chặn ở mọi file import BOM / nhập xuất kho.</>
              )}
            </p>
            <div className="px-5 pb-3">
              <button type="button" className="secondary-button" onClick={() => void exportUnitConversions()} title="Mỗi ĐVT quy đổi một dòng, theo bộ lọc đang xem">
                <span className="material-symbols-outlined text-lg">swap_horiz</span>
                Xuất ĐVT quy đổi ({filteredItems.length} mã)
              </button>
            </div>
            {canEditItem && inactiveFilteredItems.length > 0 && (
              <div className="px-5 pb-3">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={bulkStatusRunning}
                  onClick={() => void bulkSetItemStatus(inactiveFilteredItems, "ACTIVE")}
                >
                  <span className="material-symbols-outlined text-lg">restart_alt</span>
                  Bật lại {inactiveFilteredItems.length} mã đang Ngưng (theo bộ lọc đang xem)
                </button>
              </div>
            )}
            <Table
              tableClassName="min-w-[1480px]"
              headers={[
                { label: "Mã" },
                { label: "Tên" },
                { label: "Loại" },
                { label: "Nhóm hàng hóa" },
                { label: "Phân nhóm" },
                { label: "Nhóm doanh thu" },
                { label: "Đơn vị" },
                { label: "Quy đổi mua" },
                { label: "Tồn tối thiểu", align: "right" },
                { label: "Yêu cầu ảnh" },
                { label: "Thao tác", align: "right" },
              ]}
            >
              {filteredItems.map((item) => (
                <tr key={item.id} className="border-t border-slate-100">
                  <Cell>
                    <CopyableText value={item.code}><b>{item.code}</b></CopyableText>
                    {(item.status || "ACTIVE").toUpperCase() !== "ACTIVE" && (
                      <span className="ml-2 status bg-slate-100 text-slate-600 font-bold px-2 py-0.5 rounded text-[11px]">Ngưng</span>
                    )}
                  </Cell>
                  <Cell>{item.name}</Cell>
                  <Cell>{inventoryItemTypeLabel(item.itemType)}</Cell>
                  <Cell>{normalizeGoodsGroup(item.goodsGroup) || <span className="text-slate-400">-</span>}</Cell>
                  <Cell>{data.itemGroups.find((group) => group.code === item.category)?.name || item.category || "-"}</Cell>
                  <Cell>
                    {canEditItem ? (
                      <select
                        className={`control !py-1 !text-[12px] min-w-[170px] ${isMisassignedRevenueGroup(item.revenueGroup) ? "!border-rose-400 !text-rose-700 !bg-rose-50 font-bold" : ""}`}
                        value={item.revenueGroup || ""}
                        onChange={(e) => void patchItem(item.id, { revenueGroup: e.target.value }, `Đã gán nhóm doanh thu cho ${item.code}.`)}
                      >
                        <option value="">-- Chưa gán --</option>
                        {itemRevenueOptions.map((group) => (
                          <option key={group.code} value={group.code}>{group.code} - {group.name}</option>
                        ))}
                        {/* Mã đang gán sai (loại thu quỹ, mã đã bỏ) vẫn phải hiện, nếu không đổi ô là
                            mất dữ liệu — nhưng gọi rõ nó sai ở đâu để người dùng chọn lại. */}
                        {isMisassignedRevenueGroup(item.revenueGroup) && item.revenueGroup && (
                          <option value={item.revenueGroup}>{revenueGroupIssueLabel(item.revenueGroup)}</option>
                        )}
                      </select>
                    ) : isMisassignedRevenueGroup(item.revenueGroup) && item.revenueGroup ? (
                      <span className="text-rose-700 font-bold">{revenueGroupIssueLabel(item.revenueGroup)}</span>
                    ) : (
                      (itemRevenueOptions.find((group) => group.code === item.revenueGroup) || data.revenueGroups.find((group) => group.code === item.revenueGroup))?.name || "-"
                    )}
                  </Cell>
                  <Cell>{item.unit}</Cell>
                  {/* Lọc theo conversionRate > 1 là ĐVT mua khai tỷ lệ 1 (mua và tồn cùng đơn vị,
                      hoặc đơn vị khác nhưng bằng nhau) lưu xong vẫn hiện "-", người khai tưởng
                      bấm Lưu không ăn. Lọc đúng phải là "khác ĐVT tồn kho". */}
                  <Cell>{purchaseConversionLabel(item) || "-"}</Cell>
                  <Cell right>{qty(item.minStock)}</Cell>
                  <Cell>
                    {item.requiresImage ? (
                      <span className="status bg-indigo-50 text-indigo-700 font-bold px-2 py-0.5 rounded text-[11px]">Bắt buộc</span>
                    ) : (
                      <span className="text-slate-400">-</span>
                    )}
                  </Cell>
                  <Cell right>
                    <RowActions
                      session={user}
                      module={href}
                      compact
                      onEdit={() => startEditItem(item)}
                      onDelete={() => {
                        setItemDeleteError(null);
                        setDeletingItem(item);
                      }}
                      deleteDisabledReason={itemDeleteLockReason(item)}
                    />
                  </Cell>
                </tr>
              ))}
            </Table>
          </section>

          {editingItem && (
            <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
              <form
                onSubmit={(e) => { e.preventDefault(); void submitItemEdit(); }}
                className="bg-white rounded-xl w-full max-w-lg shadow-xl max-h-[92vh] overflow-y-auto"
              >
                <div className="p-5 border-b border-slate-200">
                  <h3 className="font-bold text-slate-900">Sửa mặt hàng {editingItem.code}</h3>
                  <p className="text-xs text-slate-500 mt-1">
                    Mã hàng cố định sau khi tạo, không sửa được. Cần đổi mã thì tạo mặt hàng mới rồi ngưng (hoặc xoá) mã cũ.
                  </p>
                </div>

                <div className="p-5 space-y-4">
                  <Input label="Mã (không sửa được)">
                    <input className="control bg-slate-100 text-slate-500" value={editingItem.code} readOnly disabled />
                  </Input>

                  <Input label="Tên">
                    <input className="control" value={itemEditForm.name} onChange={(e) => setItemEditForm({ ...itemEditForm, name: e.target.value })} required />
                  </Input>

                  <div className="grid grid-cols-2 gap-3">
                    <Input label="Đơn vị">
                      <input className="control" value={itemEditForm.unit} onChange={(e) => setItemEditForm({ ...itemEditForm, unit: e.target.value })} required />
                    </Input>
                    <Input label="Tồn tối thiểu">
                      <input type="number" className="control" value={itemEditForm.minStock} onChange={(e) => setItemEditForm({ ...itemEditForm, minStock: e.target.value })} />
                    </Input>
                  </div>

                  <Input label="Loại">
                    <select className="control" value={itemEditForm.itemType} onChange={(e) => setItemEditForm({ ...itemEditForm, itemType: e.target.value, category: "" })}>
                      {WAREHOUSE_ITEM_TYPES.map((type) => <option key={type} value={type}>{inventoryItemTypeLabel(type)}</option>)}
                    </select>
                  </Input>

                  <p className="text-[11px] bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-3 py-2 flex items-start gap-2">
                    <span className="material-symbols-outlined text-base shrink-0">info</span>
                    Đơn vị tính và Loại chỉ đổi được khi mặt hàng chưa phát sinh giao dịch kho và không còn tồn. Đã phát sinh rồi thì khai ĐVT quy đổi thay vì sửa ĐVT gốc.
                  </p>

                  <Input label="Nhóm hàng hóa (lọc khi giải trình kiểm kê)">
                    <input className="control" list="goods-group-options" value={itemEditForm.goodsGroup} onChange={(e) => setItemEditForm({ ...itemEditForm, goodsGroup: e.target.value })} placeholder="vd: Thịt, Hải sản, Rau củ, Bia..." />
                  </Input>

                  <Input label="Phân nhóm (đi theo kho tương ứng)">
                    <select className="control" value={itemEditForm.category} onChange={(e) => setItemEditForm({ ...itemEditForm, category: e.target.value })}>
                      <option value="">-- Chưa gán phân nhóm --</option>
                      {data.itemGroups
                        .filter((group) => !group.group || group.group === "OTHER" || group.group === itemEditForm.itemType)
                        .map((group) => (
                          <option key={group.code} value={group.code}>
                            {group.name}{group.subGroup ? ` (kho ${group.subGroup})` : ""}
                          </option>
                        ))}
                    </select>
                  </Input>

                  <Input label="Nhóm doanh thu (dùng khi file POS không khai được)">
                    <select className="control" value={itemEditForm.revenueGroup} onChange={(e) => setItemEditForm({ ...itemEditForm, revenueGroup: e.target.value })}>
                      <option value="">-- Chưa gán nhóm doanh thu --</option>
                      {itemRevenueOptions.map((group) => (
                        <option key={group.code} value={group.code}>{group.code} - {group.name}</option>
                      ))}
                      {/* Mã đang gán sai vẫn phải nằm trong danh sách, nếu không mở hộp thoại sửa
                          tên là ô này tự nhảy về rỗng, bấm Lưu một phát mất luôn dữ liệu cũ. */}
                      {isMisassignedRevenueGroup(itemEditForm.revenueGroup) && itemEditForm.revenueGroup && (
                        <option value={itemEditForm.revenueGroup}>{revenueGroupIssueLabel(itemEditForm.revenueGroup)}</option>
                      )}
                    </select>
                  </Input>

                  <Input label="Trạng thái">
                    <select className="control" value={itemEditForm.status} onChange={(e) => setItemEditForm({ ...itemEditForm, status: e.target.value })}>
                      <option value="ACTIVE">Đang hoạt động</option>
                      <option value="INACTIVE">Ngưng hoạt động</option>
                    </select>
                  </Input>

                  <Input label="Ghi chú">
                    <textarea className="control" rows={2} value={itemEditForm.note} onChange={(e) => setItemEditForm({ ...itemEditForm, note: e.target.value })} />
                  </Input>

                  <label className="flex items-center gap-2 text-xs font-bold text-slate-600 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={itemEditForm.requiresImage}
                      onChange={(e) => setItemEditForm({ ...itemEditForm, requiresImage: e.target.checked })}
                      className="rounded text-blue-600 focus:ring-blue-500"
                    />
                    Yêu cầu ảnh khi mua / nhận hàng
                  </label>

                  {itemEditError && (
                    <p className="text-sm bg-rose-50 border border-rose-200 text-rose-700 rounded-lg px-3 py-2.5 flex items-start gap-2">
                      <span className="material-symbols-outlined text-lg shrink-0">error</span>
                      {itemEditError}
                    </p>
                  )}
                </div>

                <div className="p-5 border-t border-slate-200 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => { setEditingItem(null); setItemEditError(null); }}
                    className="px-4 py-2 rounded-lg text-sm font-bold text-slate-600 hover:bg-slate-100"
                  >
                    Huỷ
                  </button>
                  <button type="submit" disabled={itemEditSaving} className="primary-button">
                    {itemEditSaving ? "Đang lưu..." : "Lưu thay đổi"}
                  </button>
                </div>
              </form>
            </div>
          )}

          <ConfirmDeleteDialog
            open={Boolean(deletingItem)}
            title={`Xoá mặt hàng ${deletingItem?.code || ""}?`}
            description={deletingItem ? `${deletingItem.name} · ĐVT ${deletingItem.unit}. Mã này chưa tạo lại được chừng nào bản ghi còn nằm trong Thùng rác.` : undefined}
            submitting={itemDeleting}
            error={itemDeleteError}
            onCancel={() => { setDeletingItem(null); setItemDeleteError(null); }}
            onConfirm={confirmDeleteItem}
          />
        </div>
      )}

      {(active === "inbound" || active === "outbound") && (
        <div className="grid lg:grid-cols-[380px_1fr] gap-5">
          {canCreate && (
            <form onSubmit={(e) => { e.preventDefault(); if (grpoOrder) { void receiveFromPO(); return; } void send({ action: "STOCK_TRANSACTION", ...stockForm, lines: [{ itemId: stockForm.itemId, inputQuantity: stockForm.quantity, inputUnitCode: stockForm.inputUnitCode || selectedStockUnit?.unitCode, inputUnitCost: active === "inbound" ? stockForm.unitCost : "0", vatRate: active === "inbound" ? stockForm.vatRate : "", vatAmount: active === "inbound" ? stockForm.vatAmount : "" }] }, active === "inbound" ? "Đã ghi nhận phiếu nhập kho." : "Đã ghi nhận phiếu xuất kho."); }} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 h-fit shadow-sm">
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
                            <small className="text-slate-500">Còn phải nhận: {qty(remaining)} {line.item.unit} · {unitPrice(line.unitCost)} đ/{line.item.unit}</small>
                          </div>
                          <input
                            type="number"
                            min="0"
                            max={remaining}
                            step="any"
                            inputMode="decimal"
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

              <Input label="Ngày chứng từ">
                <input type="date" className="control" value={stockForm.transactionDate} onChange={(e) => setStockForm({ ...stockForm, transactionDate: e.target.value })} required />
              </Input>

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

              {/* Đồng phục xuất dùng: phân bổ chi phí N tháng (treo 242, lịch PB-<mã phiếu> ở Vận hành
                  tài chính → Phân bổ). Để trống = ghi chi phí ngay trong tháng xuất. */}
              {active === "outbound" && stockForm.transactionType === "XUAT_KHAC" && selectedStockItem?.itemType === "UNIFORM" && (
                <Input label="Phân bổ chi phí (số tháng)">
                  <input
                    type="number"
                    min="0"
                    step="any"
                    inputMode="decimal"
                    className="control"
                    placeholder="Để trống = ghi chi phí ngay"
                    value={stockForm.allocationMonths}
                    onChange={(e) => setStockForm({ ...stockForm, allocationMonths: e.target.value })}
                  />
                  <small className="text-[11px] text-slate-500 block mt-1">
                    Tiền đồng phục chia đều từ tháng xuất vào hạng mục đồng phục; ghi nhận từng kỳ ở Vận hành tài chính → Phân bổ.
                  </small>
                </Input>
              )}

              {active === "inbound" && (
                <div className="grid grid-cols-2 gap-3">
                  <Input label="Thuế suất GTGT">
                    <select className="control" value={stockForm.vatRate} onChange={(e) => setStockForm({ ...stockForm, vatRate: e.target.value })}>
                      {VAT_RATE_OPTIONS.map((option) => (
                        <option key={option.code} value={option.code} title={option.description}>{option.code} — {option.description}</option>
                      ))}
                    </select>
                  </Input>
                  {/* Hoá đơn NCC tính thuế trên tổng hoá đơn nên hay lệch vài đồng so với số tự
                      tính từng dòng. Công nợ phải trả lấy số sau thuế, nên phải khai được đúng
                      số trên hoá đơn thì lúc gạch nợ mới khớp. */}
                  <Input label="Tiền thuế theo hoá đơn">
                    <input
                      type="number"
                      className="control text-right"
                      placeholder={stockAutoVatAmount > 0 ? money(stockAutoVatAmount) : "Tự tính"}
                      value={stockForm.vatAmount}
                      onChange={(e) => setStockForm({ ...stockForm, vatAmount: e.target.value })}
                      title={`Để trống = lấy số hệ thống tự tính (${money(stockAutoVatAmount)} đ). Chỉ khai khi hoá đơn ghi số khác vài đồng do làm tròn.`}
                    />
                  </Input>
                </div>
              )}

              {selectedStockItem && (
                <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                  <b>Preview:</b> {qty(stockInputQuantity)} {selectedStockUnit?.unitName || selectedStockUnit?.unitCode || selectedStockItem.unit}
                  {" = "}
                  {qty(stockBaseQuantity)} {selectedStockItem.unit}
                  {active === "inbound" && stockBaseUnitCost > 0 ? ` · Don gia quy doi ${unitPrice(stockBaseUnitCost)} d/${selectedStockItem.unit} · Thanh tien truoc thue ${money(stockAmountBeforeTax)} d` : ""}
                  {active === "inbound" && stockBaseUnitCost > 0 && stockVatAmount > 0
                    ? ` · Thue GTGT ${money(stockVatAmount)} d · Thanh tien sau thue ${money(stockAmountAfterTax)} d`
                    : ""}
                </div>
              )}

              <Input label={active === "inbound" ? "Nhà cung cấp" : "Đối tác"}>
                <select className="control" value={stockForm.partnerCode} onChange={(e) => setStockForm({ ...stockForm, partnerCode: e.target.value })}>
                  <option value="">{active === "inbound" ? "Không khai nhà cung cấp" : "Không khai đối tác"}</option>
                  {partnerFormGroups.map((bucket) => (
                    <optgroup key={bucket.group} label={bucket.label}>
                      {bucket.partners.map((partner) => <option key={partner.code} value={partner.code}>{partner.name}</option>)}
                    </optgroup>
                  ))}
                </select>
              </Input>

              {listPrice && (
                <div className={`rounded-lg border px-3 py-2 text-xs !mt-2 ${listPriceDeviation && !listPriceDeviation.matched ? "border-rose-200 bg-rose-50 text-rose-800" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      Bảng giá <b>{listPrice.priceListCode}</b>: <b>{money(listPrice.unitPrice)} đ/{listPrice.unitCode}</b> trước thuế · {vatRateLabel(listPrice.vatRate)}
                      {" "}(= {unitPrice(listPrice.stockUnitPrice)} đ/{selectedStockItem?.unit})
                    </span>
                    <button
                      type="button"
                      className="font-bold underline"
                      onClick={() => setStockForm({
                        ...stockForm,
                        inputUnitCode: stockUnits.some((unit) => unit.unitCode === listPrice.unitCode) ? listPrice.unitCode : stockForm.inputUnitCode,
                        unitCost: String(stockUnits.some((unit) => unit.unitCode === listPrice.unitCode) ? listPrice.unitPrice : Math.round(listPrice.stockUnitPrice * stockConversionRate * 100) / 100),
                        vatRate: vatRateLabel(listPrice.vatRate),
                      })}
                    >
                      Dùng giá bảng giá
                    </button>
                  </div>
                  {listPriceDeviation && !listPriceDeviation.matched && (
                    <p className="mt-1 font-bold">
                      Đơn giá nhập {unitPrice(stockBaseUnitCost)} đ/{selectedStockItem?.unit} lệch bảng giá {listPriceDeviation.diff > 0 ? "+" : ""}{unitPrice(listPriceDeviation.diff)} đ
                      {listPriceDeviation.ratio !== null ? ` (${listPriceDeviation.diff > 0 ? "+" : ""}${(listPriceDeviation.ratio * 100).toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%)` : ""} — kiểm tra lại hoá đơn NCC.
                    </p>
                  )}
                </div>
              )}

              {createsPurchasePayable && (<>
                <div className="rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-800 !mt-2">
                  Phiếu này sẽ sinh <b>công nợ phải trả</b> cho nhà cung cấp bằng <b>thành tiền sau thuế</b> của phiếu
                  (giá vốn tồn kho vẫn lấy số trước thuế). Dòng <b>đơn giá 0</b> là hàng tặng — vẫn vào kho theo giá
                  bình quân nhưng không tính một đồng nào vào công nợ.
                  Trả tiền rồi thì lập phiếu chi cho chính nhà cung cấp đó để cấn trừ.
                </div>
                <Input label="Hạn thanh toán">
                  <input type="date" className="control" value={stockForm.paymentDueDate} onChange={(e) => setStockForm({ ...stockForm, paymentDueDate: e.target.value })} />
                </Input>
              </>)}

              <Input label="Tham chiếu">
                <input data-input-kind="code" className="control" value={stockForm.referenceCode} onChange={(e) => setStockForm({ ...stockForm, referenceCode: e.target.value })} />
              </Input>
              </>)}

              <button className="primary-button w-full">{grpoOrder ? "Nhận hàng từ PO" : "Ghi nhận"}</button>
            </form>
          )}

          <section className="table-panel shadow-sm">
            <Panel title={active === "inbound" ? "Phiếu nhập kho gần nhất" : "Phiếu xuất kho gần nhất"} reload={loadData} exportFileName={active === "inbound" ? "phieu_nhap_kho" : "phieu_xuat_kho"} />
            {active === "outbound" && data.pendingSales.total > 0 && (
              <div className="mx-5 mb-4 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
                <span className="material-symbols-outlined text-lg">info</span>
                <div className="flex-1">
                  <b>Còn {qty(data.pendingSales.total)} dòng doanh thu chưa rã nguyên liệu.</b> Import doanh thu không tự trừ kho:
                  phiếu <b>Xuất bán</b> chỉ sinh sau khi bấm <b>Rã nguyên liệu</b> ở tab Chế biến (chọn cửa hàng, kho và khoảng ngày bán).
                </div>
                {visibleTabs.some((tab) => tab.id === "production") && (
                  <button type="button" onClick={() => switchTab("production")} className="shrink-0 font-bold text-amber-900 border border-amber-300 rounded-lg px-3 py-1.5 bg-white hover:bg-amber-100">
                    Sang tab Chế biến
                  </button>
                )}
              </div>
            )}
            {data.flowTruncated && (
              <p className="mx-5 mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
                Khoảng ngày này có quá nhiều phiếu — danh sách chỉ tải các phiếu mới nhất. Chọn khoảng ngày ngắn hơn để xem đủ.
              </p>
            )}
            <div className="px-5 pb-4 grid sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 gap-3">
              <Input label="Tìm mã / tên hàng">
                <input className="control" placeholder="Mã, tên hàng hoặc số phiếu..." value={flowSearch} onChange={(e) => setFlowSearch(e.target.value)} />
              </Input>
              <Input label="Từ ngày chứng từ">
                <input type="date" className="control" value={flowRange.from} onChange={(e) => setFlowRange({ ...flowRange, from: e.target.value })} />
              </Input>
              <Input label="Đến ngày chứng từ">
                <input type="date" className="control" value={flowRange.to} onChange={(e) => setFlowRange({ ...flowRange, to: e.target.value })} />
              </Input>
              <Input label="Nhà hàng">
                <select className="control" value={flowBranch} onChange={(e) => { setFlowBranch(e.target.value); setFlowWarehouse("ALL"); }}>
                  <option value="ALL">Tất cả nhà hàng</option>
                  {visibleStoreOptions(user).map((option) => <option key={option.code} value={option.code}>{storeLabel(option.code)}</option>)}
                </select>
              </Input>
              <Input label="Kho">
                <select className="control" value={flowWarehouse} onChange={(e) => setFlowWarehouse(e.target.value)}>
                  <option value="ALL">Tất cả kho</option>
                  {flowWarehouseOptions.map((warehouse) => (
                    <option key={warehouse.code} value={warehouse.code}>{warehouse.name || warehouse.code}{flowBranch === "ALL" && warehouse.branch ? ` · ${storeLabel(warehouse.branch)}` : ""}</option>
                  ))}
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
              <Input label={active === "inbound" ? "Nhà cung cấp" : "Đối tác"}>
                <select className="control" value={flowPartner} onChange={(e) => setFlowPartner(e.target.value)}>
                  <option value="ALL">{active === "inbound" ? "Tất cả nhà cung cấp" : "Tất cả đối tác"}</option>
                  {flowPartnerOptions.options.map((partner) => (
                    <option key={partner.code} value={partner.code}>{partner.name}</option>
                  ))}
                  {flowPartnerOptions.hasBlank && <option value="NONE">(Phiếu chưa khai đối tác)</option>}
                </select>
              </Input>
            </div>
            {showSaleLines ? (
            <Table
              headers={[
                { label: "Chứng từ" },
                { label: "Nhà hàng" },
                { label: "Kho" },
                { label: "Mã hàng" },
                { label: "Tên hàng" },
                { label: "ĐVT" },
                { label: "SL xuất", align: "right" },
                { label: "Giá vốn", align: "right" },
                { label: "Thành tiền", align: "right" },
              ]}
              footer={saleLineRows.length === 0 ? null : (
                <tr>
                  <Cell>CỘNG</Cell>
                  <Cell>{saleLineRows.length} dòng</Cell>
                  <Cell>{new Set(saleLineRows.map(({ row }) => row.transaction.id)).size} phiếu</Cell>
                  <Cell>{""}</Cell>
                  <Cell>{""}</Cell>
                  <Cell>{""}</Cell>
                  <Cell right>{""}</Cell>
                  <Cell right>{""}</Cell>
                  <Cell right>{money(saleLineRows.reduce((sum, { line }) => sum + line.totalCost, 0))} đ</Cell>
                </tr>
              )}
            >
              {saleLineRows.length === 0 && (
                <tr><td colSpan={9} className="cell text-center text-slate-400">Chưa có phiếu xuất bán trong khoảng ngày / bộ lọc này. Phiếu xuất bán sinh khi bấm Rã nguyên liệu ở tab Chế biến.</td></tr>
              )}
              {saleLineRows.map(({ row, line }) => (
                <tr key={line.id} className="border-t border-slate-100">
                  <Cell><CopyableText value={row.transaction.code}><b>{row.transaction.code}</b></CopyableText><small>{new Date(row.transaction.transactionDate).toLocaleDateString("vi-VN")}</small></Cell>
                  <Cell>{storeLabel(row.branchCode)}</Cell>
                  <Cell>{row.warehouseCode}</Cell>
                  <Cell><CopyableText value={line.item.code}>{line.item.code}</CopyableText></Cell>
                  <Cell>{line.item.name}</Cell>
                  <Cell>{line.item.unit}</Cell>
                  <Cell right>{qty(line.quantity)}</Cell>
                  <Cell right>{unitPrice(line.unitCost)}</Cell>
                  <Cell right><b>{money(line.totalCost)} đ</b></Cell>
                </tr>
              ))}
            </Table>
            ) : (
            <Table
              headers={[
                { label: "Chứng từ" },
                { label: "Loại" },
                { label: "Nhà hàng" },
                { label: "Kho" },
                { label: "Mặt hàng" },
                { label: active === "inbound" ? "Tên NCC" : "Tên đối tác" },
                { label: "SL", align: "right" },
                { label: "Giá trị", align: "right" },
                { label: "Thao tác", align: "right" },
              ]}
              footer={(() => {
                const rows = active === "inbound" ? inboundRows : outboundRows;
                if (rows.length === 0) return null;
                const total = sumTransactions(rows);
                return (
                  <tr>
                    <Cell>CỘNG</Cell>
                    <Cell>{total.count} phiếu</Cell>
                    <Cell>{""}</Cell>
                    <Cell>{""}</Cell>
                    <Cell>{""}</Cell>
                    <Cell>{""}</Cell>
                    <Cell right>{""}</Cell>
                    <Cell right>
                      {money(total.beforeTax)} đ
                      {total.vat > 0 && (
                        <small className="block font-normal text-slate-500">
                          + thuế {money(total.vat)} đ = <b>{money(total.afterTax)} đ</b>
                        </small>
                      )}
                    </Cell>
                    <Cell right>{""}</Cell>
                  </tr>
                );
              })()}
            >
              {(active === "inbound" ? inboundRows : outboundRows).map((row) => {
                const lines = row.transaction.lines;
                const preview = lines.slice(0, 3);
                return (
                <tr key={`${row.transaction.id}-${row.displayType}`} className="border-t border-slate-100">
                  <Cell><CopyableText value={row.transaction.code}><b>{row.transaction.code}</b></CopyableText><small>{new Date(row.transaction.transactionDate).toLocaleDateString("vi-VN")}{row.transaction.referenceCode ? ` · ${row.transaction.referenceCode}` : ""}</small></Cell>
                  <Cell>
                    <span className="status bg-slate-100">{movementTypeLabel(row.displayType)}</span>
                    {row.transaction.transactionType === "XUAT_HUY" && row.transaction.subType ? <small>{wasteSubTypeLabel(row.transaction.subType)}</small> : null}
                  </Cell>
                  <Cell>{storeLabel(row.branchCode)}</Cell>
                  <Cell>{row.transaction.transactionType === "DIEU_CHUYEN" ? `${row.transaction.warehouseCode} → ${row.transaction.toWarehouseCode}` : row.warehouseCode}</Cell>
                  <Cell>
                    {preview.map((line) => (
                      <span key={line.id} className="block">{line.item.name}: <b>{qty(line.quantity)}</b> {line.item.unit}</span>
                    ))}
                    {documentLineCount(row.transaction) > preview.length && <small>… và {documentLineCount(row.transaction) - preview.length} mặt hàng khác</small>}
                  </Cell>
                  <Cell>{row.transaction.partnerCode ? partnerName(row.transaction.partnerCode) : <span className="text-slate-400">—</span>}</Cell>
                  <Cell right>{documentQuantityText(row.transaction)}</Cell>
                  <Cell right>
                    <b>{money(documentTotalCost(row.transaction))} đ</b>
                    {/* Có thuế mới in thêm dòng thứ hai: phiếu không thuế thì cột giữ nguyên như cũ. */}
                    {documentVat(row.transaction) > 0 && (
                      <small className="block text-slate-500">
                        + thuế {money(documentVat(row.transaction))} đ
                        {" = "}
                        <b>{money(documentTotalCost(row.transaction) + documentVat(row.transaction))} đ</b>
                      </small>
                    )}
                  </Cell>
                  <Cell right>
                    <div className="flex items-center justify-end gap-1.5">
                    {/* In Phiếu nhập / xuất kho (khách yêu cầu 03/10/2026) — điều chuyển in ở kho nhận
                        (màn Nhập) hoặc kho đi (màn Xuất). */}
                    <button
                      type="button"
                      onClick={() => window.open(`/inventory/${row.transaction.id}/print${active === "outbound" ? "?dir=OUT" : ""}`, "_blank")}
                      className="px-2.5 py-1 bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 rounded-lg text-xs font-bold transition-colors"
                      title={active === "outbound" ? "In phiếu xuất kho" : "In phiếu nhập kho"}
                    >
                      In
                    </button>
                    {/* Điều chuyển góp một dòng cho mỗi màn hình; sửa/xoá nó ở đúng tab Điều chuyển. */}
                    {row.transaction.transactionType === "DIEU_CHUYEN" ? (
                      <span className="text-xs text-slate-400">Ở tab Điều chuyển</span>
                    ) : (
                      <RowActions
                        session={user}
                        module={href}
                        compact
                        onEdit={() => openTransactionEdit(row.transaction)}
                        onDelete={() => { setTransactionDeleteError(null); setDeletingTransaction(row.transaction); }}
                        editDisabledReason={transactionEditLockReason(row.transaction)}
                        deleteDisabledReason={transactionLockReason(row.transaction)}
                      />
                    )}
                    </div>
                  </Cell>
                </tr>
                );
              })}
            </Table>
            )}
          </section>
        </div>
      )}

      {active === "transfer" && (
        <div className="space-y-5">
        {/* Phiếu chờ duyệt đứng trên cùng, trải hết bề ngang — việc cần làm ngay của kho nhận. */}
        <TransferRequestsPanel
          requests={data.transferRequests || []}
          warehouseName={(code) => transferDestinationOptions.find((warehouse) => warehouse.code === code)?.name || code}
          onAction={postTransferRequest}
        />
        <div className="grid lg:grid-cols-[420px_1fr] gap-5">
          {canCreate && (
            <form onSubmit={(e) => {
              e.preventDefault();
              void send({
                action: "TRANSFER_STOCK",
                ...transferForm,
                lines: transferRows.filter((row) => row.itemId).map((row) => ({ itemId: row.itemId, inputQuantity: row.quantity, inputUnitCode: row.unitCode || undefined })),
              }, "Đã gửi phiếu điều chuyển — chờ kho nhận duyệt. Tồn kho chỉ thay đổi khi bên nhận duyệt.");
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
                    {transferDestinationOptions.filter((warehouse) => warehouse.code !== transferForm.warehouseCode).map((warehouse) => (
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
                  ? <>Kho nhận thuộc <b>{storeLabel(transferDestination?.branch || "")}</b> — điều chuyển LIÊN nhà hàng: khi bên nhận duyệt, hệ thống ghi <b>phải thu nội bộ</b> cho bên chuyển và <b>phải trả nội bộ</b> cho bên nhận theo trị giá xuất kho.</>
                  : <>Hai kho cùng một nhà hàng: chỉ cộng trừ trên báo cáo nhập xuất tồn, không phát sinh công nợ nội bộ.</>}
                {" "}Phiếu gửi đi ở trạng thái <b>chờ duyệt</b>: tồn kho chỉ đổi khi kho nhận bấm Duyệt nhận. Nhóm FINISHED không được điều chuyển.
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
                Gửi phiếu điều chuyển (chờ duyệt)
              </button>
            </form>
          )}

          <section className="table-panel shadow-sm">
            <Panel title="Phiếu điều chuyển" reload={loadData} exportFileName="phieu_dieu_chuyen" />
            {/* Khung danh sách đứng cạnh form nên hẹp: 2 cột, màn rộng mới trải 4 cột. */}
            <div className="px-5 pb-4 grid grid-cols-2 2xl:grid-cols-3 gap-3">
              <Input label="Tìm mã / tên hàng">
                <input className="control" placeholder="Mã, tên hàng hoặc số phiếu..." value={transferSearch} onChange={(e) => setTransferSearch(e.target.value)} />
              </Input>
              <Input label="Cửa hàng">
                <select className="control" value={transferStore} onChange={(e) => setTransferStore(e.target.value)}>
                  <option value="ALL">Tất cả cửa hàng</option>
                  {visibleStoreOptions(user).map((option) => <option key={option.code} value={option.code}>{storeLabel(option.code)}</option>)}
                </select>
              </Input>
              <Input label="Từ ngày chứng từ">
                <input type="date" className="control" value={flowRange.from} onChange={(e) => setFlowRange({ ...flowRange, from: e.target.value })} />
              </Input>
              <Input label="Đến ngày chứng từ">
                <input type="date" className="control" value={flowRange.to} onChange={(e) => setFlowRange({ ...flowRange, to: e.target.value })} />
              </Input>
              <Input label="Kho xuất">
                <select className="control" value={transferFromWarehouse} onChange={(e) => setTransferFromWarehouse(e.target.value)}>
                  <option value="ALL">Tất cả kho xuất</option>
                  {transferWarehouseOptions((row) => row.warehouseCode, transferFromWarehouse).map((option) => (
                    <option key={option.code} value={option.code}>{option.name}</option>
                  ))}
                </select>
              </Input>
              <Input label="Kho nhận">
                <select className="control" value={transferToWarehouse} onChange={(e) => setTransferToWarehouse(e.target.value)}>
                  <option value="ALL">Tất cả kho nhận</option>
                  {transferWarehouseOptions((row) => row.toWarehouseCode, transferToWarehouse).map((option) => (
                    <option key={option.code} value={option.code}>{option.name}</option>
                  ))}
                </select>
              </Input>
            </div>
            <Table
              headers={[
                { label: "Chứng từ" },
                { label: "Tuyến điều chuyển" },
                { label: "Phạm vi" },
                { label: "Mặt hàng" },
                { label: "Công nợ nội bộ" },
                { label: "Trị giá", align: "right" },
                { label: "Thao tác", align: "right" },
              ]}
              footer={transferTransactions.length === 0 ? null : (
                <tr>
                  <Cell>CỘNG</Cell>
                  <Cell>{transferTransactions.length} phiếu</Cell>
                  <Cell>{""}</Cell>
                  <Cell>{""}</Cell>
                  <Cell>{""}</Cell>
                  <Cell right>{money(sumTransactions(transferTransactions.map((row) => ({ transaction: row }))).beforeTax)} đ</Cell>
                  <Cell right>{""}</Cell>
                </tr>
              )}
            >
              {transferTransactions.map((row) => {
                const crossBranch = !!row.toBranchCode && row.toBranchCode !== row.branchCode;
                return (
                  <tr key={row.id} className="border-t border-slate-100">
                    <Cell><CopyableText value={row.code}><b>{row.code}</b></CopyableText><small>{new Date(row.transactionDate).toLocaleDateString("vi-VN")}</small><ExplosionBadge status={row.explosionStatus} /></Cell>
                    <Cell>
                      <b>{row.warehouseCode} → {row.toWarehouseCode}</b>
                      <small>{storeLabel(row.branchCode)} → {storeLabel(row.toBranchCode || row.branchCode)}</small>
                    </Cell>
                    <Cell>{crossBranch
                      ? <span className="status bg-amber-50 text-amber-700">Liên nhà hàng</span>
                      : <span className="status bg-slate-100">Nội bộ 1 nhà hàng</span>}
                    </Cell>
                    <Cell>{row.lines.map((line) => `${line.item.name}: ${qty(line.quantity)} ${line.item.unit}`).join(", ")}</Cell>
                    <Cell>{crossBranch && row.internalReceivableDebtCode
                      ? <><b><CopyableText value={row.internalReceivableDebtCode} /></b><small>Phải trả: {row.internalPayableDebtCode}</small></>
                      : <span className="text-slate-400">-</span>}
                    </Cell>
                    <Cell right><b>{money(row.lines.reduce((sum, line) => sum + line.totalCost, 0))} đ</b></Cell>
                    <Cell right>
                      <RowActions
                        session={user}
                        module={href}
                        compact
                        onEdit={() => openTransactionEdit(row)}
                        onDelete={() => { setTransactionDeleteError(null); setDeletingTransaction(row); }}
                        editDisabledReason={transactionEditLockReason(row)}
                        deleteDisabledReason={transactionLockReason(row)}
                      />
                    </Cell>
                  </tr>
                );
              })}
            </Table>
          </section>
        </div>
        </div>
      )}

      {/* Sửa / xoá phiếu kho — dùng chung cho cả ba tab Nhập kho, Xuất kho, Điều chuyển. */}
      {editingTransaction && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <form
            onSubmit={(e) => { e.preventDefault(); void submitTransactionEdit(); }}
            className="bg-white rounded-xl w-full max-w-4xl shadow-xl max-h-[92vh] overflow-y-auto"
          >
            <div className="p-5 border-b border-slate-200">
              <h3 className="font-bold text-slate-900">Sửa phiếu {editingTransaction.code}</h3>
              <p className="text-xs text-slate-500 mt-1">
                {movementTypeLabel(editingTransaction.transactionType)} · {storeLabel(editingTransaction.branchCode)}.
                Lưu xong hệ thống hoàn lại tồn của bản cũ rồi ghi bản mới, nên tồn kho và giá vốn bình quân được tính lại đúng.
              </p>
            </div>

            <div className="p-5 space-y-4">
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                <Input label="Ngày chứng từ">
                  <input type="date" className="control" value={transactionEditForm.transactionDate} onChange={(e) => setTransactionEditForm({ ...transactionEditForm, transactionDate: e.target.value })} required />
                </Input>
                <Input label={editingTransaction.transactionType === "DIEU_CHUYEN" ? "Kho xuất" : "Kho"}>
                  <select className="control" value={transactionEditForm.warehouseCode} onChange={(e) => setTransactionEditForm({ ...transactionEditForm, warehouseCode: e.target.value })}>
                    {warehouseOptions.filter((warehouse) => !warehouse.branch || warehouse.branch === editingTransaction.branchCode).map((warehouse) => (
                      <option key={warehouse.code} value={warehouse.code}>{warehouse.name}</option>
                    ))}
                  </select>
                </Input>
                {editingTransaction.transactionType === "DIEU_CHUYEN" ? (
                  <Input label="Kho nhận">
                    <select className="control" value={transactionEditForm.toWarehouseCode} onChange={(e) => setTransactionEditForm({ ...transactionEditForm, toWarehouseCode: e.target.value })}>
                      {warehouseOptions.map((warehouse) => <option key={warehouse.code} value={warehouse.code}>{warehouse.name}</option>)}
                    </select>
                  </Input>
                ) : editingTransaction.transactionType === "XUAT_HUY" ? (
                  <Input label="Loại hủy">
                    <select className="control" value={transactionEditForm.subType} onChange={(e) => setTransactionEditForm({ ...transactionEditForm, subType: e.target.value })}>
                      <option value="">Chưa phân loại</option>
                      {wasteTypeOptions.map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}
                    </select>
                  </Input>
                ) : (
                  <Input label={isInboundType(editingTransaction.transactionType) ? "Nhà cung cấp" : "Đối tác"}>
                    <select className="control" value={transactionEditForm.partnerCode} onChange={(e) => setTransactionEditForm({ ...transactionEditForm, partnerCode: e.target.value })}>
                      <option value="">Không khai đối tác</option>
                      {activePartners.map((partner) => <option key={partner.code} value={partner.code}>{partner.name}</option>)}
                    </select>
                  </Input>
                )}
                <Input label="Tham chiếu / Số chứng từ">
                  <input data-input-kind="code" className="control" value={transactionEditForm.referenceCode} onChange={(e) => setTransactionEditForm({ ...transactionEditForm, referenceCode: e.target.value })} />
                </Input>
                <Input label="Ghi chú">
                  <input className="control" value={transactionEditForm.note} onChange={(e) => setTransactionEditForm({ ...transactionEditForm, note: e.target.value })} />
                </Input>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <b className="text-sm text-slate-700">Mặt hàng ({transactionEditLines.length} dòng)</b>
                  <button
                    type="button"
                    onClick={() => setTransactionEditLines([...transactionEditLines, { key: `new-${Date.now()}`, itemId: "", quantity: "1", unitCode: "", unitCost: "0", baseUnitCost: 0, vatRate: "KKKNT", vatAmount: "" }])}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-bold hover:bg-slate-50"
                  >
                    + Thêm dòng
                  </button>
                </div>
                {transactionEditLines.map((line, index) => {
                  const item = data.items.find((candidate) => candidate.id === line.itemId);
                  const units = item ? [{ unitCode: item.unit.toUpperCase(), unitName: item.unit }, ...(item.unitConversions || []).filter((unit) => unit.unitCode.toUpperCase() !== item.unit.toUpperCase())] : [];
                  const patch = (changes: Partial<typeof line>) => setTransactionEditLines(transactionEditLines.map((current, position) => position === index ? { ...current, ...changes } : current));
                  return (
                    <div key={line.key} className="grid grid-cols-1 sm:grid-cols-[minmax(160px,2.2fr)_minmax(0,0.7fr)_minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1fr)_36px] gap-2 items-end border border-slate-100 rounded-lg p-2">
                      <Input label={index === 0 ? "Mặt hàng" : ""}>
                        <ItemSelect nameOnly items={data.items} value={line.itemId} onChange={(itemId) => {
                          const picked = data.items.find((candidate) => candidate.id === itemId);
                          patch({ itemId, unitCode: picked?.unitConversions?.[0]?.unitCode || picked?.unit.toUpperCase() || "" });
                        }} />
                      </Input>
                      <Input label={index === 0 ? "Số lượng" : ""}>
                        <input type="number" step="any" className="control text-right" value={line.quantity} onChange={(e) => patch({ quantity: e.target.value })} required />
                      </Input>
                      <Input label={index === 0 ? "ĐVT" : ""}>
                        <select className="control" value={line.unitCode} onChange={(e) => patch({ unitCode: e.target.value })}>
                          {units.map((unit) => <option key={unit.unitCode} value={unit.unitCode}>{unit.unitName || unit.unitCode}</option>)}
                        </select>
                      </Input>
                      <Input label={index === 0 ? "Đơn giá" : ""}>
                        <input
                          type="number"
                          step="any"
                          className="control text-right disabled:bg-slate-100 disabled:text-slate-400"
                          value={isInboundType(editingTransaction.transactionType)
                            ? line.unitCost
                            : String(roundUnitCost(line.baseUnitCost * (item ? safeConversionRate(item.unit, (item.unitConversions || []).find((unit) => unit.unitCode.toUpperCase() === line.unitCode.toUpperCase())) : 1)))}
                          disabled={!isInboundType(editingTransaction.transactionType)}
                          title={isInboundType(editingTransaction.transactionType)
                            ? ""
                            : editingTransaction.transactionType === "DIEU_CHUYEN"
                              ? "Điều chuyển tự tính giá: nguyên liệu/bao bì theo giá mua gần nhất trong tháng, bán thành phẩm theo giá vốn rã BOM trong tháng"
                              : "Phiếu xuất lấy giá vốn bình quân của kho"}
                          onChange={(e) => patch({ unitCost: e.target.value })}
                        />
                      </Input>
                      <Input label={index === 0 ? "Thuế GTGT" : ""}>
                        <select
                          className="control disabled:bg-slate-100 disabled:text-slate-400"
                          value={line.vatRate}
                          disabled={!isInboundType(editingTransaction.transactionType)}
                          title={isInboundType(editingTransaction.transactionType) ? "" : "Chỉ phiếu nhập mới có thuế GTGT đầu vào"}
                          onChange={(e) => patch({ vatRate: e.target.value })}
                        >
                          {VAT_RATE_OPTIONS.map((option) => <option key={option.code} value={option.code} title={option.description}>{option.code}</option>)}
                        </select>
                      </Input>
                      {/* Sửa lại đúng số thuế trên hoá đơn NCC khi máy tự tính lệch vài đồng. */}
                      <Input label={index === 0 ? "Tiền thuế" : ""}>
                        <input
                          type="number"
                          className="control text-right disabled:bg-slate-100 disabled:text-slate-400"
                          value={line.vatAmount}
                          placeholder={editLineAutoVat(line) > 0 ? money(editLineAutoVat(line)) : "Tự tính"}
                          disabled={!isInboundType(editingTransaction.transactionType)}
                          title={isInboundType(editingTransaction.transactionType)
                            ? `Để trống = lấy số hệ thống tự tính (${money(editLineAutoVat(line))} đ). Chỉ khai khi hoá đơn ghi số khác vài đồng do làm tròn.`
                            : "Chỉ phiếu nhập mới có thuế GTGT đầu vào"}
                          onChange={(e) => patch({ vatAmount: e.target.value })}
                        />
                      </Input>
                      <button
                        type="button"
                        onClick={() => setTransactionEditLines(transactionEditLines.filter((_, position) => position !== index))}
                        disabled={transactionEditLines.length <= 1}
                        title={transactionEditLines.length <= 1 ? "Phiếu phải còn ít nhất một dòng" : "Bỏ dòng này"}
                        className="p-2 rounded-lg text-slate-500 hover:text-rose-700 hover:bg-rose-50 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <span className="material-symbols-outlined text-lg">delete</span>
                      </button>
                    </div>
                  );
                })}
              </div>

              {transactionEditError && (
                <p className="rounded-lg bg-rose-50 border border-rose-100 text-rose-700 px-3 py-2 text-sm">{transactionEditError}</p>
              )}
            </div>

            <div className="p-5 border-t border-slate-200 flex items-center justify-end gap-2">
              <button type="button" onClick={() => setEditingTransaction(null)} className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-bold hover:bg-slate-50">Huỷ</button>
              <button type="submit" disabled={transactionEditSaving} className="primary-button">{transactionEditSaving ? "Đang lưu..." : "Lưu phiếu"}</button>
            </div>
          </form>
        </div>
      )}

      <ConfirmDeleteDialog
        open={Boolean(deletingTransaction)}
        title={`Xoá phiếu ${deletingTransaction?.code || ""}?`}
        description={deletingTransaction
          ? `${movementTypeLabel(deletingTransaction.transactionType)} · ${storeLabel(deletingTransaction.branchCode)} · ${deletingTransaction.lines.length} mặt hàng. Tồn kho sẽ được hoàn lại theo đúng số lượng và giá trị của phiếu.`
          : undefined}
        submitting={transactionDeleting}
        error={transactionDeleteError}
        onCancel={() => { setDeletingTransaction(null); setTransactionDeleteError(null); }}
        onConfirm={confirmDeleteTransaction}
      />

      {/* Tab Định lượng chia 3 tab nhỏ (khách yêu cầu 03/10/2026). */}
      {active === "recipes" && (
        <div className="mb-5 flex flex-wrap gap-2 border-b border-slate-200">
          {RECIPE_VIEWS.map((view) => (
            <button
              key={view.id}
              type="button"
              onClick={() => setRecipeView(view.id)}
              className={`-mb-px flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-sm font-bold transition-colors ${recipeView === view.id ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}
            >
              <span className="material-symbols-outlined text-lg">{view.icon}</span>
              {view.label}
            </button>
          ))}
        </div>
      )}

      {active === "recipes" && recipeView === "cost" && canCreate && (
        <section className="bg-white border border-emerald-200 rounded-lg p-5 shadow-sm mb-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-bold text-slate-800 flex items-center gap-2">
                <span className="material-symbols-outlined text-emerald-600">calculate</span>
                Tính giá vốn &amp; giá thành
              </h2>
              <p className="text-xs text-slate-500 mt-1 max-w-2xl leading-relaxed">
                Chạy tuần tự: giá vốn nguyên liệu → giá thành bán thành phẩm cấp 1 → cấp 2 → … → thành phẩm → combo →
                giá vốn cuối kỳ. Kết quả ghi đè giá bình quân của mặt hàng có định lượng, nên mọi phiếu xuất/nhập chế biến
                và điều chỉnh sau đó đều lấy đúng giá mới.
              </p>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <Input label="Cửa hàng">
                <select className="control" value={costingForm.branchCode} onChange={(e) => setCostingForm({ ...costingForm, branchCode: e.target.value })}>
                  {visibleStoreOptions(user).map((option) => <option key={option.code} value={option.code}>{storeLabel(option.code)}</option>)}
                </select>
              </Input>
              <Input label="Ngày tính giá">
                <input type="date" className="control" value={costingForm.costingDate} onChange={(e) => setCostingForm({ ...costingForm, costingDate: e.target.value })} />
              </Input>
              <button
                type="button"
                disabled={costing}
                className="primary-button"
                onClick={async () => {
                  setCosting(true);
                  setMessage("");
                  try {
                    const response = await fetch("/api/inventory", {
                      method: "POST",
                      headers: { "Content-Type": "application/json", ...getSessionHeaders() },
                      body: JSON.stringify({ action: "RUN_COSTING", ...costingForm }),
                    });
                    const payload = await response.json();
                    if (response.ok) {
                      setCostingResult(payload as CostingResult);
                      setMessage(`Đã tính giá: ${payload.levels?.length || 0} tầng định lượng, cập nhật ${payload.updatedBalances} dòng tồn kho.`);
                      await loadData();
                    } else {
                      setMessage(payload.error || "Không tính được giá");
                    }
                  } finally {
                    setCosting(false);
                  }
                }}
              >
                <span className="material-symbols-outlined text-lg">bolt</span>
                {costing ? "Đang tính giá..." : "Tính giá"}
              </button>
            </div>
          </div>

          {costingResult && (
            <div className="mt-4 space-y-3">
              <p className="text-xs text-slate-600">
                Giá vốn nguyên liệu: <b>{costingResult.materialCount}</b> mã · Cập nhật <b>{costingResult.updatedBalances}</b> dòng tồn kho
                · Ngày {new Date(costingResult.costingDate).toLocaleDateString("vi-VN")}
              </p>
              {costingResult.levels.map((level) => (
                <div key={level.level} className="border border-slate-200 rounded-lg overflow-hidden">
                  <div className="bg-slate-50 px-4 py-2 text-xs font-bold text-slate-700">
                    Tầng {level.level} — {level.level === 1 ? "bán thành phẩm cấp 1 (chỉ dùng nguyên liệu)" : `dùng sản phẩm của tầng ${level.level - 1}`}
                  </div>
                  <Table headers={[{ label: "Mã" }, { label: "Tên" }, { label: "Loại" }, { label: "Giá thành / mẻ", align: "right" }, { label: "Giá vốn / ĐVT tồn", align: "right" }, { label: "% Cost", align: "right" }]}>
                    {level.products.map((product) => (
                      <tr key={product.productCode} className="border-t border-slate-100">
                        <Cell><b>{product.productCode}</b></Cell>
                        <Cell>{product.productName}</Cell>
                        <Cell><span className={`status ${product.itemType === "FINISHED" ? "bg-blue-50 text-blue-700" : "bg-violet-50 text-violet-700"}`}>{product.itemType}</span></Cell>
                        <Cell right>{money(product.batchCost)} đ</Cell>
                        <Cell right><b>{unitPrice(product.unitCost)} đ</b></Cell>
                        <Cell right>{product.sellingPrice > 0 ? `${(product.unitCost / product.sellingPrice * 100).toFixed(1)}%` : "-"}</Cell>
                      </tr>
                    ))}
                  </Table>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {active === "recipes" && recipeView === "recipes" && (
        <div className="grid lg:grid-cols-[380px_1fr] gap-5">
          {(canCreate || recipeEditing) && (
            <form ref={recipeFormRef} onSubmit={(e) => { e.preventDefault(); void saveRecipe(); }} className={`bg-white border rounded-lg p-5 space-y-4 h-fit shadow-sm scroll-mt-4 ${recipeEditing ? "border-amber-300 ring-2 ring-amber-100" : "border-slate-200"}`}>
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-bold text-slate-800">{recipeEditing ? `Sửa định lượng ${recipeEditing.label}` : "Tạo định lượng"}</h2>
                {recipeEditing && (
                  <button type="button" className="text-xs font-bold text-slate-500 hover:text-slate-700 hover:underline" onClick={cancelRecipeEdit}>Huỷ sửa</button>
                )}
              </div>
              {recipeEditing && (
                <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2.5 leading-relaxed">
                  Đang sửa thẳng phiên bản này{recipeEditing.ids.length > 1 ? ` (áp cho ${recipeEditing.ids.length} cửa hàng cùng dòng)` : ""}. Nếu phiên bản
                  đã được dùng để <b>rã nguyên liệu</b>, bấm lưu sẽ hiện danh sách lần rã để xác nhận: đồng ý thì phiếu cũ bị gỡ và rã lại theo định lượng mới.
                  Muốn giữ nguyên số đã rã và chỉ áp công thức mới từ một ngày thì dùng <b>Sao chép</b> thay vì Sửa.
                </p>
              )}

              <div className="grid grid-cols-2 gap-3">
                <Input label="Mã món (SP_/BTP_)">
                  <input data-input-kind="code" className="control disabled:bg-slate-100 disabled:text-slate-500" disabled={Boolean(recipeEditing)} value={recipeForm.productCode} onChange={(e) => setRecipeForm({ ...recipeForm, productCode: e.target.value })} />
                </Input>
                <Input label="Giá bán (BTP bỏ trống)">
                  <input type="number" className="control" value={recipeForm.sellingPrice} onChange={(e) => setRecipeForm({ ...recipeForm, sellingPrice: e.target.value })} />
                </Input>
              </div>

              <Input label="Tên món">
                <input className="control" value={recipeForm.productName} onChange={(e) => setRecipeForm({ ...recipeForm, productName: e.target.value })} />
              </Input>

              <div className="flex flex-col gap-1">
                <span className="text-xs font-bold text-slate-600">Cửa hàng áp dụng</span>
                <fieldset disabled={Boolean(recipeEditing)} title={recipeEditing ? "Sửa không đổi được cửa hàng — dùng Sao chép để khai cho cửa hàng khác" : undefined} className="border border-slate-200 rounded-lg p-2.5 bg-slate-50/50 space-y-1.5 disabled:opacity-60">
                  <label className="flex items-center gap-2 text-xs font-bold text-slate-700 cursor-pointer">
                    <input type="checkbox" checked={recipeBranchCodes.length === 0} onChange={() => setRecipeBranchCodes([])} />
                    Dùng chung cho mọi cửa hàng
                  </label>
                  {visibleStoreOptions(user).filter((option) => option.code !== "ALL").map((option) => (
                    <label key={option.code} className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={recipeBranchCodes.includes(option.code)}
                        onChange={(e) => setRecipeBranchCodes(e.target.checked
                          ? [...recipeBranchCodes, option.code]
                          : recipeBranchCodes.filter((code) => code !== option.code))}
                      />
                      {storeLabel(option.code)}
                    </label>
                  ))}
                </fieldset>
              </div>
              <p className="text-[11px] text-slate-500 leading-relaxed !mt-1">
                Giống khai nhiều ĐVT mua cho một mặt hàng: <b>tích nhiều cửa hàng pha giống nhau</b> thì lưu một công thức cho mỗi nơi và bảng bên
                phải gom lại thành <b>một dòng</b>. Nơi nào pha khác thì khai riêng cho nơi đó, dòng tự tách ra. Không tích cửa hàng nào = bản dùng
                chung, áp cho mọi nơi chưa khai riêng.
              </p>

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
                  <button type="button" className="text-xs font-bold text-blue-600 hover:underline flex items-center gap-0.5" onClick={() => setRecipeRows([...recipeRows, { itemId: "", quantity: "1", unitCode: "", conversionRate: "", wasteRate: "0" }])}>
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
                      <ItemSelect items={data.items} value={row.itemId} onChange={(itemId) => setRecipeRows(recipeRows.map((candidate, rowIndex) => rowIndex === index ? { ...candidate, itemId, unitCode: "", conversionRate: "" } : candidate))} />
                    </div>

                    <div className="grid grid-cols-3 gap-3">
                      <div className="flex flex-col gap-1">
                        <span className="text-xs font-bold text-slate-600">Định lượng</span>
                        <input type="number" step="0.001" className="control !mt-0" value={row.quantity} onChange={(e) => setRecipeRows(recipeRows.map((candidate, rowIndex) => rowIndex === index ? { ...candidate, quantity: e.target.value } : candidate))} />
                      </div>

                      <div className="flex flex-col gap-1">
                        <span className="text-xs font-bold text-slate-600">ĐVT</span>
                        <select className="control !mt-0" value={row.unitCode} onChange={(e) => setRecipeRows(recipeRows.map((candidate, rowIndex) => rowIndex === index ? { ...candidate, unitCode: e.target.value, conversionRate: "" } : candidate))}>
                          <option value="">{rowItem ? `${rowItem.unit} (ĐVT tồn kho)` : "ĐVT tồn kho"}</option>
                          {rowUnits.filter((unit) => unit.conversionRate !== 1).map((unit) => (
                            <option key={unit.unitCode} value={unit.unitCode}>{unit.unitName || unit.unitCode}</option>
                          ))}
                          {/* ĐVT khai thẳng lúc import (không có trong danh mục quy đổi) vẫn phải hiện đúng khi Sửa / Sao chép. */}
                          {row.unitCode && !rowUnits.some((unit) => unit.unitCode.toUpperCase() === row.unitCode.toUpperCase()) && (
                            <option value={row.unitCode}>{row.unitCode}</option>
                          )}
                        </select>
                        {row.conversionRate && (
                          <small className="text-[10px] text-slate-500">× {row.conversionRate} {rowItem?.unit || ""}</small>
                        )}
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
              
              <div className="flex gap-2">
                <button className="primary-button flex-1">{recipeEditing ? "Lưu thay đổi" : "Lưu phiên bản"}</button>
                {recipeEditing && (
                  <button type="button" className="px-3 rounded-lg border border-slate-200 text-sm font-bold text-slate-600 hover:bg-slate-50" onClick={cancelRecipeEdit}>Huỷ</button>
                )}
              </div>
            </form>
          )}
          
          <div className="space-y-5 min-w-0">
            <section className="table-panel shadow-sm">
              <Panel title="Chi tiết các phiên bản định lượng" reload={loadData} />
              <div className="px-5 pb-4 flex flex-wrap items-end gap-3">
                <div className="flex-1 min-w-[220px] max-w-sm">
                  <Input label="Tìm món">
                    <input className="control" placeholder="Gõ mã hoặc tên món, mã nguyên liệu..." value={recipeSearch} onChange={(e) => setRecipeSearch(e.target.value)} />
                  </Input>
                </div>
                <div className="flex-1 min-w-[220px] max-w-sm">
                  <Input label="Lọc nguyên liệu (chỉ hiện dòng khớp)">
                    <input className="control" placeholder="Mã / tên nguyên liệu, BTP..." value={recipeIngredientSearch} onChange={(e) => setRecipeIngredientSearch(e.target.value)} />
                  </Input>
                </div>
                <div className="w-44">
                  <Input label="Áp dụng trong tháng">
                    <input type="month" className="control" value={recipeMonth} onChange={(e) => setRecipeMonth(e.target.value)} />
                  </Input>
                </div>
                <button type="button" className="secondary-button !min-h-10" onClick={() => void exportRecipeVersionsFlat()} title="Mỗi nguyên liệu một dòng, thông tin món lặp lại ở từng dòng — theo bộ lọc đang xem">
                  <span className="material-symbols-outlined text-lg">download</span>Xuất Excel
                </button>
                {recipeFilterActive && (
                  <p className="pb-2 text-xs text-slate-500 w-full">
                    Hiển thị <b>{filteredRecipeGroups.length}</b> / {groupedRecipes.length} định lượng
                    {recipeMonth && <> · phiên bản có áp dụng trong tháng {recipeMonth.slice(5)}/{recipeMonth.slice(0, 4)}</>}
                    {ingredientKeyword && <> · chỉ hiện dòng nguyên liệu khớp “{recipeIngredientSearch.trim()}”</>}
                    <button type="button" className="ml-2 font-bold text-blue-600 hover:underline" onClick={() => { setRecipeSearch(""); setRecipeIngredientSearch(""); setRecipeMonth(""); }}>Xoá lọc</button>
                  </p>
                )}
              </div>
              {/* Mỗi nguyên liệu một dòng, đúng khuôn sheet Chi tiết lúc import BOM — thông tin món gộp ô. */}
              <Table
                headers={[
                  { label: "Sản phẩm" },
                  { label: "Cửa hàng" },
                  { label: "Phiên bản" },
                  { label: "Mã nguyên liệu" },
                  { label: "Tên nguyên liệu" },
                  { label: "Định lượng", align: "right" },
                  { label: "ĐVT" },
                  { label: "Hao hụt", align: "right" },
                  { label: "Cost NL", align: "right" },
                  { label: "Cost / mẻ", align: "right" },
                  { label: "Giá bán", align: "right" },
                  { label: "Tỷ lệ cost", align: "right" },
                  { label: "Thao tác", align: "right" },
                ]}
              >
                {recipeFilterActive && filteredRecipeGroups.length === 0 && (
                  <tr className="border-t border-slate-100">
                    <td colSpan={13} className="px-4 py-10 text-center text-sm text-slate-400">Không có định lượng nào khớp bộ lọc.</td>
                  </tr>
                )}
                {filteredRecipeGroups.map(({ key, recipe, branchCodes, versions, ids }) => {
                  const visibleLines = recipe.lines.filter(lineMatchesIngredient);
                  const lines = visibleLines.length > 0 ? visibleLines : [null];
                  const validity = groupValidity(ids);
                  const span = lines.length;
                  const isEditingThis = Boolean(recipeEditing && ids.every((id) => recipeEditing.ids.includes(id)));
                  const groupCell = "cell align-top bg-white";
                  const groupNumberCell = "cell align-top bg-white text-right tabular-nums whitespace-nowrap";
                  return lines.map((line, index) => (
                    <tr key={`${key}-${index}`} className={`${index === 0 ? "border-t-2 border-slate-200" : "border-t border-slate-50"} ${isEditingThis ? "bg-amber-50/60" : ""}`}>
                      {index === 0 && (
                        <>
                          <td rowSpan={span} className={groupCell}>
                            <b>{recipe.productCode} - {recipe.productName}</b>
                            <small>Mẻ: {recipe.unit}{recipe.outputConversionRate !== 1 ? ` (= ${qty(recipe.outputConversionRate)} ĐVT tồn)` : ""}</small>
                          </td>
                          <td rowSpan={span} className={groupCell}>{branchScopeCell(branchCodes)}</td>
                          <td rowSpan={span} className={`${groupCell} whitespace-nowrap`}>
                            {[...versions].sort((a, b) => a - b).map((version) => `V${version}`).join(" / ")}
                            <small>
                              Áp dụng {new Date(recipe.effectiveFrom).toLocaleDateString("vi-VN")}
                              {validity?.to ? ` → ${dayLabel(validity.to)}` : validity ? " → nay" : " · bị phiên bản cùng ngày thay"}
                              {recipe.status === "ACTIVE" ? "" : " · cũ"}
                            </small>
                            {ingredientKeyword && visibleLines.length < recipe.lines.length && (
                              <small className="text-blue-600">{visibleLines.length}/{recipe.lines.length} nguyên liệu khớp</small>
                            )}
                          </td>
                        </>
                      )}
                      {line ? (
                        <>
                          <td className="cell whitespace-nowrap"><CopyableText value={line.item.code}>{line.item.code}</CopyableText></td>
                          <td className="cell">{line.item.name}</td>
                          <td className="cell text-right tabular-nums whitespace-nowrap">{qty(line.quantity)}</td>
                          <td className="cell whitespace-nowrap">
                            {line.unitCode || line.item.unit}
                            {line.unitCode && line.unitCode.toUpperCase() !== (line.item.unit || "").toUpperCase() && line.conversionRate !== 1
                              ? <small>= {qty(line.conversionRate)} {line.item.unit}</small>
                              : null}
                          </td>
                          <td className="cell text-right tabular-nums whitespace-nowrap">{line.wasteRate ? `${line.wasteRate}%` : "-"}</td>
                          <td className="cell text-right tabular-nums whitespace-nowrap">{line.lineCost !== undefined ? `${money(line.lineCost)} đ` : "-"}</td>
                        </>
                      ) : (
                        <td colSpan={6} className="cell text-slate-400 italic">Chưa có nguyên liệu</td>
                      )}
                      {index === 0 && (
                        <>
                          <td rowSpan={span} className={groupNumberCell}><b>{money(recipe.estimatedCost)} đ</b></td>
                          <td rowSpan={span} className={groupNumberCell}>{money(recipe.sellingPrice)} đ</td>
                          <td rowSpan={span} className={groupNumberCell}>{recipe.sellingPrice > 0 ? `${(recipe.estimatedCost / recipe.sellingPrice * 100).toFixed(1)}%` : "-"}</td>
                          <td rowSpan={span} className={`${groupCell} text-right`} data-no-export>
                            <div className="flex items-center justify-end gap-1">
                              {canCreate && (
                                <button
                                  type="button"
                                  title="Sao chép thành phiên bản mới (chọn ngày áp dụng mới, bản cũ giữ cho các ngày trước)"
                                  onClick={() => loadRecipeIntoForm(recipe, branchCodes, ids, "copy")}
                                  className="p-1.5 rounded-lg text-slate-500 hover:text-emerald-700 hover:bg-emerald-50 transition-colors"
                                >
                                  <span className="material-symbols-outlined text-base">content_copy</span>
                                </button>
                              )}
                              <RowActions session={user} module={href} compact onEdit={() => loadRecipeIntoForm(recipe, branchCodes, ids, "edit")} />
                            </div>
                          </td>
                        </>
                      )}
                    </tr>
                  ));
                })}
              </Table>
            </section>
          </div>
        </div>
      )}

      {/* Tab nhỏ "Giá thành sản phẩm": sheet giá vốn & giá thành (nút Tính giá ở trên). */}
      {active === "recipes" && recipeView === "cost" && (
        <div className="space-y-5">
            <section className="table-panel shadow-sm">
              <Panel
                title={costMonth ? `Sheet tổng hợp — Giá vốn & giá thành tháng ${costMonth.slice(5)}/${costMonth.slice(0, 4)}` : "Sheet tổng hợp — Giá vốn & giá thành theo định lượng đang áp dụng"}
                reload={loadData}
                exportFileName={costMonth ? `gia_von_gia_thanh_${costMonth}` : "gia_von_gia_thanh"}
              />
              <div className="px-5 pb-4 flex flex-wrap items-end gap-3">
                <div className="w-48">
                  <Input label="Tháng">
                    <input type="month" className="control" value={costMonth} onChange={(e) => setCostMonth(e.target.value)} />
                  </Input>
                </div>
                {costMonth && (
                  <button type="button" className="pb-2 text-xs font-bold text-blue-600 hover:underline" onClick={() => setCostMonth("")}>Xem đang áp dụng hôm nay</button>
                )}
                <div className="w-52">
                  <Input label="Nhóm hàng">
                    <select className="control" value={costGroupFilter} onChange={(e) => setCostGroupFilter(e.target.value)}>
                      <option value="ALL">Tất cả nhóm</option>
                      <option value="FINISHED">Thành phẩm (FINISHED)</option>
                      <option value="SEMI_FINISHED">Bán thành phẩm (SEMI_FINISHED)</option>
                    </select>
                  </Input>
                </div>
                <div className="w-52">
                  <Input label="Cửa hàng">
                    <select className="control" value={costStoreFilter} onChange={(e) => setCostStoreFilter(e.target.value)}>
                      <option value="ALL">Tất cả cửa hàng</option>
                      {visibleStoreOptions(user).map((option) => <option key={option.code} value={option.code}>{storeLabel(option.code)}</option>)}
                    </select>
                  </Input>
                </div>
                <p className="w-full text-[11px] text-slate-500 leading-relaxed">
                  <b>Đổi giá bán / định lượng:</b> sang tab nhỏ <b>Định lượng</b>, bấm nút <b>Sao chép</b> ở phiên bản đang dùng → nhập giá bán mới và
                  <b> ngày áp dụng mới</b> rồi lưu. Phiên bản cũ vẫn giữ cho các ngày trước; trong tháng đổi mấy lần thì tạo mấy phiên bản. Chọn
                  <b> Tháng</b> để xem mỗi phiên bản áp dụng trong tháng một dòng, kèm khoảng ngày.
                </p>
                {costMonth && !costMonthLoaded && <p className="pb-2 text-xs text-slate-500">Đang tải giá thành tháng {costMonth}...</p>}
                {costMonthLoaded && monthlyCost?.error && <p className="pb-2 text-xs text-rose-700">{monthlyCost.error}</p>}
                {(costGroupFilter !== "ALL" || costStoreFilter !== "ALL") && (
                  <p className="pb-2 text-xs text-slate-500">
                    Hiển thị <b>{filteredCostSummary.length}</b> / {groupedCostSummary.length} dòng
                    {costStoreFilter !== "ALL" && " (gồm bản dùng chung của món chưa có định lượng riêng cho cửa hàng này)"}
                  </p>
                )}
              </div>
              <Table
                headers={[
                  { label: "Nhóm" },
                  { label: "Mã sản phẩm" },
                  { label: "Cửa hàng" },
                  ...(costMonth ? [{ label: "Áp dụng" }] : []),
                  { label: "Tên sản phẩm" },
                  { label: "ĐVT tồn kho" },
                  { label: "Giá bán", align: "right" },
                  { label: "Giá cost", align: "right" },
                  { label: "% Cost", align: "right" },
                ]}
              >
                {filteredCostSummary.map(({ key, row, branchCodes, versions }) => (
                  <tr key={key} className="border-t border-slate-100">
                    <Cell><span className={`status ${row.group === "FINISHED" ? "bg-blue-50 text-blue-700" : "bg-violet-50 text-violet-700"}`}>{row.group}</span></Cell>
                    <Cell><CopyableText value={row.productCode}><b>{row.productCode}</b></CopyableText><small>{versions.sort((a, b) => a - b).map((version) => `V${version}`).join(" / ")}</small></Cell>
                    <Cell>{branchScopeCell(branchCodes)}</Cell>
                    {costMonth && <Cell>{row.appliedFrom ? `${row.appliedFrom.slice(8, 10)}/${row.appliedFrom.slice(5, 7)} – ${(row.appliedTo || "").slice(8, 10)}/${(row.appliedTo || "").slice(5, 7)}` : "-"}</Cell>}
                    <Cell>{row.productName}</Cell>
                    <Cell>{row.stockUnit}{row.outputConversionRate !== 1 ? <small>1 {row.batchUnit} = {qty(row.outputConversionRate)} {row.stockUnit}</small> : null}</Cell>
                    <Cell right>{row.group === "FINISHED" ? `${money(row.sellingPrice)} đ` : "-"}</Cell>
                    <Cell right><b>{unitPrice(row.unitCost)} đ</b></Cell>
                    <Cell right>{row.costRatio !== null ? <b className={row.costRatio > 0.4 ? "text-rose-600" : "text-emerald-700"}>{(row.costRatio * 100).toFixed(1)}%</b> : "-"}</Cell>
                  </tr>
                ))}
              </Table>
            </section>
        </div>
      )}

      {/* Tab nhỏ "Thông tin định lượng trong tháng": món / thành phần trong tháng đã đủ định lượng chưa. */}
      {active === "recipes" && recipeView === "monthly" && (
        <div className="space-y-5">
            <MissingRecipesPanel
              sessionKey={SESSION_KEY}
              branchOptions={[
                ...(visibleStoreOptions(user).length > 1 ? [{ code: "ALL", label: "Tất cả cửa hàng" }] : []),
                ...visibleStoreOptions(user).map((option) => ({ code: option.code, label: storeLabel(option.code) })),
              ]}
              defaultBranch={visibleStoreOptions(user).length > 1 ? "ALL" : visibleStoreOptions(user)[0]?.code || "ALL"}
            />
        </div>
      )}

      {active === "production" && canCreate && (
        <section className="bg-white border border-indigo-200 rounded-lg p-5 shadow-sm mb-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-bold text-slate-800 flex items-center gap-2">
                <span className="material-symbols-outlined text-indigo-600">account_tree</span>
                Rã nguyên liệu
              </h2>
              <p className="text-xs text-slate-500 mt-1 max-w-2xl leading-relaxed">
                Lấy số món đã bán từ import doanh thu (chưa cần import thêm file nào), rã theo định lượng đang áp dụng
                theo thứ tự <b>bán thành phẩm → thành phẩm → combo</b>, rồi tự sinh phiếu xuất chế biến, nhập chế biến và xuất bán.
                Cùng lần rã còn rã <b>bán thành phẩm điều chuyển đi</b> (toàn bộ số chuyển, trừ nguyên liệu ở kho xuất) và
                <b> phần kiểm dư bán thành phẩm</b> (thực tế − sổ sách, trừ nguyên liệu ở kho được kiểm) trong khoảng ngày đã chọn.
              </p>
            </div>
            <div className="rounded-lg border border-indigo-100 bg-indigo-50 px-3 py-2 text-xs text-indigo-800">
              Đang chờ rã: <b>{data.pendingSales.total}</b> dòng doanh thu
              {(data.pendingSales.sources?.length || 0) > 0 && (
                <>
                  {" · "}<b>{data.pendingSales.sources?.filter((source) => source.kind === "TRANSFER").length}</b> phiếu điều chuyển
                  {" · "}<b>{data.pendingSales.sources?.filter((source) => source.kind === "STOCKTAKE").length}</b> phiếu kiểm kê
                </>
              )}
            </div>
          </div>
          <div className="grid md:grid-cols-4 gap-3 mt-4">
            <Input label="Cửa hàng">
              <select className="control" value={explodeBranchCode} onChange={(e) => setExplodeForm({ ...explodeForm, branchCode: e.target.value })}>
                {visibleStoreOptions(user).map((option) => <option key={option.code} value={option.code}>{storeLabel(option.code)}</option>)}
              </select>
            </Input>
            <Input label="Từ ngày bán">
              <input type="date" className="control" value={explodeForm.dateFrom} onChange={(e) => setExplodeForm({ ...explodeForm, dateFrom: e.target.value })} />
            </Input>
            <Input label="Đến ngày bán">
              <input type="date" className="control" value={explodeForm.dateTo} onChange={(e) => setExplodeForm({ ...explodeForm, dateTo: e.target.value })} />
            </Input>
            {/* Kiểm kê chốt giữa ngày (11h 31/8): rã tới đúng giờ chốt, phần bán sau đó rã lần sau.
                Chỉ chia được khi file POS có giờ bán. */}
            <Input label="Rã tới giờ (ngày cuối)">
              <select className="control" value={explodeForm.timeTo} onChange={(e) => setExplodeForm({ ...explodeForm, timeTo: e.target.value })}>
                <option value="">Cả ngày</option>
                {Array.from({ length: 23 }, (_, index) => index + 1).map((hour) => (
                  <option key={hour} value={String(hour)}>Trước {String(hour).padStart(2, "0")}:00</option>
                ))}
              </select>
            </Input>
            <Input label="Kho xuất NVL">
              <select className="control" value={explodeWarehouseCode} onChange={(e) => setExplodeForm({ ...explodeForm, warehouseCode: e.target.value })}>
                {productionWarehouses.map((warehouse) => (
                  <option key={warehouse.code} value={warehouse.code}>{warehouse.name || warehouse.code}</option>
                ))}
              </select>
            </Input>
            <Input label="Kho nhập BTP/TP">
              <select className="control" value={explodeToWarehouseCode} onChange={(e) => setExplodeForm({ ...explodeForm, toWarehouseCode: e.target.value })}>
                {productionWarehouses.map((warehouse) => (
                  <option key={warehouse.code} value={warehouse.code}>{warehouse.name || warehouse.code}</option>
                ))}
              </select>
            </Input>
            {/* Đồ ăn trừ kho Bếp, đồ uống trừ kho Bar. Không còn lựa chọn "không tách": bỏ tách là
                mọi món (kể cả đồ uống) dồn về một kho. */}
            <Input label="Kho ĐỒ ĂN (bếp)">
              <select className="control" value={kitchenWarehouseCode} onChange={(e) => setExplodeForm({ ...explodeForm, kitchenWarehouseCode: e.target.value })}>
                {(kitchenWarehouses.length ? kitchenWarehouses : explodeWarehouses).map((warehouse) => (
                  <option key={warehouse.code} value={warehouse.code}>{warehouse.name || warehouse.code}</option>
                ))}
              </select>
            </Input>
            <Input label="Kho ĐỒ UỐNG (bar)">
              <select className="control" value={barWarehouseCode} onChange={(e) => setExplodeForm({ ...explodeForm, barWarehouseCode: e.target.value })}>
                {(barWarehouses.length ? barWarehouses : explodeWarehouses).map((warehouse) => (
                  <option key={warehouse.code} value={warehouse.code}>{warehouse.name || warehouse.code}</option>
                ))}
              </select>
            </Input>
          </div>
          <p className="mt-2 text-[11px] text-slate-500 leading-relaxed">
            Khai hai ô trên thì món <b>Đồ ăn</b> trừ và nhập lại ở kho Bếp, món <b>Đồ uống</b> ở kho Bar — theo Nhóm doanh thu của món
            (hoặc Phân nhóm mặt hàng nếu đã khai). <b>Bán thành phẩm đi theo kho của món bán ra</b>: dùng cho món bếp thì chế biến ở kho
            Bếp, cho món bar thì ở kho Bar (dùng cho cả hai thì tách đúng phần ở từng kho). <b>Combo</b> nhập kho và xuất bán ở kho Bếp,
            còn từng thành phần trừ ở kho của chính nó (đồ uống trong combo trừ kho Bar). Chỉ món bán chưa gán nhóm mới đi kho mặc
            định (Kho xuất NVL / Kho nhập BTP/TP — chỉ chọn được kho Bếp / Bar, mặc định kho Bếp), và được đếm lại trong thông báo sau khi rã.
          </p>
          {data.pendingSales.byDay.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {data.pendingSales.byDay.slice(0, 12).map((day) => (
                <span key={`${day.saleDate}-${day.branchCode}`} className="status bg-slate-100 text-slate-600">
                  {new Date(day.saleDate).toLocaleDateString("vi-VN")} · {storeLabel(day.branchCode)}: {day.rowCount} dòng / {qty(day.totalQuantity)} món
                </span>
              ))}
            </div>
          )}
          {/* Danh sách xuất bán lấy từ import doanh thu: chỉ nhóm Đồ ăn / Đồ uống (nhóm dịch vụ
              không theo dõi tồn kho nên không có ở đây). Đây là số lượng sẽ chạy định lượng. */}
          {data.pendingSales.byItem.length > 0 && (
            <details className="mt-3 rounded-lg border border-slate-200 bg-slate-50">
              <summary className="cursor-pointer px-3 py-2 text-xs font-bold text-slate-700">
                Danh sách xuất bán chờ rã ({data.pendingSales.byItem.length} mặt hàng)
              </summary>
              <div className="overflow-x-auto px-3 pb-3">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-slate-500">
                      <th className="py-1 pr-3">Mã hàng</th>
                      <th className="py-1 pr-3">Tên hàng</th>
                      <th className="py-1 pr-3">Nhóm doanh thu</th>
                      <th className="py-1 pr-3 text-right">Số lượng bán</th>
                      <th className="py-1 text-right">Dòng</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.pendingSales.byItem.slice(0, 50).map((item) => (
                      <tr key={item.productCode} className="border-t border-slate-200">
                        <td className="py-1 pr-3 font-mono">{item.productCode}</td>
                        <td className="py-1 pr-3">{item.productName}</td>
                        <td className="py-1 pr-3">{data.revenueGroups.find((group) => group.code === item.revenueSource)?.name || item.revenueSource || "-"}</td>
                        <td className="py-1 pr-3 text-right tabular-nums whitespace-nowrap">{qty(item.totalQuantity)}</td>
                        <td className="py-1 text-right">{item.rowCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {data.pendingSales.byItem.length > 50 && (
                  <p className="mt-1 text-[11px] text-slate-500">Chỉ hiện 50 mặt hàng bán nhiều nhất.</p>
                )}
              </div>
            </details>
          )}
          {/* Điều chuyển / kiểm dư bán thành phẩm chờ rã: rã ở chính kho của phiếu, theo ngày phiếu. */}
          {(data.pendingSales.sources?.length || 0) > 0 && (
            <details className="mt-3 rounded-lg border border-slate-200 bg-slate-50">
              <summary className="cursor-pointer px-3 py-2 text-xs font-bold text-slate-700">
                Điều chuyển / kiểm kê bán thành phẩm chờ rã ({data.pendingSales.sources?.length} phiếu)
              </summary>
              <div className="overflow-x-auto px-3 pb-3">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-slate-500">
                      <th className="py-1 pr-3">Ngày</th>
                      <th className="py-1 pr-3">Phiếu</th>
                      <th className="py-1 pr-3">Kho chế biến</th>
                      <th className="py-1 pr-3">Bán thành phẩm</th>
                      <th className="py-1 text-right">Số lượng rã</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.pendingSales.sources?.flatMap((source) => source.items.map((item, index) => (
                      <tr key={`${source.kind}-${source.code}-${item.itemCode}`} className={index === 0 ? "border-t border-slate-200" : ""}>
                        <td className="py-1 pr-3 whitespace-nowrap">{index === 0 ? new Date(source.date).toLocaleDateString("vi-VN") : ""}</td>
                        <td className="py-1 pr-3 whitespace-nowrap">
                          {index === 0 && (
                            <>
                              <span className={`status mr-1 ${source.kind === "TRANSFER" ? "bg-sky-100 text-sky-700" : "bg-amber-100 text-amber-800"}`}>{source.kind === "TRANSFER" ? "Điều chuyển" : "Kiểm dư"}</span>
                              <span className="font-mono">{source.code}</span>
                            </>
                          )}
                        </td>
                        <td className="py-1 pr-3">{index === 0 ? `${storeLabel(source.branchCode)} · ${data.warehouses.find((warehouse) => warehouse.code === source.warehouseCode)?.name || source.warehouseCode}` : ""}</td>
                        <td className="py-1 pr-3">{item.itemName} <span className="text-slate-400 font-mono">{item.itemCode}</span></td>
                        <td className="py-1 text-right tabular-nums whitespace-nowrap">{qty(item.quantity)} {item.unit}</td>
                      </tr>
                    )))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
          {/* Ô kho rỗng mà không nói gì thì người dùng bấm nút rồi tưởng nút chết (khách gặp
              21/09 và 22/09/2026). Nói thẳng cửa hàng nào thiếu kho và phải sửa ở đâu. */}
          {explodeWarehouses.length === 0 && (
            <p className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              <b>Chưa rã được:</b> cửa hàng {storeLabel(explodeBranchCode)} không có kho nào trong danh mục
              nên không chọn được Kho xuất NVL. Vào <b>Cấu hình Danh mục → Kho</b> khai kho cho cửa hàng này,
              hoặc kiểm lại cột <b>Cửa hàng</b> của các kho đang có — kho khai sai mã cửa hàng cũng không hiện ra đây.
            </p>
          )}
          <button
            type="button"
            disabled={exploding || explodeWarehouses.length === 0}
            title={explodeWarehouses.length === 0 ? "Cửa hàng này chưa khai kho nào trong Danh mục" : undefined}
            className="primary-button mt-4"
            onClick={async () => {
              setExploding(true);
              try {
                const explodeBody = {
                  action: "EXPLODE_PRODUCTION",
                  ...explodeForm,
                  // Gửi mã cửa hàng + mã kho ĐÃ CHUẨN HOÁ, không gửi giá trị chết còn sót.
                  branchCode: explodeBranchCode,
                  warehouseCode: explodeWarehouseCode,
                  toWarehouseCode: explodeToWarehouseCode,
                  kitchenWarehouseCode,
                  barWarehouseCode,
                };
                let payload = await send(explodeBody, "Đã rã nguyên liệu và sinh phiếu chế biến + xuất bán.");
                // Khoảng ngày có ngày ĐÃ RÃ: hỏi trước rồi gỡ + rã lại các lần rã đó với kho đang chọn.
                if (payload?.needsRerunConfirm) {
                  const runs = (payload.runs || []) as Array<{ runCode: string; date: string; revenueRows: number; transfers?: number; stocktakes?: number }>;
                  const ok = window.confirm(
                    "Khoảng ngày này đã có ngày được rã rồi:\n"
                    + runs.map((run) => `• ${run.runCode} — ngày ${new Date(run.date).toLocaleDateString("vi-VN")}, ${run.revenueRows} dòng doanh thu`
                      + (run.transfers ? `, ${run.transfers} phiếu điều chuyển` : "")
                      + (run.stocktakes ? `, ${run.stocktakes} phiếu kiểm kê` : "")).join("\n")
                    + "\n\nOK: gỡ toàn bộ phiếu của các lần rã trên, rã lại theo định lượng và kho đang chọn (lần rã mới mang mã mới, phiếu cũ vào Thùng rác), rồi rã tiếp phần còn chờ.\n"
                    + "Huỷ: không làm gì.",
                  );
                  if (!ok) {
                    setMessage("Đã huỷ, chưa rã lại.");
                    return;
                  }
                  payload = await send({ ...explodeBody, confirmRerun: true }, "Đã rã lại nguyên liệu và sinh phiếu chế biến + xuất bán.");
                }
                // Lần rã luôn chạy tới cùng (luật xuất âm), nhưng ba chuyện dưới đây phải nói ra
                // cho kế toán biết mà xử lý tiếp, nếu không họ tưởng đã xong hẳn.
                const notes: string[] = [];
                const unsplitRows = Number(payload?.unsplitRows || 0);
                if (unsplitRows > 0) {
                  notes.push(`${unsplitRows} dòng doanh thu ngày cuối không có giờ bán nên chưa rã (file POS chỉ ghi ngày) — còn ở hàng chờ, rã cả ngày ở lần sau.`);
                }
                const undecided = Number(payload?.undecidedCount || 0);
                if (undecided > 0) {
                  const codes = (payload?.undecidedProducts || []) as string[];
                  notes.push(`${undecided} mã hàng chưa xác định được Bếp hay Bar nên đi kho mặc định${codes.length ? `: ${codes.slice(0, 8).join(", ")}${undecided > codes.slice(0, 8).length ? "..." : ""}` : ""}. Gán Nhóm doanh thu cho các mã này ở tab Mặt hàng để lần rã sau vào đúng kho.`);
                }
                const negativeCount = Number(payload?.negativeCount || 0);
                if (negativeCount > 0) {
                  const items = (payload?.negativeItems || []) as Array<{ itemCode: string; warehouseCode: string; quantity: number }>;
                  const shown = items.slice(0, 8).map((item) => `${item.itemCode} (${item.warehouseCode}: ${item.quantity})`);
                  notes.push(`${negativeCount} mã đang ÂM KHO sau lần rã${shown.length ? `: ${shown.join(", ")}${negativeCount > shown.length ? "..." : ""}` : ""}. Khai tồn đầu kỳ hoặc nhập mua cho các mã này để tồn về đúng.`);
                }
                const zeroCostCount = Number(payload?.zeroCostCount || 0);
                if (zeroCostCount > 0) {
                  const codes = (payload?.zeroCostItems || []) as string[];
                  notes.push(`${zeroCostCount} mã xuất với GIÁ VỐN 0 vì kho chưa có giá nhập nào${codes.length ? `: ${codes.slice(0, 8).join(", ")}${zeroCostCount > codes.slice(0, 8).length ? "..." : ""}` : ""}. Báo cáo giá vốn còn thiếu đúng phần này cho tới khi có giá và chạy lại "Tính giá vốn & giá thành".`);
                }
                // Lấy tồn trước, chế biến phần thiếu: nói rõ để kế toán hiểu vì sao số nhập chế
                // biến nhỏ hơn số xuất.
                const stockUsed = (payload?.stockUsed || []) as Array<{ productCode: string; quantityBase: number; warehouseCode: string }>;
                if (stockUsed.length > 0) {
                  const shown = stockUsed.slice(0, 8).map((row) => `${row.productCode} ${row.quantityBase.toLocaleString("vi-VN", { maximumFractionDigits: 3 })} (${row.warehouseCode})`);
                  notes.push(`Dùng tồn có sẵn trước, chỉ chế biến phần thiếu: ${shown.join(", ")}${stockUsed.length > shown.length ? "..." : ""}.`);
                }
                const transferCount = Number(payload?.transferCount || 0);
                const stocktakeCount = Number(payload?.stocktakeCount || 0);
                const issueCount = Number(payload?.issueCount || 0);
                if (transferCount > 0 || stocktakeCount > 0 || issueCount > 0) {
                  notes.push(`Đã rã kèm ${transferCount} phiếu điều chuyển, ${issueCount} phiếu huỷ / xuất khác và ${stocktakeCount} phiếu kiểm kê bán thành phẩm.`);
                }
                const keptPrice = (payload?.keptPriceTransfers || []) as string[];
                if (keptPrice.length > 0) {
                  notes.push(`Phiếu điều chuyển ${keptPrice.join(", ")} giữ giá cũ vì công nợ nội bộ đã gạch hoặc kỳ bên nhận đã khoá.`);
                }
                const reruns = (payload?.reruns || []) as Array<{ oldRunCode: string; newRunCode: string | null }>;
                if (reruns.length > 0) {
                  notes.unshift(`Đã rã lại ${reruns.length} lần rã: ${reruns.map((rerun) => `${rerun.oldRunCode} → ${rerun.newRunCode || "gỡ bỏ (không còn doanh thu)"}`).join(", ")}${payload?.runCode ? `; phần còn chờ rã thành ${payload.runCode}` : ""}. Nếu kỳ này đã bấm Tính giá vốn & giá thành thì bấm lại.`);
                }
                const cogsText = cogsRepostMessage(payload?.cogsRepost);
                if (cogsText) notes.push(cogsText);
                if (notes.length > 0) {
                  setMessage(`Đã rã nguyên liệu và sinh phiếu chế biến + xuất bán. ${notes.join(" ")}`);
                }
              } catch (err) {
                setMessage(err instanceof Error ? `Không thực hiện được thao tác: ${err.message}` : "Không thực hiện được thao tác. Vui lòng thử lại.");
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
            <form onSubmit={(e) => { e.preventDefault(); void send({ action: "PRODUCE_SEMI_FINISHED", ...productionForm, warehouseCode: productionWarehouseCode, toWarehouseCode: productionToWarehouseCode }, "Đã ghi nhận chế biến bán thành phẩm."); }} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 h-fit shadow-sm">
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
                  <select className="control" value={productionWarehouseCode} onChange={(e) => setProductionForm({ ...productionForm, warehouseCode: e.target.value })}>
                    {productionWarehouseOptions.map((warehouse) => <option key={warehouse.code} value={warehouse.code}>{warehouse.name || warehouse.code}</option>)}
                  </select>
                </Input>
                <Input label="Kho nhập BTP">
                  <select className="control" value={productionToWarehouseCode} onChange={(e) => setProductionForm({ ...productionForm, toWarehouseCode: e.target.value })}>
                    {productionWarehouseOptions.map((warehouse) => <option key={warehouse.code} value={warehouse.code}>{warehouse.name || warehouse.code}</option>)}
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
            <Panel title="Giao dịch chế biến" reload={loadData} exportFileName="giao_dich_che_bien" />
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
                      title={`Hoàn kho + xoá mọi phiếu của ${runCode}, trả doanh thu, điều chuyển và kiểm kê bán thành phẩm về trạng thái chờ rã`}
                      onClick={() => { if (window.confirm(`Hoàn tác toàn bộ lần rã ${runCode}?`)) void send({ action: "REVERT_EXPLOSION", runCode }, `Đã hoàn tác lần rã ${runCode}.`).then((payload) => {
                          const cogsText = cogsRepostMessage(payload?.cogsRepost);
                          if (cogsText) setMessage(`Đã hoàn tác lần rã ${runCode}. ${cogsText}`);
                        }); }}
                    >
                      ↩ {runCode}
                    </button>
                  ))}
                </div>
              );
            })()}
            {canEditItem && (() => {
              // Lệnh chế biến cũng là một chùm phiếu PRODUCTION dùng chung mã CB-, hoàn tác y
              // như lần rã: hoàn kho nguyên liệu đã xuất và gỡ bán thành phẩm đã nhập.
              const batchCodes = [...new Set(data.transactions
                .filter((row) => (row.referenceCode || "").startsWith("CB-"))
                .map((row) => row.referenceCode as string))].slice(0, 6);
              if (batchCodes.length === 0) return null;
              return (
                <div className="px-5 pb-3 flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-bold text-slate-600">Hoàn tác lệnh chế biến:</span>
                  {batchCodes.map((referenceCode) => (
                    <button
                      key={referenceCode}
                      type="button"
                      className="status bg-rose-50 text-rose-700 hover:bg-rose-100 cursor-pointer"
                      title={`Hoàn lại nguyên liệu đã xuất và gỡ bán thành phẩm đã nhập của ${referenceCode}`}
                      onClick={() => { if (window.confirm(`Hoàn tác lệnh chế biến ${referenceCode}? Nguyên liệu đã xuất được trả lại kho và bán thành phẩm đã nhập bị gỡ ra.`)) void send({ action: "REVERT_PRODUCTION", referenceCode }, `Đã hoàn tác lệnh chế biến ${referenceCode}. Lập lại với số đúng nếu cần.`); }}
                    >
                      ↩ {referenceCode}
                    </button>
                  ))}
                </div>
              );
            })()}
            {/* Thêm cột Trị giá cùng lúc với dòng CỘNG: bảng không có cột tiền nào thì dòng
                tổng chẳng có gì để cộng. Trị giá = giá trị hàng luân chuyển của phiếu. */}
            <div className="px-5 pb-3 flex flex-wrap items-end gap-3">
              <DateRangeFilter label="Ngày chứng từ" value={flowRange} onChange={setFlowRange} />
              <p className="text-xs text-slate-500">{productionTransactions.length > 300 ? `Có ${productionTransactions.length} phiếu, bảng hiện 300 phiếu mới nhất — dòng CỘNG tính đủ.` : ""}</p>
            </div>
            <Table
              headers={[{ label: "Chứng từ" }, { label: "Loại" }, { label: "Kho" }, { label: "Mặt hàng" }, { label: "Trị giá", align: "right" }]}
              footer={productionTransactions.length === 0 ? null : (
                <tr>
                  <Cell>CỘNG</Cell>
                  <Cell>{productionTransactions.length} phiếu</Cell>
                  <Cell>{""}</Cell>
                  <Cell>{""}</Cell>
                  <Cell right>{money(sumTransactions(productionTransactions.map((row) => ({ transaction: row }))).beforeTax)} đ</Cell>
                </tr>
              )}
            >
              {productionTransactions.slice(0, 300).map((row) => (
                <tr key={row.id} className="border-t border-slate-100">
                  <Cell><CopyableText value={row.code}><b>{row.code}</b></CopyableText><small>{new Date(row.transactionDate).toLocaleDateString("vi-VN")}{row.referenceCode ? ` · ${row.referenceCode}` : ""}</small></Cell>
                  <Cell>{movementTypeLabel(row.transactionType)}</Cell>
                  <Cell>{row.warehouseCode}</Cell>
                  <Cell>{row.lines.map((line) => `${line.item.code}: ${qty(line.quantity)} ${line.item.unit}`).join(", ")}{row.lineSummary && row.lineSummary.count > row.lines.length ? ` … (+${row.lineSummary.count - row.lines.length} dòng)` : ""}</Cell>
                  <Cell right><b>{money(documentTotalCost(row))} đ</b></Cell>
                </tr>
              ))}
            </Table>
          </section>
        </div>
      )}

      {/* Tab Kiểm kê: danh sách MỌI phiếu (lọc nhà hàng / kho / trạng thái / tháng) đứng đầu. */}
      {active === "stocktake" && (
        <StocktakeDocumentsPanel
          sessionKey={SESSION_KEY}
          branchOptions={stocktakeBranchOptions}
          warehouses={data.warehouses}
          storeLabel={storeLabel}
        />
      )}

      {/* Hai màn tách khỏi Kiểm kê (khách yêu cầu 03/10/2026). */}
      {active === "stocktake-explanation" && (
        <StocktakeExplanationPanel
          sessionKey={SESSION_KEY}
          branchOptions={stocktakeBranchOptions}
          warehouses={data.warehouses}
          storeLabel={storeLabel}
          canCreate={canCreate}
          canApprove={canApprove}
        />
      )}
      {active === "stocktake-result" && (
        <StocktakeResultsPanel
          sessionKey={SESSION_KEY}
          branchOptions={stocktakeBranchOptions}
          warehouses={data.warehouses}
          storeLabel={storeLabel}
        />
      )}

      {approvingStocktake && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-md shadow-xl p-5 space-y-4">
            <h3 className="font-bold text-slate-900">Duyệt phiếu kiểm kê {approvingStocktake.stocktake.code}</h3>
            <label className="block text-xs font-bold text-slate-500">
              Giờ chốt kiểm kê
              <input
                type="datetime-local"
                className="control mt-1"
                value={approvingStocktake.cutoff}
                max={approvingStocktake.max}
                onChange={(e) => setApprovingStocktake({ ...approvingStocktake, cutoff: e.target.value })}
              />
            </label>
            <p className="text-xs text-slate-500 leading-relaxed">
              Mặc định là giờ trên phiếu. Đổi giờ chốt thì hệ thống tính lại <b>sổ sách tại giờ đó</b> cho từng dòng (tồn hiện tại − phát sinh sau giờ chốt)
              rồi sinh phiếu nhập/xuất điều chỉnh theo phần chênh, ghi đúng ngày giờ chốt.
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setApprovingStocktake(null)} className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50">Huỷ</button>
              <button type="button" onClick={() => void confirmApproveStocktake()} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-700">Duyệt</button>
            </div>
          </div>
        </div>
      )}

      {active === "stocktake" && (
        <div className="flex flex-wrap items-center gap-2 mb-4">
          {([["location", "Theo vị trí · nguyên liệu, bao bì"], ["warehouse", "Cả kho (cách cũ, bán thành phẩm)"]] as const).map(([mode, label]) => (
            <button key={mode} type="button" onClick={() => setStocktakeMode(mode)}
              className={`px-3 py-1.5 rounded-md text-sm font-bold border ${stocktakeMode === mode ? "bg-slate-800 text-white border-slate-800" : "bg-white text-slate-600 border-slate-200"}`}>
              {label}
            </button>
          ))}
        </div>
      )}

      {active === "stocktake" && stocktakeMode === "location" && (
        <StocktakeByLocation
          sessionKey={SESSION_KEY}
          items={data.items}
          warehouses={data.warehouses}
          balances={data.balances}
          branchOptions={visibleStoreOptions(user).map((option) => ({ code: option.code, label: storeLabel(option.code) }))}
          defaultBranch={stocktakeForm.branchCode}
          canCreate={canCreate}
          canEdit={canEditItem}
          canApprove={canApprove}
          canDelete={user ? canPerformMenuAction(user, href, "delete") : false}
          onStockChanged={() => void loadData()}
        />
      )}

      {active === "stocktake" && stocktakeMode === "warehouse" && (
        <div className="space-y-5">
          {canCreate && (
            <form onSubmit={async (e) => {
              e.preventDefault();
              const payload = await send({
                action: "SAVE_STOCKTAKE",
                stocktakeId: editingStocktake?.id,
                ...stocktakeForm,
                warehouseCode: stocktakeWarehouseCode,
                lines: stocktakeRows.map((row) => ({ itemId: row.itemId, actualQuantity: row.actualQuantity, systemQuantity: row.systemQuantity, unitCost: row.unitCost, reason: row.reason || stocktakeForm.reason })),
              }, editingStocktake ? `Đã lưu và gửi lại phiếu ${editingStocktake.code} — chờ kế toán duyệt.` : "Đã gửi phiếu kiểm kê — chờ kế toán duyệt. Tồn kho chỉ điều chỉnh khi kế toán duyệt.");
              if (payload) setEditingStocktake(null);
            }} className="bg-white border border-slate-200 rounded-lg p-4 sm:p-5 space-y-4 h-fit shadow-sm">
              <h2 className="font-bold text-slate-800">{editingStocktake ? `Sửa phiếu kiểm kê ${editingStocktake.code}` : "Kiểm kê kho"}</h2>
              {editingStocktake && (
                <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 flex flex-wrap items-start justify-between gap-2">
                  <div className="space-y-1">
                    <p>Đang sửa phiếu <b>{editingStocktake.code}</b> — bấm <b>Lưu &amp; gửi lại</b> để kế toán duyệt.</p>
                    {editingStocktake.returnedReason && <p className="text-rose-700"><b>Kế toán trả lại:</b> {editingStocktake.returnedReason}</p>}
                  </div>
                  <button type="button" className="font-bold text-slate-500 hover:underline" onClick={cancelStocktakeEdit}>Huỷ sửa</button>
                </div>
              )}
              <p className="rounded-md bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
                Đếm xong bấm <b>Gửi duyệt</b>: phiếu ở trạng thái Chờ duyệt, tồn kho CHƯA đổi và vẫn sửa / bổ sung được. Kế toán duyệt
                mới điều chỉnh tồn kho. CCDC và Tài sản được kiểm kê tại Tài sản &amp; khấu hao.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <Input label="Cửa hàng">
                  <select className="control" value={stocktakeForm.branchCode} onChange={(e) => setStocktakeForm({ ...stocktakeForm, branchCode: e.target.value, warehouseCode: "" })}>
                    {visibleStoreOptions(user).map((option) => <option key={option.code} value={option.code}>{storeLabel(option.code)}</option>)}
                  </select>
                </Input>
                <Input label="Kho">
                  <select className="control" value={stocktakeWarehouseCode} disabled={stocktakeWarehouseOptions.length === 0} onChange={(e) => { const warehouseCode = e.target.value; setStocktakeForm({ ...stocktakeForm, warehouseCode }); setStocktakeRows(buildStocktakeRows(warehouseCode, data.balances, data.items)); }}>
                    {stocktakeWarehouseOptions.length === 0 && <option value="">Chưa có kho</option>}
                    {stocktakeWarehouseOptions.map((warehouse) => <option key={warehouse.code} value={warehouse.code}>{warehouse.name || warehouse.code}</option>)}
                  </select>
                </Input>
                {stocktakeWarehouseOptions.length === 0 && (
                  <p className="col-span-2 rounded-md bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">
                    {storeLabel(stocktakeForm.branchCode)} chưa có kho nào bạn được phép kiểm kê. Khai kho cho cửa hàng ở Danh mục (loại Kho), hoặc nhờ quản trị gán kho cho tài khoản ở Phân quyền.
                  </p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Input label="Ngày kiểm kê">
                  <input type="date" className="control" value={stocktakeForm.stocktakeDate} onChange={(e) => setStocktakeForm({ ...stocktakeForm, stocktakeDate: e.target.value })} />
                </Input>
                <Input label="Lý do">
                  <input className="control" value={stocktakeForm.reason} onChange={(e) => setStocktakeForm({ ...stocktakeForm, reason: e.target.value })} />
                </Input>
              </div>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <input
                  type="search"
                  className="control !mt-0 flex-1 min-w-[200px]"
                  placeholder="Tìm nhanh mặt hàng đang kiểm..."
                  value={stocktakeSearch}
                  onChange={(e) => setStocktakeSearch(e.target.value)}
                />
                <button type="button" className="secondary-button" onClick={() => { setStocktakeRows(buildStocktakeRows(stocktakeForm.warehouseCode, data.balances, data.items)); setStocktakeSearch(""); }}>
                  <span className="material-symbols-outlined text-lg">refresh</span>Nạp danh sách kho
                </button>
              </div>
              {(() => {
                const keyword = stocktakeSearch.trim().toLowerCase();
                const visibleRows = stocktakeRows.filter((row) =>
                  !keyword || row.itemCode.toLowerCase().includes(keyword) || row.itemName.toLowerCase().includes(keyword));
                const varianceCount = stocktakeRows.filter((row) => Number(row.actualQuantity || 0) !== row.systemQuantity).length;
                const patchRow = (itemId: string, patch: Partial<StocktakeDraftRow>) =>
                  setStocktakeRows((rows) => rows.map((candidate) => candidate.itemId === itemId ? { ...candidate, ...patch } : candidate));
                return (
                  <>
                    <p className="text-xs text-slate-500">
                      {visibleRows.length}/{stocktakeRows.length} mặt hàng · <b className={varianceCount > 0 ? "text-amber-700" : "text-emerald-700"}>{varianceCount} dòng lệch tồn</b>
                    </p>

                    {/* Mobile: thẻ từng mặt hàng — nhập tồn thực tế bằng bàn phím số */}
                    <div className="md:hidden space-y-2">
                      {visibleRows.map((row) => {
                        const actualQuantity = Number(row.actualQuantity || 0);
                        const variance = actualQuantity - row.systemQuantity;
                        return (
                          <div key={row.itemId} className={`rounded-xl border p-3 space-y-2 ${variance !== 0 ? "border-amber-300 bg-amber-50/50" : "border-slate-200 bg-white"}`}>
                            <div className="flex items-center justify-between gap-2">
                              <div className="min-w-0">
                                <p className="font-bold text-sm truncate">{row.itemName}</p>
                                <p className="text-xs text-slate-500">{row.itemCode} · Tồn hệ thống: <b>{qty(row.systemQuantity)} {row.unit}</b></p>
                              </div>
                              <div className="flex items-center gap-1.5 shrink-0">
                                <input
                                  type="number"
                                  min="0"
                                  step="0.001"
                                  inputMode="decimal"
                                  className="control !mt-0 w-24 text-right text-base"
                                  value={row.actualQuantity}
                                  onChange={(e) => patchRow(row.itemId, { actualQuantity: e.target.value })}
                                  aria-label={`Tồn thực tế ${row.itemName}`}
                                />
                                <span className="text-xs text-slate-500 w-8 truncate">{row.unit}</span>
                              </div>
                            </div>
                            <div className="flex items-center gap-2 text-xs">
                              <span className={variance === 0 ? "text-slate-500" : variance > 0 ? "text-emerald-700 font-bold" : "text-rose-700 font-bold"}>
                                Lệch: {qty(variance)}
                              </span>
                              {row.averageCost <= 0 && (
                                <input
                                  type="number"
                                  min="0"
                                  inputMode="numeric"
                                  className="control !mt-0 w-24 text-right"
                                  placeholder="Giá vốn"
                                  title="Hàng chưa có giá vốn — bắt buộc khai khi đếm THỪA"
                                  value={row.unitCost}
                                  onChange={(e) => patchRow(row.itemId, { unitCost: e.target.value })}
                                />
                              )}
                              <input
                                className="control !mt-0 flex-1"
                                value={row.reason}
                                placeholder="Lý do (nếu lệch)"
                                onChange={(e) => patchRow(row.itemId, { reason: e.target.value })}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Desktop: bảng như cũ */}
                    <div className="hidden md:block border border-slate-200 rounded-lg overflow-hidden">
                      <Table headers={[{ label: "Mặt hàng" }, { label: "Tồn hệ thống", align: "right" }, { label: "Tồn thực tế", align: "right" }, { label: "Chênh lệch", align: "right" }, { label: "Đơn giá", align: "right" }, { label: "Lý do" }]}>
                        {visibleRows.map((row) => {
                          const actualQuantity = Number(row.actualQuantity || 0);
                          const variance = actualQuantity - row.systemQuantity;
                          return (
                            <tr key={row.itemId} className="border-t border-slate-100">
                              <Cell><b>{row.itemCode}</b><small>{row.itemName} · {row.unit}</small></Cell>
                              <Cell right>{qty(row.systemQuantity)}</Cell>
                              <Cell right>
                                <input
                                  type="number"
                                  min="0"
                                  step="0.001"
                                  inputMode="decimal"
                                  className="control text-right w-28 inline-block"
                                  value={row.actualQuantity}
                                  onChange={(e) => patchRow(row.itemId, { actualQuantity: e.target.value })}
                                />
                              </Cell>
                              <Cell right><span className={variance === 0 ? "text-slate-500" : variance > 0 ? "text-emerald-700 font-bold" : "text-rose-700 font-bold"}>{qty(variance)}</span></Cell>
                              <Cell right>
                                {row.averageCost > 0 ? (
                                  <span className="text-slate-500">{unitPrice(row.averageCost)}</span>
                                ) : (
                                  <input
                                    type="number"
                                    min="0"
                                    inputMode="numeric"
                                    className="control text-right w-24 inline-block"
                                    placeholder="Giá vốn"
                                    title="Hàng chưa có giá vốn — bắt buộc khai khi đếm THỪA"
                                    value={row.unitCost}
                                    onChange={(e) => patchRow(row.itemId, { unitCost: e.target.value })}
                                  />
                                )}
                              </Cell>
                              <Cell>
                                <input
                                  className="control"
                                  value={row.reason}
                                  placeholder={stocktakeForm.reason}
                                  onChange={(e) => patchRow(row.itemId, { reason: e.target.value })}
                                />
                              </Cell>
                            </tr>
                          );
                        })}
                      </Table>
                    </div>
                  </>
                );
              })()}
              {/* Nút duyệt dính đáy màn hình khi danh sách dài — chừa chỗ nút menu nổi bên trái */}
              <div className="sticky bottom-0 z-20 -mx-4 sm:-mx-5 -mb-4 sm:-mb-5 border-t border-slate-200 bg-white/95 backdrop-blur px-4 py-3 rounded-b-lg pl-20 lg:pl-4">
                <button className="primary-button w-full !min-h-12">{editingStocktake ? "Lưu & gửi lại" : "Gửi duyệt"}</button>
              </div>
            </form>
          )}
          <section className="table-panel shadow-sm">
            <Panel title="Phiếu kiểm kê gần nhất" reload={loadData} exportFileName="phieu_kiem_ke" />
            {/* Điện thoại: mỗi phiếu một thẻ, nút Sửa / Duyệt / Trả lại luôn nằm trong màn hình;
                pb-20 chừa chỗ nút menu nổi góc trái dưới. */}
            <div className="md:hidden divide-y divide-slate-100 pb-20">
              {data.stocktakes.filter((row) => !row.locationCode).map((row) => ({
                ...row,
                lines: row.lines.filter((line) => isWarehouseStocktakeItemType(line.item.itemType)),
              })).filter((row) => row.lines.length > 0).map((row) => {
                const varianceLines = row.lines.filter((line) => Math.abs(line.varianceQuantity) > 0.000001);
                return (
                  <div key={row.id} className="px-4 py-3 space-y-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <CopyableText value={row.code}><b>{row.code}</b></CopyableText>
                        <p className="text-xs text-slate-500">
                          {new Date(row.stocktakeDate).toLocaleDateString("vi-VN")} · {data.warehouses.find((warehouse) => warehouse.code === row.warehouseCode)?.name || row.warehouseCode}
                          {row.createdBy ? ` · ${row.createdBy}` : ""}
                        </p>
                      </div>
                      <span className={`status shrink-0 ${stocktakeStatusTone(row.status)}`}>{stocktakeStatusLabel(row.status)}</span>
                    </div>
                    <p className="text-xs text-slate-600">
                      {row.lines.length} mặt hàng · <b className={varianceLines.length > 0 ? "text-amber-700" : "text-slate-400"}>{varianceLines.length} dòng lệch</b>
                      {varianceLines.length > 0 && `: ${varianceLines.slice(0, 4).map((line) => `${line.item.name} ${line.varianceQuantity > 0 ? "+" : ""}${qty(line.varianceQuantity)}`).join(", ")}${varianceLines.length > 4 ? "…" : ""}`}
                    </p>
                    {row.status === STOCKTAKE_RETURNED && row.returnedReason && <p className="text-xs text-rose-700">Lý do trả lại: {row.returnedReason}</p>}
                    <ExplosionBadge status={row.explosionStatus} />
                    <div className="flex flex-wrap gap-x-4 gap-y-1 pt-0.5">{renderStocktakeActions(row)}</div>
                  </div>
                );
              })}
            </div>
            <div className="hidden md:block">
            <Table headers={[{ label: "Phiếu" }, { label: "Kho" }, { label: "Mặt hàng" }, { label: "Chênh lệch", align: "right" }, { label: "", align: "right" }]}>
              {data.stocktakes.filter((row) => !row.locationCode).map((row) => ({
                ...row,
                lines: row.lines.filter((line) => isWarehouseStocktakeItemType(line.item.itemType)),
              })).filter((row) => row.lines.length > 0).map((row) => (
                <tr key={row.id} className="border-t border-slate-100">
                  <Cell>
                    <CopyableText value={row.code}><b>{row.code}</b></CopyableText>
                    <small>{new Date(row.stocktakeDate).toLocaleDateString("vi-VN")}{row.createdBy ? ` · ${row.createdBy}` : ""}</small>
                    <span className={`status mt-1 ${stocktakeStatusTone(row.status)}`}>{stocktakeStatusLabel(row.status)}{row.status === STOCKTAKE_APPROVED && row.approvedBy ? ` · ${row.approvedBy}` : ""}</span>
                    {row.status === STOCKTAKE_RETURNED && row.returnedReason && <small className="text-rose-700">Lý do trả lại: {row.returnedReason}</small>}
                    <ExplosionBadge status={row.explosionStatus} />
                  </Cell>
                  <Cell>{row.warehouseCode}</Cell>
                  <Cell>{row.lines.map((line) => line.item.code).join(", ")}</Cell>
                  <Cell right>{qty(row.lines.reduce((sum, line) => sum + line.varianceQuantity, 0))}</Cell>
                  <Cell right>
                    <div className="flex flex-wrap justify-end gap-x-3 gap-y-1">
                      {renderStocktakeActions(row)}
                    </div>
                  </Cell>
                </tr>
              ))}
            </Table>
            </div>
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

              <Input label="Ngày chứng từ">
                <input type="date" className="control" value={wasteForm.transactionDate} onChange={(e) => setWasteForm({ ...wasteForm, transactionDate: e.target.value })} required />
              </Input>

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
              <Panel
                title={`Mã hàng hủy nhiều nhất (theo trị giá)${wasteReportFilter.from || wasteReportFilter.to ? ` — ${wasteReportFilter.from ? wasteReportFilter.from.split("-").reverse().join("/") : "…"} → ${wasteReportFilter.to ? wasteReportFilter.to.split("-").reverse().join("/") : "…"}` : ""}`}
                reload={loadData}
                exportFileName={`hang_huy_nhieu_nhat${wasteReportFilter.from ? `_${wasteReportFilter.from}` : ""}`}
              />
              <div className="px-5 pb-4 grid grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6 gap-3">
                <DateRangeFilter label="Ngày hủy" value={{ from: wasteReportFilter.from, to: wasteReportFilter.to }} onChange={(range) => setWasteReportFilter({ ...wasteReportFilter, ...range })} className="col-span-2 2xl:col-span-6" />
                <Input label="Loại hủy">
                  <select className="control" value={wasteReportFilter.subType} onChange={(e) => setWasteReportFilter({ ...wasteReportFilter, subType: e.target.value })}>
                    <option value="ALL">Tất cả loại hủy</option>
                    <option value="HET_HAN_SU_DUNG">Hết hạn sử dụng</option>
                    <option value="KHONG_DAM_BAO_CHAT_LUONG">Không đảm bảo chất lượng</option>
                    <option value="KHONG_PHAN_LOAI">Chưa phân loại</option>
                  </select>
                </Input>
                <Input label="Nhà hàng">
                  <select className="control" value={wasteReportFilter.branch} onChange={(e) => setWasteReportFilter({ ...wasteReportFilter, branch: e.target.value })}>
                    <option value="ALL">Tất cả nhà hàng</option>
                    {visibleStoreOptions(user).map((option) => <option key={option.code} value={option.code}>{storeLabel(option.code)}</option>)}
                  </select>
                </Input>
                <Input label="Loại hàng">
                  <select className="control" value={wasteReportFilter.itemType} onChange={(e) => setWasteReportFilter({ ...wasteReportFilter, itemType: e.target.value })}>
                    <option value="ALL">Tất cả loại</option>
                    {WAREHOUSE_ITEM_TYPES.map((type) => <option key={type} value={type}>{inventoryItemTypeLabel(type)}</option>)}
                  </select>
                </Input>
                <Input label="Nhóm hàng hóa">
                  <select className="control" value={wasteReportFilter.goodsGroup} onChange={(e) => setWasteReportFilter({ ...wasteReportFilter, goodsGroup: e.target.value })}>
                    <option value="ALL">Tất cả nhóm</option>
                    <option value="MISSING">Chưa có nhóm</option>
                    {wasteGoodsGroups.map(([key, name]) => <option key={key} value={key}>{name}</option>)}
                  </select>
                </Input>
                <Input label="Tìm mã / tên">
                  <input className="control" placeholder="Mã hoặc tên hàng..." value={wasteReportFilter.search} onChange={(e) => setWasteReportFilter({ ...wasteReportFilter, search: e.target.value })} />
                </Input>
              </div>
              {wasteReportRows === null && <p className="px-5 pb-3 text-xs text-slate-500">Đang tải...</p>}
              <Table
                headers={[
                  { label: "Mặt hàng" },
                  { label: "Loại" },
                  { label: "Nhóm hàng hóa" },
                  { label: "SL hủy", align: "right" },
                  { label: "Hết hạn sử dụng", align: "right" },
                  { label: "Không đảm bảo chất lượng", align: "right" },
                  { label: "Chưa phân loại", align: "right" },
                  { label: "Số phiếu", align: "right" },
                  { label: "Trị giá hủy", align: "right" },
                ]}
                footer={filteredWasteReport.length === 0 ? null : (
                  <tr>
                    <Cell>CỘNG</Cell>
                    <Cell>{filteredWasteReport.length} mặt hàng</Cell>
                    {/* SL hủy mỗi mặt hàng một ĐVT nên không cộng được — để trống còn hơn ra
                        một con số vô nghĩa. */}
                    <Cell>{""}</Cell>
                    <Cell right>{""}</Cell>
                    <Cell right>{""}</Cell>
                    <Cell right>{""}</Cell>
                    <Cell right>{""}</Cell>
                    <Cell right>{""}</Cell>
                    <Cell right><b className="text-rose-600">{money(sumRoundedByRow(filteredWasteReport, (row) => row.totalValue))} đ</b></Cell>
                  </tr>
                )}
              >
                {wasteReportRows !== null && filteredWasteReport.length === 0 && (
                  <tr><td colSpan={9} className="cell text-center text-slate-400">Không có hàng hủy khớp bộ lọc.</td></tr>
                )}
                {filteredWasteReport.map((row) => {
                  const bySubType = (code: string) => (row.bySubType[code] ? `${qty(row.bySubType[code].quantity)} ${row.unit}` : "-");
                  return (
                    <tr key={row.itemCode} className="border-t border-slate-100">
                      <Cell><b><CopyableText value={row.itemCode} /></b><small>{row.itemName}</small></Cell>
                      <Cell>{row.itemType}</Cell>
                      <Cell>{goodsGroupByItemCode.get(row.itemCode) || <span className="text-slate-400">-</span>}</Cell>
                      <Cell right><b>{qty(row.totalQuantity)}</b> {row.unit}</Cell>
                      <Cell right>{bySubType("HET_HAN_SU_DUNG")}</Cell>
                      <Cell right>{bySubType("KHONG_DAM_BAO_CHAT_LUONG")}</Cell>
                      <Cell right>{bySubType("KHONG_PHAN_LOAI")}</Cell>
                      <Cell right>{row.documentCount}</Cell>
                      <Cell right><b className="text-rose-600">{money(row.totalValue)} đ</b></Cell>
                    </tr>
                  );
                })}
              </Table>
            </section>

            <section className="table-panel shadow-sm">
              <Panel title="Phiếu hủy" reload={loadData} exportFileName="phieu_huy" />
              <div className="px-5 pb-4 grid grid-cols-2 xl:grid-cols-3 gap-3">
                <Input label="Từ ngày chứng từ">
                  <input type="date" className="control" value={flowRange.from} onChange={(e) => setFlowRange({ ...flowRange, from: e.target.value })} />
                </Input>
                <Input label="Đến ngày chứng từ">
                  <input type="date" className="control" value={flowRange.to} onChange={(e) => setFlowRange({ ...flowRange, to: e.target.value })} />
                </Input>
                <Input label="Cửa hàng">
                  <select className="control" value={wasteStore} onChange={(e) => setWasteStore(e.target.value)}>
                    <option value="ALL">Tất cả cửa hàng</option>
                    {visibleStoreOptions(user).map((option) => <option key={option.code} value={option.code}>{storeLabel(option.code)}</option>)}
                  </select>
                </Input>
                <Input label="Loại hủy">
                  <select className="control" value={wasteSubTypeFilter} onChange={(e) => setWasteSubTypeFilter(e.target.value)}>
                    <option value="ALL">Tất cả loại hủy</option>
                    <option value="HET_HAN_SU_DUNG">Hết hạn sử dụng</option>
                    <option value="KHONG_DAM_BAO_CHAT_LUONG">Không đảm bảo chất lượng</option>
                    <option value="NONE">Chưa phân loại</option>
                  </select>
                </Input>
              </div>
              {canEditWaste && selectedVisibleWasteIds.length > 0 && (
                <div className="mx-5 mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm">
                  <b className="text-blue-800">Đã chọn {selectedVisibleWasteIds.length} phiếu</b>
                  <span className="text-blue-800">— cập nhật loại hủy thành</span>
                  <select className="control !w-auto !mt-0" value={bulkWasteSubType} onChange={(e) => setBulkWasteSubType(e.target.value)}>
                    <option value="HET_HAN_SU_DUNG">Hết hạn sử dụng</option>
                    <option value="KHONG_DAM_BAO_CHAT_LUONG">Không đảm bảo chất lượng</option>
                    <option value="">Chưa phân loại</option>
                  </select>
                  <button type="button" className="primary-button !min-h-9" onClick={() => void bulkSetWasteSubType()}>Cập nhật</button>
                  <button type="button" className="text-xs font-bold text-slate-600 hover:underline" onClick={() => setSelectedWasteIds([])}>Bỏ chọn</button>
                </div>
              )}
              <Table
                headers={[
                  ...(canEditWaste ? [{
                    label: (
                      <input
                        type="checkbox"
                        aria-label="Chọn tất cả phiếu đang hiện"
                        checked={allWasteSelected}
                        onChange={() => setSelectedWasteIds(allWasteSelected ? [] : wasteTransactions.map((row) => row.id))}
                      />
                    ),
                  }] : []),
                  { label: "Chứng từ" }, { label: "Loại hủy" }, { label: "Nhà hàng / Kho" }, { label: "Mặt hàng" }, { label: "Trị giá", align: "right" }, { label: "Thao tác", align: "right" }]}
                footer={wasteTransactions.length === 0 ? null : (
                  <tr>
                    {canEditWaste && <Cell>{""}</Cell>}
                    <Cell>CỘNG</Cell>
                    <Cell>{wasteTransactions.length} phiếu</Cell>
                    <Cell>{""}</Cell>
                    <Cell>{""}</Cell>
                    <Cell right><b className="text-rose-600">{money(sumTransactions(wasteTransactions.map((row) => ({ transaction: row }))).beforeTax)} đ</b></Cell>
                    <Cell right>{""}</Cell>
                  </tr>
                )}
              >
                {wasteTransactions.map((row) => (
                  <tr key={row.id} className={`border-t border-slate-100 ${selectedWasteIds.includes(row.id) ? "bg-blue-50/60" : ""}`}>
                    {canEditWaste && (
                      <Cell>
                        <input type="checkbox" aria-label={`Chọn ${row.code}`} checked={selectedWasteIds.includes(row.id)} onChange={() => toggleWasteSelection(row.id)} />
                      </Cell>
                    )}
                    <Cell><CopyableText value={row.code}><b>{row.code}</b></CopyableText><small>{new Date(row.transactionDate).toLocaleDateString("vi-VN")}</small></Cell>
                    <Cell><span className={`status ${row.subType ? "bg-rose-50 text-rose-700" : "bg-slate-100 text-slate-600"}`}>{wasteSubTypeLabel(row.subType)}</span></Cell>
                    <Cell>{storeLabel(row.branchCode)}<small>{row.warehouseCode}</small></Cell>
                    <Cell>{row.lines.map((line) => `${line.item.name}: ${qty(line.quantity)} ${line.item.unit}`).join(", ")}</Cell>
                    <Cell right><b>{money(row.lines.reduce((sum, line) => sum + line.totalCost, 0))} đ</b></Cell>
                    <Cell right>
                      <RowActions
                        session={user}
                        module={href}
                        compact
                        onEdit={() => openTransactionEdit(row)}
                        onDelete={() => { setTransactionDeleteError(null); setDeletingTransaction(row); }}
                        editDisabledReason={transactionEditLockReason(row)}
                        deleteDisabledReason={transactionLockReason(row)}
                      />
                    </Cell>
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

/** Đơn giá hiển thị: giữ 2 số lẻ (giá theo ĐVT tồn nhân hệ số quy đổi ra số lẻ dài). */
function roundUnitCost(value: number): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/** Bỏ dấu + chữ thường để ô tìm gõ "tra dao" vẫn ra "Trà Đào". */
function foldSearchText(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
}

function wasteSubTypeLabel(subType: string | null): string {
  if (subType === "HET_HAN_SU_DUNG") return "Hết hạn sử dụng";
  if (subType === "KHONG_DAM_BAO_CHAT_LUONG") return "Không đảm bảo chất lượng";
  return "Chưa phân loại";
}

/**
 * `min-w-0` là bắt buộc: ô này hay nằm trong lưới cột cố định, mà <input> có bề rộng nội tại
 * ~20 ký tự — không cho co lại thì ô tự phình quá cột và cả hàng tràn ra ngoài hộp thoại.
 */
/** Trạng thái rã BOM của phiếu điều chuyển / kiểm kê có bán thành phẩm (khách chốt 28/09/2026). */
function ExplosionBadge({ status }: { status?: string | null }) {
  if (!status) return null;
  if (status === "PENDING") {
    return <span className="status mt-1 bg-amber-100 text-amber-800" title="Bán thành phẩm của phiếu này chờ bấm Rã ở tab Chế biến">Chờ rã BTP</span>;
  }
  const runCode = status.startsWith("POSTED:") ? status.slice("POSTED:".length) : status;
  return <span className="status mt-1 bg-emerald-100 text-emerald-800" title="Đã rã nguyên liệu cho bán thành phẩm của phiếu này">Đã rã {runCode}</span>;
}

function Input({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block min-w-0 text-xs font-bold text-slate-600">{label}{children}</label>; }
/**
 * Ô chọn mặt hàng dùng chung cho mọi form của màn Kho.
 *
 * Danh mục thật có hàng nghìn mã nên thẻ <select> trơn là không dùng được: phải cuộn tay tìm
 * từng mã. SearchableSelect cho gõ mã/tên để lọc, cùng một ô chọn với màn Thu/Chi.
 */
/**
 * Các ĐVT MUA của mặt hàng, tức mọi dòng quy đổi khác ĐVT tồn kho. Dòng ĐVT tồn kho (tỷ lệ 1,
 * note "ĐVT cơ bản") luôn tồn tại nên không kể vào đây.
 */
function purchaseConversions(item: { unit: string; unitConversions?: UnitConversion[] }) {
  const baseUnit = (item.unit || "").trim().toUpperCase();
  return (item.unitConversions || []).filter((unit) => unit.unitCode.trim().toUpperCase() !== baseUnit);
}

/** Chuỗi hiển thị ĐVT mua trên bảng danh mục: "1 THUNG = 24 chai". */
function purchaseConversionLabel(item: { unit: string; unitConversions?: UnitConversion[] }) {
  return purchaseConversions(item)
    .map((unit) => `1 ${unit.unitName || unit.unitCode} = ${qty(safeConversionRate(item.unit, unit))} ${item.unit}`)
    .join(", ");
}

/**
 * `nameOnly`: ô đã chọn chỉ hiện TÊN mặt hàng (ô hẹp trong hộp thoại sửa phiếu, hiện "mã - tên"
 * thì mã chiếm hết chỗ, tên bị cắt). Danh sách xổ xuống đưa mã xuống dòng phụ, vẫn gõ mã để tìm được.
 */
function ItemSelect({ items, value, onChange, nameOnly = false }: { items: Item[]; value: string; onChange: (value: string) => void; nameOnly?: boolean }) {
  return (
    <SearchableSelect
      value={value}
      onChange={onChange}
      placeholder="Chọn mặt hàng"
      searchPlaceholder="Gõ mã hoặc tên mặt hàng..."
      options={items.map((item) => (nameOnly
        ? { value: item.id, label: item.name, subLabel: `${item.code} · ${item.unit}`, selectedLabel: item.name }
        : { value: item.id, label: `${item.code} - ${item.name}`, subLabel: item.unit }))}
    />
  );
}
function Panel({ title, reload, exportFileName }: { title: string; reload: () => void; exportFileName?: string }) {
  return (
    <div className="p-5 flex justify-between items-center gap-3">
      <h2 className="font-bold text-slate-800">{title}</h2>
      <div className="flex items-center gap-2">
        {exportFileName && <ExportExcelButton fileName={exportFileName} sheetName={title.slice(0, 31)} />}
        <button type="button" title="Tải lại" onClick={reload} className="icon-button"><span className="material-symbols-outlined text-lg">refresh</span></button>
      </div>
    </div>
  );
}

function Table({
  headers,
  children,
  footer,
  tableClassName = "",
}: {
  headers: { label: React.ReactNode; align?: "left" | "right" }[];
  children: React.ReactNode;
  /** Dòng CỘNG cuối bảng (khách yêu cầu 21/09/2026) — truyền các `<Cell>` đúng số cột. */
  footer?: React.ReactNode;
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
                className={`px-4 py-3 font-bold whitespace-nowrap ${header.align === "right" ? "text-right" : "text-left"}`}
              >
                {header.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
        {/* Ghim đáy như dòng subtotal của Excel: bảng cuộn trong khung 580px nên để dòng tổng
            chạy theo nội dung thì phải cuộn tới cuối mới thấy, đúng cái khách muốn tránh. */}
        {footer && (
          <tfoot className="sticky bottom-0 z-10 border-t-2 border-slate-300 bg-slate-50 font-bold text-slate-800 shadow-[0_-1px_2px_rgba(0,0,0,0.05)]">
            {footer}
          </tfoot>
        )}
      </table>
    </div>
  );
}

// Cột canh phải là cột số: tabular-nums cho chữ số thẳng hàng, nowrap để không bẻ đôi giữa số.
// Bảng đã có khung cuộn ngang sẵn nên số dài chỉ làm bảng cuộn, không bị bóp.
function Cell({ children, right = false }: { children: React.ReactNode; right?: boolean }) { return <td className={`cell ${right ? "text-right tabular-nums whitespace-nowrap" : ""}`}>{children}</td>; }
