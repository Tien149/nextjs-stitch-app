"use client";

import { useEffect, useMemo, useState } from "react";
import ExportExcelButton from "@/components/ExportExcelButton";
import { ModuleFrame, ModuleTabs } from "@/components/ModuleFrame";
import { DateInput } from "@/components/DateInput";
import { MoneyInput } from "@/components/MoneyInput";
import { emptyReceiveTerms, poPriceHint, PurchaseReceiveLines, receiveFigures, receiveLineErrors, type ReceiveLineInfo, type ReceiveLineValue } from "@/components/PurchaseReceiveLines";
import { QuantityInput } from "@/components/QuantityInput";
import { ConfirmDeleteDialog, RowActions } from "@/components/RowActions";
import { PartnerPicker, type CreatedPartner } from "@/components/PartnerPicker";
import { SearchableSelect } from "@/components/SearchableSelect";
import { storeLabel, visibleStoreOptions } from "@/lib/branch-labels";
import { canPerformMenuAction, filterModuleTabs } from "@/lib/auth-demo";
import { useModuleAuth } from "@/lib/use-module-auth";
import { allowedDepartmentsOf } from "@/lib/department-scope";
import CopyableText from "@/components/CopyableText";
import StickyFilterBar from "@/components/StickyFilterBar";
import { assetGroupCandidates, assetGroupTypeLabel } from "@/lib/asset-group-rules";
import { money, quantity as qty, unitPrice } from "@/lib/format-number";
import { VAT_RATE_OPTIONS, vatAmountOf, vatRateLabel } from "@/lib/inventory-vat";
import { TemplatesTab, type PurchaseTemplate, type TemplateUnitConversion } from "./templates-tab";
import { PriceListsTab } from "./price-lists-tab";
import { DateRangeFilter } from "@/components/DateRangeFilter";
import { vnToday, vnTomorrow, type DateRange } from "@/lib/date-range";
import { SendPurchaseOrderDialog } from "./send-po-dialog";
import { ApproveRequestDialog } from "./approve-request-dialog";
import { conversionRateForUnit, defaultPurchaseUnit, purchaseLineUnit, purchaseUnitOptions, toPurchasePrice, toPurchaseQuantity } from "@/lib/unit-conversion";

import { ActionIcon } from "@/components/ActionIcon";
type Item = { id: string; code: string; name: string; unit: string; itemType: string; category: string | null; requiresImage: boolean; unitConversions?: TemplateUnitConversion[] };
type MasterItem = { id: string; type: string; code: string; name: string; group: string | null; subGroup: string | null; branch: string | null; status: string };
type Supplier = { id: string; code: string; name: string; phone?: string | null; email?: string | null };
type PriceSuggestion = { price: number; source: string; supplierName?: string };
/** unitCode / conversionRate: ĐVT đặt hàng (số lượng, đơn giá trong DB theo ĐVT tồn) — lib/unit-conversion. */
type UnitFields = { unitCode?: string | null; conversionRate?: number | null };
type RequestLine = UnitFields & { id: string; itemId: string; quantity: number; estimatedUnitCost: number; imageUrl: string | null; note?: string | null; supplierCode?: string | null; supplierName?: string | null; item: Item };
type QuoteLine = UnitFields & { itemId: string; quantity: number; unitCost: number; vatRate?: number | null; item?: Item };
type Quote = { id: string; supplierCode: string; supplierName: string; totalAmount: number; deliveryDays: number | null; paymentTerms: string | null; isSelected: boolean; note: string | null; lines: QuoteLine[] };
type PurchaseRequest = { id: string; code: string; requestDate: string; branchCode: string; departmentCode: string | null; warehouseCode?: string | null; supplierCode?: string | null; supplierName?: string | null; rejectReason?: string | null; requestedBy: string; neededDate: string | null; reason: string; status: string; approvedAt: string | null; note: string | null; lines: RequestLine[]; quotes: Quote[]; orders?: Array<{ id: string; code: string; status: string }> };
type OrderLine = UnitFields & { id: string; itemId: string; orderedQuantity: number; receivedQuantity: number; unitCost: number; imageUrl: string | null; item: Item };
type PurchaseOrder = { id: string; code: string; requestId: string | null; orderDate: string; supplierCode: string; supplierName: string; branchCode: string; departmentCode: string | null; warehouseCode: string; expectedDate: string | null; status: string; approvedAt: string | null; note: string | null; totalAmount: number; shareToken: string | null; lines: OrderLine[]; payable: { outstandingAmount: number } | null };
type Data = { items: Item[]; requests: PurchaseRequest[]; orders: PurchaseOrder[]; departments: MasterItem[]; itemGroups: MasterItem[]; warehouses: MasterItem[]; assetGroups: MasterItem[]; templates: PurchaseTemplate[]; suppliers: Supplier[]; priceSuggestions: Record<string, PriceSuggestion> };
/** Chứng từ mua hàng đang chờ xác nhận xoá. */
type DeleteTarget = { type: "REQUEST" | "ORDER" | "QUOTE"; id: string; title: string; description: string; label: string };
/** Một dòng hàng trên form PR nhiều dòng. */
/** supplierCode: NCC riêng của dòng (từ dòng mẫu, khách 23/10/2026); trống = NCC của phiếu. */
/** `uid`: khoá React ổn định — dòng mới chèn lên đầu nên không dùng chỉ số làm key được. */
type RequestRow = { uid: string; itemId: string; unitCode: string; quantity: string; estimatedUnitCost: string; imageUrl: string; supplierCode?: string };

/** Số lượng + ĐVT đặt hàng của một dòng PR / báo giá / PO để hiển thị ("1 KG", không phải "1.000 GR"). */
const qtyText = (quantity: number, line: UnitFields & { item?: { unit: string } | null }) => `${qty(toPurchaseQuantity(quantity, line))} ${purchaseLineUnit(line)}`;
/** Dòng gửi API theo ĐVT đặt: máy chủ quy về ĐVT tồn (withPurchaseUnits). Dòng cũ không có ĐVT đặt giữ nguyên. */
const unitPayload = (line: UnitFields & { itemId: string; quantity: number }, baseUnitCost: number) => line.unitCode
  ? { itemId: line.itemId, unitCode: line.unitCode, quantity: toPurchaseQuantity(line.quantity, line), unitCost: toPurchasePrice(baseUnitCost, line) }
  : { itemId: line.itemId, quantity: line.quantity, unitCost: baseUnitCost };


/**
 * Yêu cầu mua không còn bước duyệt: "APPROVED" nay nghĩa là đã gửi, chờ mua hàng báo giá
 * (xem chú thích cùng tên ở /api/procurement). Nhãn PO tách riêng vì cùng mã "APPROVED"
 * nhưng bên PO thì đúng là đã duyệt.
 */
const requestStatusLabel = (status: string) => ({
  DRAFT: "Nháp",
  // Thu mua duyệt PR mới lên PO (khách 21/10/2026). APPROVED = phiếu thời không duyệt, vẫn chờ xử lý.
  PENDING_APPROVAL: "Chờ thu mua duyệt",
  APPROVED: "Chờ thu mua duyệt",
  REJECTED: "Bị từ chối — chờ sửa",
  ORDERED: "Đã lên PO",
  COMPLETED: "Hoàn tất",
  CANCELLED: "Đã huỷ",
}[status] || status);
const requestStatusStyle = (status: string) => {
  if (["ORDERED", "COMPLETED"].includes(status)) return "bg-emerald-50 text-emerald-700";
  if (["REJECTED", "CANCELLED"].includes(status)) return "bg-rose-50 text-rose-700";
  return "bg-amber-50 text-amber-700";
};

const orderStatusLabel = (status: string) => ({
  DRAFT: "Nháp",
  APPROVED: "Đã duyệt",
  PARTIALLY_RECEIVED: "Nhận một phần",
  COMPLETED: "Hoàn tất",
  CANCELLED: "Đã huỷ",
}[status] || status);
const orderStatusStyle = (status: string) => {
  if (["APPROVED", "COMPLETED"].includes(status)) return "bg-emerald-50 text-emerald-700";
  if (status === "CANCELLED") return "bg-rose-50 text-rose-700";
  return "bg-amber-50 text-amber-700";
};

/** PR đã đi tiếp trong luồng thì không sửa/xoá nữa (khớp với /api/procurement). */
const lockedRequestStatuses = ["ORDERED", "COMPLETED", "CANCELLED", "REJECTED"];
/** PO chỉ còn sửa/xoá được khi đang ở trạng thái nháp. */
const lockedOrderStatuses = ["APPROVED", "PARTIALLY_RECEIVED", "COMPLETED", "CANCELLED"];
/** PR thu mua duyệt được / người đặt huỷ được (chưa lên PO). */
const pendingRequestStatuses = ["PENDING_APPROVAL", "APPROVED"];
/** PR nhập được báo giá (để so sánh) khi đang chờ duyệt. */
const quotableStatuses = ["APPROVED", "PENDING_APPROVAL", "ORDERED"];

let requestRowSeq = 0;
const emptyRequestRow = (): RequestRow => ({ uid: `row-${++requestRowSeq}`, itemId: "", unitCode: "", quantity: "1", estimatedUnitCost: "0", imageUrl: "" });

/**
 * Danh sách mặt hàng trên thẻ PR / PO thu gọn thành "N mặt hàng" (khách 21/10/2026: đơn 40+ dòng
 * kéo dài cả màn hình) — bấm Xem để mở đủ.
 */
function LinesPreview({ items, className = "text-xs text-slate-500" }: { items: string[]; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className={`block ${className}`}>
      <b className="text-slate-600">{items.length} mặt hàng</b>
      {items.length > 0 && (
        <button type="button" onClick={() => setOpen(!open)} className="ml-2 font-semibold text-blue-700 hover:underline">{open ? "Thu gọn" : "Xem"}</button>
      )}
      {open && <span className="block mt-1">{items.join(", ")}</span>}
    </span>
  );
}

export default function ProcurementPage() {
  const href = "/procurement";
  const { user, loading } = useModuleAuth(href);
  /**
   * Lọc PR / PO theo bộ phận được phân công — cùng phạm vi phòng ban với kiểm kê CCDC/tài sản
   * (khách 24/10/2026). Chỉ một bộ phận thì khoá luôn ô lọc ở bộ phận đó.
   */
  const ownDepartments = allowedDepartmentsOf(user);
  const singleDepartment = ownDepartments?.length === 1 ? ownDepartments[0] : null;
  // "So sánh giá" đứng trước: chốt giá với NCC rồi mới lập yêu cầu mua.
  const [active, setActive] = useState("quotes");
  const [data, setData] = useState<Data>({ items: [], requests: [], orders: [], departments: [], itemGroups: [], warehouses: [], assetGroups: [], templates: [], suppliers: [], priceSuggestions: {} });
  const [message, setMessage] = useState("");

  /** Form PR nhiều dòng: thông tin chung + danh sách dòng hàng. */
  const [requestForm, setRequestForm] = useState({
    branchCode: "HCM",
    departmentCode: "",
    warehouseCode: "",
    supplierCode: "",
    neededDate: vnTomorrow(),
    reason: "Bổ sung nguyên liệu vận hành",
  });
  const [requestRows, setRequestRows] = useState<RequestRow[]>([emptyRequestRow()]);
  /** Tab Yêu cầu mua: form tạo/sửa mở khi cần, danh sách lọc theo cửa hàng / phòng ban / trạng thái / ngày. */
  const [showRequestForm, setShowRequestForm] = useState(false);
  const [requestFilter, setRequestFilter] = useState(() => ({
    branchCode: "ALL",
    departmentCode: "ALL",
    status: "ALL",
    // Mặc định hôm nay (khách 25/10/2026), muốn xem ngày khác thì tự điền / xoá ngày.
    from: vnToday(),
    to: vnToday(),
    search: "",
  }));
  const [requestList, setRequestList] = useState<{ rows: PurchaseRequest[]; truncated: boolean } | null>(null);
  /** Tab So sánh giá: lọc PR có báo giá theo ngày yêu cầu (03/10/2026). Trống = 100 PR mới nhất. */
  const [quoteRange, setQuoteRange] = useState<DateRange>({ from: "", to: "" });
  const [quoteRangeRequests, setQuoteRangeRequests] = useState<PurchaseRequest[] | null>(null);

  const [quoteForm, setQuoteForm] = useState({
    requestId: "",
    supplierCode: "",
    supplierName: "",
    deliveryDays: "2",
    paymentTerms: "Công nợ 30 ngày",
  });
  /** Đơn giá báo của NCC theo TỪNG mặt hàng của PR đang chọn (thay cho 1 giá áp cả phiếu). */
  const [quoteLineCosts, setQuoteLineCosts] = useState<Record<string, string>>({});
  /** Thuế suất từng dòng báo giá (mã KKKNT / 0% / 5% / 8% / 10%), khoá itemId. */
  const [quoteLineVat, setQuoteLineVat] = useState<Record<string, string>>({});
  /** Dòng nào lấy giá từ Bảng giá NCC: itemId → "BG-202610-0001 · 120.000 đ/THÙNG". */
  const [quotePriceSource, setQuotePriceSource] = useState<Record<string, string>>({});

  /** Tab Đơn mua hàng: lọc cửa hàng / phòng ban / trạng thái / ngày đặt / đã gửi NCC (03/10/2026). */
  const [orderFilter, setOrderFilter] = useState({ branchCode: "ALL", departmentCode: "ALL", status: "ALL", sent: "ALL", from: vnToday(), to: vnToday(), search: "" });
  const [orderList, setOrderList] = useState<{ rows: PurchaseOrder[]; truncated: boolean } | null>(null);

  /** Đề nghị mua hàng / báo giá / đơn mua hàng đang được sửa. */
  const [editingRequest, setEditingRequest] = useState<PurchaseRequest | null>(null);
  const [editingQuote, setEditingQuote] = useState<Quote | null>(null);
  const [editingOrder, setEditingOrder] = useState<PurchaseOrder | null>(null);
  const [orderForm, setOrderForm] = useState({ supplierName: "", warehouseCode: "", expectedDate: "", note: "" });
  /** Modal gom mặt hàng theo NCC để tạo đơn đặt hàng từ các PR đã có báo giá. */
  const [poModalOpen, setPoModalOpen] = useState(false);
  const [poWarehouseByRequest, setPoWarehouseByRequest] = useState<Record<string, string>>({});
  const [creatingOrders, setCreatingOrders] = useState(false);
  /** Modal nhận hàng theo PO: nhập số lượng nhận từng dòng thay vì nhận trọn gói. */
  const [receivingOrder, setReceivingOrder] = useState<PurchaseOrder | null>(null);
  /** Đơn giá thực lúc nhận (theo ĐVT đặt) — PO duyệt khi chưa có giá thì nhập ở đây. */
  const [receivePrices, setReceivePrices] = useState<Record<string, string>>({});
  const [receivePriceSource, setReceivePriceSource] = useState<Record<string, string>>({});
  /** PR đang mở hộp Duyệt → PO. */
  const [approvingRequest, setApprovingRequest] = useState<PurchaseRequest | null>(null);
  const [receiveQuantities, setReceiveQuantities] = useState<Record<string, string>>({});
  /** Nhóm tài sản chọn cho từng dòng Tài sản/CCDC khi nhận hàng, khoá theo lineId. */
  const [receiveAssetGroups, setReceiveAssetGroups] = useState<Record<string, string>>({});
  const [receiveNote, setReceiveNote] = useState("");
  /** Ngày nhận hàng + chi phí mua hàng (vận chuyển, bốc xếp...) khai lúc nhận PO (khách 26/10/2026). */
  const [receiveDate, setReceiveDate] = useState(vnToday());
  const [receivePurchaseCost, setReceivePurchaseCost] = useState("");
  /** Chiết khấu + thuế suất từng dòng lúc nhận (khách 26/10/2026) và lỗi hiện NGAY TRONG hộp thoại. */
  const [receiveTerms, setReceiveTerms] = useState<Record<string, typeof emptyReceiveTerms>>({});
  const [receiveError, setReceiveError] = useState("");
  /** Dòng THÊM lúc nhận (NCC giao thêm chung phiếu, khách 26/10/2026): khoá dòng + mặt hàng + ĐVT chọn. */
  const [receiveExtras, setReceiveExtras] = useState<Array<{ key: string; itemId: string; unitCode: string }>>([]);
  const [receiving, setReceiving] = useState(false);
  /** Đơn đang mở hộp thoại Gửi NCC. */
  const [sendingOrder, setSendingOrder] = useState<PurchaseOrder | null>(null);
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
  const canDelete = user ? canPerformMenuAction(user, href, "delete") : false;
  const canCreatePartner = user ? canPerformMenuAction(user, "/settings", "config") : false;
  const departmentName = (code?: string | null) => data.departments.find((item) => item.code === code)?.name || code || "Chưa gán phòng ban";
  /**
   * Form PR khởi tạo cứng "HCM" (cửa hàng demo): ô chọn hiện ASA nhưng state vẫn gửi HCM → API báo
   * "không có quyền thao tác ngoài cửa hàng được phân công" (khách 25/10/2026). Như màn Kho: biết
   * cửa hàng thật của người dùng thì đưa form PR mới về cửa hàng đầu tiên trong đó.
   */
  useEffect(() => {
    if (!user || editingRequest) return;
    const codes = visibleStoreOptions(user).map((option) => option.code);
    if (codes.length === 0 || codes.includes(requestForm.branchCode)) return;
    const timer = window.setTimeout(() => {
      setRequestForm((form) => codes.includes(form.branchCode) ? form : {
        ...form,
        branchCode: codes[0],
        departmentCode: data.departments.find((item) => !item.branch || item.branch === "ALL" || item.branch === codes[0])?.code || "",
        warehouseCode: "",
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [user, editingRequest, showRequestForm, requestForm.branchCode, data.departments]);

  const departmentsForBranch = useMemo(
    () => data.departments.filter((item) => !item.branch || item.branch === "ALL" || item.branch === requestForm.branchCode),
    [data.departments, requestForm.branchCode],
  );

  const itemOptions = useMemo(
    () => data.items.map((item) => ({ value: item.id, label: `${item.name} (${item.code})`, subLabel: item.unit })),
    [data.items],
  );
  const supplierOptions = useMemo(
    () => data.suppliers.map((supplier) => ({ value: supplier.code, label: supplier.name, subLabel: `${supplier.code}${supplier.phone ? ` · ${supplier.phone}` : ""}` })),
    [data.suppliers],
  );

  const priceSourceLabel = (suggestion?: PriceSuggestion) => {
    if (!suggestion) return "";
    if (suggestion.source === "SELECTED_QUOTE") return `theo báo giá đã chốt của ${suggestion.supplierName}`;
    if (suggestion.source === "QUOTE") return `theo báo giá gần nhất của ${suggestion.supplierName}`;
    if (suggestion.source === "ORDER") return `theo đơn mua gần nhất từ ${suggestion.supplierName}`;
    return "theo giá vốn bình quân tồn kho";
  };

  /** Chọn mặt hàng cho một dòng PR -> hệ thống tự đề xuất đơn giá theo dữ liệu mua gần nhất. */
  /** Chọn mặt hàng → ĐVT mua mặc định của mặt hàng, giá đề xuất (theo ĐVT tồn) nhân hệ số ĐVT đó. */
  const pickRequestRowItem = (index: number, itemId: string) => {
    const suggestion = data.priceSuggestions[itemId];
    const item = data.items.find((candidate) => candidate.id === itemId);
    const unit = item ? defaultPurchaseUnit(item.unit, item.unitConversions, null) : { unitCode: "", conversionRate: 1 };
    setRequestRows((rows) => rows.map((row, rowIndex) => rowIndex === index
      ? { ...row, itemId, unitCode: unit.unitCode, estimatedUnitCost: suggestion ? String(toPurchasePrice(suggestion.price, { unitCode: unit.unitCode, conversionRate: unit.conversionRate })) : row.estimatedUnitCost }
      : row));
  };
  /** Đổi ĐVT trên dòng PR → giữ nguyên số lượng gõ, đơn giá dự kiến quy theo hệ số mới. */
  const pickRequestRowUnit = (index: number, unitCode: string) => {
    setRequestRows((rows) => rows.map((row, rowIndex) => {
      if (rowIndex !== index) return row;
      const item = data.items.find((candidate) => candidate.id === row.itemId);
      const options = item ? purchaseUnitOptions(item.unit, item.unitConversions) : [];
      const from = options.find((option) => option.unitCode === row.unitCode)?.conversionRate || 1;
      const to = options.find((option) => option.unitCode === unitCode)?.conversionRate || 1;
      const cost = Number(row.estimatedUnitCost || 0);
      return { ...row, unitCode, estimatedUnitCost: cost > 0 ? String(Math.round((cost / from) * to * 100) / 100) : row.estimatedUnitCost };
    }));
  };

  /** PR chưa sinh PO và đã có báo giá -> gom dòng báo giá theo NCC để đặt hàng. */
  const supplierGroups = useMemo(() => {
    const eligible = data.requests.filter((request) =>
      quotableStatuses.includes(request.status) &&
      !data.orders.some((order) => order.requestId === request.id) &&
      request.quotes.length > 0);
    const groups = new Map<string, { supplierCode: string; supplierName: string; entries: Array<{ request: PurchaseRequest; quote: Quote }> }>();
    for (const request of eligible) {
      for (const quote of request.quotes) {
        const group = groups.get(quote.supplierCode) || { supplierCode: quote.supplierCode, supplierName: quote.supplierName, entries: [] };
        group.entries.push({ request, quote });
        groups.set(quote.supplierCode, group);
      }
    }
    return [...groups.values()];
  }, [data.requests, data.orders]);

  const warehousesForBranch = (branchCode: string) => {
    const matched = data.warehouses.filter((warehouse) => !warehouse.branch || warehouse.branch === "ALL" || warehouse.branch === branchCode);
    return matched.length > 0 ? matched : data.warehouses;
  };

  const defaultWarehouseForBranch = (branchCode: string) => warehousesForBranch(branchCode)[0]?.code || `KHO_${branchCode}`;

  /** Phân nhóm mặt hàng -> nhóm kho (subGroup) -> kho cùng cửa hàng có group khớp nhóm kho đó. */
  const warehouseByItemGroup = (branchCode: string, categoryCode?: string | null) => {
    if (!categoryCode) return null;
    const itemGroup = data.itemGroups.find((row) => row.code === categoryCode);
    const warehouseGroup = itemGroup?.subGroup?.toUpperCase();
    if (!warehouseGroup) return null;
    return warehousesForBranch(branchCode).find((warehouse) => (warehouse.group || "").toUpperCase() === warehouseGroup) || null;
  };

  /** Kho nhận gợi ý cho PR: lấy theo phân nhóm của dòng hàng đầu tiên có gán nhóm kho. */
  const suggestedWarehouseForRequest = (request: PurchaseRequest) => {
    if (request.warehouseCode) return request.warehouseCode;
    for (const line of request.lines) {
      const matched = warehouseByItemGroup(request.branchCode, line.item?.category);
      if (matched) return matched.code;
    }
    return defaultWarehouseForBranch(request.branchCode);
  };

  const openPoModal = () => {
    setPoWarehouseByRequest((current) => {
      const defaults: Record<string, string> = { ...current };
      for (const group of supplierGroups) {
        for (const { request } of group.entries) {
          if (!defaults[request.id]) defaults[request.id] = suggestedWarehouseForRequest(request);
        }
      }
      return defaults;
    });
    setPoModalOpen(true);
  };

  /** Đặt hàng một NCC: tạo một PO nháp cho mỗi PR có báo giá của NCC đó. */
  const createOrdersForSupplier = async (group: { supplierCode: string; supplierName: string; entries: Array<{ request: PurchaseRequest; quote: Quote }> }) => {
    setCreatingOrders(true);
    setMessage("");
    try {
      const created: string[] = [];
      for (const { request, quote } of group.entries) {
        const response = await fetch("/api/procurement", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "CREATE_ORDER",
            requestId: request.id,
            supplierCode: group.supplierCode,
            supplierName: group.supplierName,
            branchCode: request.branchCode,
            departmentCode: request.departmentCode,
            warehouseCode: poWarehouseByRequest[request.id] || suggestedWarehouseForRequest(request),
            lines: quote.lines.map((line) => unitPayload(line, line.unitCost)),
          }),
        });
        const payload = await response.json();
        if (!response.ok) {
          setMessage(payload.error || `Không tạo được đơn mua hàng cho ${request.code}`);
          await loadData();
          return;
        }
        created.push(payload.code as string);
      }
      setPoModalOpen(false);
      setActive("orders");
      setMessage(`Đã tạo ${created.length} PO nháp cho ${group.supplierName}: ${created.join(", ")}. Vui lòng duyệt PO rồi nhận hàng ở Kho (Nhập mua).`);
      await loadData();
    } finally {
      setCreatingOrders(false);
    }
  };

  const loadData = async () => {
    const response = await fetch("/api/procurement");
    if (response.ok) {
      const payload = await response.json() as Data;
      setData(payload);
      setRequestForm((form) => {
        const availableDepartments = payload.departments.filter((item) => !item.branch || item.branch === "ALL" || item.branch === form.branchCode);
        return { ...form, departmentCode: form.departmentCode || availableDepartments[0]?.code || "" };
      });
      // Chỉ chọn sẵn PR thực sự có trong dropdown. Trước đây fallback lấy PR mới nhất
      // bất kể trạng thái -> ô "Yêu cầu mua" trống trơn (giá trị không nằm trong danh sách)
      // mà lưới giá bên dưới vẫn hiện, người dùng không hiểu đang báo giá cho phiếu nào.
      const quotable = payload.requests.filter((item) => quotableStatuses.includes(item.status));
      setQuoteForm((form) => ({
        ...form,
        requestId: quotable.some((item) => item.id === form.requestId) ? form.requestId : (quotable[0]?.id || ""),
      }));
    }
  };

  useEffect(() => {
    if (!loading) window.setTimeout(() => void loadData(), 0);
  }, [loading]);

  /** PR được phép nhập báo giá: đã gửi lên (kể cả đã đặt hàng, để bổ sung báo giá đối chiếu). */
  const quotableRequests = useMemo(
    () => data.requests.filter((item) => quotableStatuses.includes(item.status)),
    [data.requests],
  );
  /** Yêu cầu đã gửi nhưng mua hàng chưa lập đơn — việc đang chờ xử lý. */
  const waitingForPurchase = useMemo(
    () => data.requests.filter((item) =>
      quotableStatuses.includes(item.status) &&
      item.status !== "ORDERED" &&
      !data.orders.some((order) => order.requestId === item.id)).length,
    [data.requests, data.orders],
  );
  const selectedRequest = useMemo(() => quotableRequests.find((item) => item.id === quoteForm.requestId), [quotableRequests, quoteForm.requestId]);

  // Đổi PR trên form báo giá -> điền sẵn giá đề xuất cho từng dòng của PR đó.
  useEffect(() => {
    if (editingQuote) return;
    const request = data.requests.find((item) => item.id === quoteForm.requestId);
    if (!request) return;
    // Giá trên form báo giá theo ĐVT ĐẶT của dòng PR (giá đề xuất lưu theo ĐVT tồn → nhân hệ số).
    const costs: Record<string, string> = {};
    for (const line of request.lines) {
      costs[line.itemId] = String(toPurchasePrice(data.priceSuggestions[line.itemId]?.price ?? line.estimatedUnitCost ?? 0, line) || "");
    }
    const timer = window.setTimeout(() => {
      setQuoteLineCosts(costs);
      setQuoteLineVat({});
      setQuotePriceSource({});
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoteForm.requestId, editingQuote, data.requests]);

  /**
   * Chọn NCC cho báo giá mới → lấy đơn giá + thuế suất từ Bảng giá NCC đang hiệu lực hôm nay
   * của cửa hàng lập PR (khách yêu cầu 03/10/2026). Mặt hàng không có trong bảng giá giữ giá đề
   * xuất cũ; người nhập vẫn sửa tay được.
   */
  useEffect(() => {
    if (editingQuote || !quoteForm.supplierCode) return;
    const request = data.requests.find((item) => item.id === quoteForm.requestId);
    if (!request) return;
    let cancelled = false;
    const query = new URLSearchParams({ view: "active-prices", supplierCode: quoteForm.supplierCode, branchCode: request.branchCode });
    void fetch(`/api/procurement?${query.toString()}`).then(async (response) => {
      const payload = response.ok ? await response.json() as { prices: Array<{ itemId: string; stockUnitPrice: number; unitPrice: number; unitCode: string; vatRate: number | null; priceListCode: string }> } : { prices: [] };
      if (cancelled) return;
      const byItem = new Map(payload.prices.map((price) => [price.itemId, price]));
      const sources: Record<string, string> = {};
      const costs: Record<string, string> = {};
      const vats: Record<string, string> = {};
      // Đổi NCC thì dựng lại cả lưới: mặt hàng NCC mới không có trong bảng giá quay về giá đề
      // xuất, không giữ giá của NCC trước.
      for (const line of request.lines) {
        const price = byItem.get(line.itemId);
        if (!price) {
          costs[line.itemId] = String(toPurchasePrice(data.priceSuggestions[line.itemId]?.price ?? line.estimatedUnitCost ?? 0, line) || "");
          vats[line.itemId] = "KKKNT";
          continue;
        }
        // Bảng giá cùng ĐVT với dòng PR thì lấy thẳng giá bảng, khác ĐVT thì quy qua giá theo ĐVT tồn.
        costs[line.itemId] = String(price.unitCode === purchaseLineUnit(line)
          ? price.unitPrice
          : Math.round(toPurchasePrice(price.stockUnitPrice, line) * 100) / 100);
        vats[line.itemId] = vatRateLabel(price.vatRate);
        sources[line.itemId] = `${price.priceListCode} · ${money(price.unitPrice)} đ/${price.unitCode}`;
      }
      setQuoteLineCosts(costs);
      setQuoteLineVat(vats);
      setQuotePriceSource(sources);
    });
    return () => { cancelled = true; };
  }, [quoteForm.supplierCode, quoteForm.requestId, editingQuote, data.requests, data.priceSuggestions]);

  // Danh sách PO có lọc — tải lại khi đổi bộ lọc hoặc sau mỗi thao tác (loadData đổi data.orders).
  useEffect(() => {
    if (active !== "orders") return;
    let cancelled = false;
    const query = new URLSearchParams({ view: "orders", branchCode: orderFilter.branchCode, departmentCode: singleDepartment || orderFilter.departmentCode, status: orderFilter.status, sent: orderFilter.sent });
    if (orderFilter.from) query.set("from", orderFilter.from);
    if (orderFilter.to) query.set("to", orderFilter.to);
    void fetch(`/api/procurement?${query.toString()}`).then(async (response) => {
      const payload = response.ok ? await response.json() as { orders: PurchaseOrder[]; truncated: boolean } : { orders: [], truncated: false };
      if (!cancelled) setOrderList({ rows: payload.orders, truncated: payload.truncated });
    });
    return () => { cancelled = true; };
  }, [active, orderFilter.branchCode, orderFilter.departmentCode, orderFilter.status, orderFilter.sent, orderFilter.from, orderFilter.to, data.orders, singleDepartment]);

  // So sánh giá có khoảng ngày: hỏi máy chủ để thấy cả PR cũ ngoài 100 phiếu mới nhất.
  useEffect(() => {
    if (active !== "quotes" || (!quoteRange.from && !quoteRange.to)) return;
    let cancelled = false;
    const query = new URLSearchParams({ view: "requests" });
    if (quoteRange.from) query.set("from", quoteRange.from);
    if (quoteRange.to) query.set("to", quoteRange.to);
    void fetch(`/api/procurement?${query.toString()}`).then(async (response) => {
      const payload = response.ok ? await response.json() as { requests: PurchaseRequest[] } : { requests: [] };
      if (!cancelled) setQuoteRangeRequests(payload.requests);
    });
    return () => { cancelled = true; };
  }, [active, quoteRange.from, quoteRange.to, data.requests]);

  // Danh sách PR có lọc — tải lại khi đổi bộ lọc hoặc sau mỗi thao tác (loadData đổi data.requests).
  useEffect(() => {
    if (active !== "requests") return;
    let cancelled = false;
    const query = new URLSearchParams({ view: "requests", branchCode: requestFilter.branchCode, departmentCode: singleDepartment || requestFilter.departmentCode, status: requestFilter.status });
    if (requestFilter.from) query.set("from", requestFilter.from);
    if (requestFilter.to) query.set("to", requestFilter.to);
    void fetch(`/api/procurement?${query.toString()}`).then(async (response) => {
      const payload = response.ok ? await response.json() as { requests: PurchaseRequest[]; truncated: boolean } : { requests: [], truncated: false };
      if (!cancelled) setRequestList({ rows: payload.requests, truncated: payload.truncated });
    });
    return () => { cancelled = true; };
  }, [active, requestFilter.branchCode, requestFilter.departmentCode, requestFilter.status, requestFilter.from, requestFilter.to, data.requests, singleDepartment]);

  const send = async (method: "POST" | "PATCH", body: object, success: string) => {
    setMessage("");
    const response = await fetch("/api/procurement", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json();
    setMessage(response.ok ? success : payload.error || "Không thực hiện được thao tác");
    if (response.ok) await loadData();
    return response.ok;
  };

  /** Tiền thuế GTGT của một báo giá — tròn từng dòng như phiếu nhập mua. */
  const quoteVatTotal = (quote: Quote) => quote.lines.reduce((sum, line) => sum + vatAmountOf(Math.round(line.quantity * line.unitCost), line.vatRate ?? null), 0);

  /** Đơn mua hàng còn hiệu lực (chưa huỷ) lập từ một PR. */
  const liveOrdersOf = (request: PurchaseRequest) => {
    const loaded = data.orders.filter((order) => order.requestId === request.id && order.status !== "CANCELLED");
    // PR cũ ở danh sách có lọc: đơn của nó có thể nằm ngoài 100 PO mới nhất của payload chung —
    // dùng danh sách đơn đi kèm PR (view=requests) để khoá sửa/xoá cho đúng.
    if (loaded.length > 0 || !request.orders) return loaded;
    return request.orders.filter((order) => order.status !== "CANCELLED") as unknown as PurchaseOrder[];
  };
  /** PR đã sinh đơn mua hàng thì mọi thay đổi phải đi qua đơn mua, không sửa ngược lại PR. */
  const requestHasOrder = (request: PurchaseRequest) => liveOrdersOf(request).length > 0;
  /** Huỷ được khi hàng chưa về và chưa sinh công nợ — khớp CANCEL_ORDER ở /api/procurement. */
  const canCancelOrder = (order: PurchaseOrder) =>
    ["DRAFT", "APPROVED"].includes(order.status) && order.lines.every((line) => line.receivedQuantity === 0) && !order.payable;

  const canApproveRequest = (request: PurchaseRequest) => pendingRequestStatuses.includes(request.status) && !requestHasOrder(request);
  const canCancelRequest = (request: PurchaseRequest) => [...pendingRequestStatuses, "REJECTED"].includes(request.status) && !requestHasOrder(request);
  /** Từ chối = trả về người đặt sửa lại / huỷ, kèm lý do. */
  const rejectRequest = async (request: PurchaseRequest) => {
    const reason = window.prompt(`Từ chối ${request.code} — trả về người đặt sửa lại.\n\nLý do (người đặt sẽ thấy):`, "");
    if (reason === null) return;
    await send("PATCH", { action: "REJECT_REQUEST", requestId: request.id, reason }, `Đã từ chối ${request.code} — người đặt sửa lại rồi gửi lại, hoặc huỷ.`);
  };
  const cancelRequest = async (request: PurchaseRequest) => {
    if (!window.confirm(`Huỷ yêu cầu mua ${request.code}? Phiếu huỷ không xử lý tiếp được nữa.`)) return;
    await send("PATCH", { action: "CANCEL_REQUEST", requestId: request.id }, `Đã huỷ ${request.code}.`);
  };

  const requestLockReason = (request: PurchaseRequest) => {
    if (requestHasOrder(request)) {
      return `Yêu cầu mua ${request.code} đã lên đơn ${liveOrdersOf(request).map((order) => order.code).join(", ")} nên không thể sửa hoặc xoá. Hãy huỷ đơn mua hàng trước.`;
    }
    // Bị từ chối: người đặt sửa rồi gửi lại (hoặc bấm Huỷ phiếu).
    if (lockedRequestStatuses.includes(request.status) && request.status !== "REJECTED") {
      return `Yêu cầu mua ${request.code} đang ở trạng thái "${requestStatusLabel(request.status)}" nên không thể sửa hoặc xoá.`;
    }
    // Đổi dòng hàng sau khi có báo giá sẽ làm báo giá lệch so với thứ đang cần mua.
    if (request.quotes.length > 0) {
      return `Yêu cầu mua ${request.code} đã có ${request.quotes.length} báo giá nên không thể sửa hoặc xoá. Hãy xoá báo giá ở tab So sánh giá trước.`;
    }
    return null;
  };

  const orderLockReason = (order: PurchaseOrder) => {
    if (order.status === "CANCELLED") return `Đơn mua hàng ${order.code} đã huỷ.`;
    if (order.approvedAt || lockedOrderStatuses.includes(order.status)) {
      return `Đơn mua hàng ${order.code} đã được duyệt nên không thể sửa hoặc xoá. Bấm "Bỏ duyệt" để sửa, hoặc "Huỷ đơn" nếu không đặt nữa.`;
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
    if (requestHasOrder(request)) {
      return `Đề nghị mua hàng ${request.code} đã lên đơn ${liveOrdersOf(request).map((order) => order.code).join(", ")}. Huỷ đơn đó trước rồi mới sửa/xoá được báo giá.`;
    }
    if (lockedRequestStatuses.includes(request.status)) {
      return `Đề nghị mua hàng ${request.code} đang ở trạng thái "${requestStatusLabel(request.status)}" nên không thể sửa hoặc xoá báo giá kèm theo.`;
    }
    if (quote.isSelected) {
      return `Báo giá của ${quote.supplierName} đang được chốt nên không thể sửa hoặc xoá. Bấm "Bỏ chốt" trước.`;
    }
    return null;
  };

  const resetRequestForm = () => {
    setEditingRequest(null);
    setShowRequestForm(false);
    setRequestForm((form) => ({
      ...form,
      branchCode: "HCM",
      departmentCode: data.departments.find((item) => !item.branch || item.branch === "ALL" || item.branch === "HCM")?.code || "",
      warehouseCode: "",
      supplierCode: "",
      neededDate: vnTomorrow(),
      reason: "Bổ sung nguyên liệu vận hành",
    }));
    setRequestRows([emptyRequestRow()]);
  };

  const startEditRequest = (request: PurchaseRequest) => {
    setEditingRequest(request);
    setShowRequestForm(true);
    setActive("requests");
    setRequestForm({
      branchCode: request.branchCode,
      departmentCode: request.departmentCode || "",
      warehouseCode: request.warehouseCode || "",
      supplierCode: request.supplierCode || "",
      neededDate: (request.neededDate || request.requestDate).slice(0, 10),
      reason: request.reason,
    });
    setRequestRows(request.lines.map((line) => ({
      uid: line.id,
      itemId: line.itemId,
      unitCode: line.unitCode || "",
      quantity: String(toPurchaseQuantity(line.quantity, line)),
      estimatedUnitCost: String(toPurchasePrice(line.estimatedUnitCost, line)),
      imageUrl: line.imageUrl || "",
      supplierCode: line.supplierCode || "",
    })));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const submitRequest = async (event: React.FormEvent) => {
    event.preventDefault();
    const lines = requestRows
      .filter((row) => row.itemId && Number(row.quantity) > 0)
      .map((row) => ({ itemId: row.itemId, unitCode: row.unitCode || undefined, quantity: row.quantity, estimatedUnitCost: row.estimatedUnitCost, imageUrl: row.imageUrl, supplierCode: row.supplierCode || "" }));
    if (lines.length === 0) {
      setMessage("Chọn ít nhất một mặt hàng và số lượng lớn hơn 0.");
      return;
    }

    if (editingRequest) {
      const ok = await send(
        "PATCH",
        {
          action: "UPDATE_REQUEST",
          requestId: editingRequest.id,
          branchCode: requestForm.branchCode,
          departmentCode: requestForm.departmentCode,
          warehouseCode: requestForm.warehouseCode,
          supplierCode: requestForm.supplierCode,
          neededDate: requestForm.neededDate,
          reason: requestForm.reason,
          lines,
        },
        editingRequest.status === "REJECTED"
          ? `Đã sửa và gửi lại ${editingRequest.code} cho thu mua duyệt.`
          : `Đã lưu thay đổi đề nghị mua hàng ${editingRequest.code}.`,
      );
      if (ok) resetRequestForm();
      return;
    }

    const ok = await send("POST", { action: "CREATE_REQUEST", branchCode: requestForm.branchCode, departmentCode: requestForm.departmentCode, warehouseCode: requestForm.warehouseCode, supplierCode: requestForm.supplierCode, neededDate: requestForm.neededDate, reason: requestForm.reason, lines }, `Đã tạo yêu cầu mua hàng (${lines.length} mặt hàng).`);
    if (ok) setRequestRows([emptyRequestRow()]);
  };

  const resetQuoteForm = () => {
    setEditingQuote(null);
    setQuoteForm((form) => ({
      ...form,
      supplierCode: "",
      supplierName: "",
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
      deliveryDays: quote.deliveryDays !== null ? String(quote.deliveryDays) : "",
      paymentTerms: quote.paymentTerms || "",
    });
    const costs: Record<string, string> = {};
    const vats: Record<string, string> = {};
    for (const line of quote.lines) {
      costs[line.itemId] = String(toPurchasePrice(line.unitCost, line));
      vats[line.itemId] = vatRateLabel(line.vatRate ?? null);
    }
    setQuoteLineCosts(costs);
    setQuoteLineVat(vats);
    setQuotePriceSource({});
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const pickSupplier = (code: string) => {
    const supplier = data.suppliers.find((candidate) => candidate.code === code);
    setQuoteForm((form) => ({ ...form, supplierCode: code, supplierName: supplier?.name || code }));
  };

  const onSupplierCreated = (partner: CreatedPartner) => {
    setData((current) => ({ ...current, suppliers: [...current.suppliers, { id: partner.id, code: partner.code, name: partner.name }] }));
    setQuoteForm((form) => ({ ...form, supplierCode: partner.code, supplierName: partner.name }));
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
          // Đơn giá trên form theo ĐVT đặt; dòng cũ (không ĐVT đặt) hệ số 1 nên vẫn là ĐVT tồn.
          lines: editingQuote.lines.map((line) => ({ ...unitPayload(line, line.unitCost), unitCost: quoteLineCosts[line.itemId] ?? toPurchasePrice(line.unitCost, line), vatRate: quoteLineVat[line.itemId] ?? vatRateLabel(line.vatRate ?? null) })),
        },
        `Đã lưu thay đổi báo giá của ${quoteForm.supplierName}.`,
      );
      if (ok) resetQuoteForm();
      return;
    }

    if (!selectedRequest) {
      setMessage(quotableRequests.length === 0
        ? "Chưa có yêu cầu mua nào để nhập báo giá. Hãy tạo yêu cầu ở tab Đặt theo mẫu hoặc Yêu cầu mua trước."
        : "Chọn yêu cầu mua cần nhập báo giá trước.");
      return;
    }
    if (!quoteForm.supplierCode) {
      setMessage("Chọn nhà cung cấp báo giá trước.");
      return;
    }
    const missing = selectedRequest.lines.filter((line) => !(Number(quoteLineCosts[line.itemId]) > 0));
    if (missing.length > 0) {
      setMessage(`Chưa nhập đơn giá cho: ${missing.map((line) => line.item.name).join(", ")}.`);
      return;
    }
    await send("POST", {
      action: "ADD_QUOTE",
      requestId: selectedRequest.id,
      supplierCode: quoteForm.supplierCode,
      supplierName: quoteForm.supplierName,
      deliveryDays: quoteForm.deliveryDays,
      paymentTerms: quoteForm.paymentTerms,
      lines: selectedRequest.lines.map((line) => ({ ...unitPayload(line, 0), unitCost: quoteLineCosts[line.itemId], vatRate: quoteLineVat[line.itemId] || "KKKNT" })),
    }, "Đã thêm báo giá nhà cung cấp.");
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

  /** Nhóm tài sản dùng được cho một dòng PO — cùng luật với API (lib/asset-group-rules.ts). */
  const assetGroupOptionsFor = (itemType: string) => assetGroupCandidates(itemType, data.assetGroups);

  /** Mở modal nhận hàng: điền sẵn số lượng còn phải nhận trên từng dòng. */
  const startReceiving = (order: PurchaseOrder) => {
    const quantities: Record<string, string> = {};
    const assetGroups: Record<string, string> = {};
    for (const line of order.lines) {
      // Số nhận gõ theo ĐVT đặt của dòng PO — máy chủ quy về ĐVT tồn khi ghi phiếu nhập.
      const remaining = toPurchaseQuantity(line.orderedQuantity - line.receivedQuantity, line);
      if (remaining > 0) quantities[line.id] = String(remaining);
      // Chỉ có đúng một nhóm hợp lệ thì chọn sẵn, khỏi bắt bấm thừa; nhiều nhóm thì để trống
      // để người nhận hàng tự chọn — hồ sơ tài sản mang nhóm nào là quyết định của họ.
      const options = assetGroupOptionsFor(line.item.itemType);
      if (options.length === 1) assetGroups[line.id] = options[0].code;
    }
    setReceiveQuantities(quantities);
    setReceivePrices(Object.fromEntries(order.lines.map((line) => [line.id, line.unitCost > 0 ? String(toPurchasePrice(line.unitCost, line)) : ""])));
    setReceivePriceSource({});
    // Giá gợi ý: giá PO, dòng chưa có giá lấy Bảng giá của NCC trên PO — chỉ điền ô còn trống.
    void fetch(`/api/procurement?view=receive-prices&orderId=${encodeURIComponent(order.id)}`)
      .then(async (response) => (response.ok ? await response.json() as { prices: Record<string, { price: number; source: string }> } : { prices: {} }))
      .catch(() => ({ prices: {} as Record<string, { price: number; source: string }> }))
      .then(({ prices }) => {
        setReceivePrices((current) => Object.fromEntries(Object.entries(current).map(([lineId, value]) => [lineId, value || (prices[lineId] ? String(prices[lineId].price) : "")])));
        setReceivePriceSource(Object.fromEntries(Object.entries(prices).map(([lineId, row]) => [lineId, row.source])));
      });
    setReceiveAssetGroups(assetGroups);
    setReceiveNote("");
    setReceiveDate(vnToday());
    setReceivePurchaseCost("");
    setReceiveTerms({});
    setReceiveError("");
    setReceiveExtras([]);
    setReceivingOrder(order);
  };

  /** Dòng còn phải nhận của PO cho bảng nhận hàng dùng chung (components/PurchaseReceiveLines). */
  const receiveLineInfos = (order: PurchaseOrder): ReceiveLineInfo[] => order.lines.flatMap((line) => {
    const remaining = toPurchaseQuantity(line.orderedQuantity - line.receivedQuantity, line);
    if (remaining <= 0) return [];
    const unit = purchaseLineUnit(line);
    const isAsset = ["TOOL", "ASSET"].includes(line.item.itemType);
    const groupOptions = isAsset ? assetGroupOptionsFor(line.item.itemType) : [];
    return [{
      id: line.id,
      name: line.item.name,
      unit,
      remaining,
      hint: poPriceHint(line.unitCost > 0 ? toPurchasePrice(line.unitCost, line) : 0, unit, receivePriceSource[line.id]),
      badge: isAsset ? <span className="status bg-indigo-50 text-indigo-700 ml-1">Tài sản/CCDC</span> : undefined,
      // Nhóm tài sản quyết định tiền tố mã hồ sơ (CCDCBAR0001...) và mã đã cấp là không sửa được,
      // nên phải chọn ngay tại đây thay vì để hệ thống đoán.
      extra: isAsset ? (
        <label className="mt-1 block text-[11px] font-bold text-slate-600">
          Nhóm tài sản
          <select
            className="control !mt-1 !py-1.5 text-xs"
            value={receiveAssetGroups[line.id] || ""}
            onChange={(e) => setReceiveAssetGroups({ ...receiveAssetGroups, [line.id]: e.target.value })}
            aria-label={`Nhóm tài sản của ${line.item.name}`}
          >
            <option value="">-- Chọn nhóm tài sản --</option>
            {groupOptions.map((group) => <option key={group.code} value={group.code}>{group.code} - {group.name}</option>)}
          </select>
          {groupOptions.length === 0 && (
            <span className="mt-1 block font-medium text-amber-700">
              Chưa khai Nhóm tài sản nào thuộc phân loại {assetGroupTypeLabel(line.item.itemType)}. Thêm ở Cài đặt &gt; Danh mục &gt; Nhóm tài sản rồi nhận lại.
            </span>
          )}
        </label>
      ) : undefined,
    }];
  });
  const receiveExtraInfos = (): ReceiveLineInfo[] => receiveExtras.flatMap((extra) => {
    const item = data.items.find((candidate) => candidate.id === extra.itemId);
    if (!item) return [];
    const isAsset = ["TOOL", "ASSET"].includes(item.itemType);
    const groupOptions = isAsset ? assetGroupOptionsFor(item.itemType) : [];
    return [{
      id: extra.key,
      name: item.name,
      unit: extra.unitCode,
      remaining: 0,
      isExtra: true,
      hint: "Thêm lúc nhận — vào chung PO này",
      badge: isAsset ? <span className="status bg-indigo-50 text-indigo-700 ml-1">Tài sản/CCDC</span> : undefined,
      extra: (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <select
            className="control !mt-0 !h-8 !py-0 w-auto text-xs"
            value={extra.unitCode}
            onChange={(e) => { const unitCode = e.target.value; setReceiveExtras((current) => current.map((row) => row.key === extra.key ? { ...row, unitCode } : row)); }}
            aria-label={`ĐVT ${item.name}`}
          >
            {purchaseUnitOptions(item.unit, item.unitConversions).map((option) => <option key={option.unitCode} value={option.unitCode}>{option.label}</option>)}
          </select>
          {isAsset && (
            <select className="control !mt-0 !h-8 !py-0 w-auto text-xs" value={receiveAssetGroups[extra.key] || ""} onChange={(e) => setReceiveAssetGroups({ ...receiveAssetGroups, [extra.key]: e.target.value })} aria-label={`Nhóm tài sản của ${item.name}`}>
              <option value="">-- Nhóm tài sản --</option>
              {groupOptions.map((group) => <option key={group.code} value={group.code}>{group.code} - {group.name}</option>)}
            </select>
          )}
          <button type="button" className="text-xs font-bold text-rose-600 hover:underline" onClick={() => setReceiveExtras((current) => current.filter((row) => row.key !== extra.key))}>Bỏ dòng</button>
        </div>
      ),
    }];
  });
  const addReceiveExtra = (itemId: string) => {
    const item = data.items.find((candidate) => candidate.id === itemId);
    if (!item) return;
    const unit = defaultPurchaseUnit(item.unit, item.unitConversions);
    const key = `extra-${Date.now()}`;
    const suggested = data.priceSuggestions[itemId]?.price || 0;
    setReceiveExtras((current) => [...current, { key, itemId, unitCode: unit.unitCode }]);
    setReceiveQuantities((current) => ({ ...current, [key]: "" }));
    setReceivePrices((current) => ({ ...current, [key]: suggested > 0 ? String(Math.round(suggested * unit.conversionRate * 100) / 100) : "" }));
  };
  const receiveLineValues = (order: PurchaseOrder): Record<string, ReceiveLineValue> => Object.fromEntries([...order.lines.map((line) => line.id), ...receiveExtras.map((extra) => extra.key)].map((id) => [id, {
    quantity: receiveQuantities[id] ?? "",
    price: receivePrices[id] ?? "",
    ...(receiveTerms[id] || emptyReceiveTerms),
  }]));
  const patchReceiveLine = (lineId: string, patch: Partial<ReceiveLineValue>) => {
    if (patch.quantity !== undefined) setReceiveQuantities((current) => ({ ...current, [lineId]: patch.quantity as string }));
    if (patch.price !== undefined) setReceivePrices((current) => ({ ...current, [lineId]: patch.price as string }));
    const { quantity: _quantity, price: _price, ...terms } = patch;
    void _quantity; void _price;
    if (Object.keys(terms).length > 0) setReceiveTerms((current) => ({ ...current, [lineId]: { ...(current[lineId] || emptyReceiveTerms), ...terms } }));
  };

  const submitReceive = async () => {
    if (!receivingOrder) return;
    // Gửi ĐỦ mọi dòng kèm lineId, kể cả dòng để 0: bỏ dòng 0 ra khỏi danh sách thì máy chủ hiểu
    // là "không khai" và nhận trọn phần còn lại của dòng đó — hàng chưa về mà vẫn vào kho.
    const lines = receivingOrder.lines.map((line) => ({
      lineId: line.id,
      itemId: line.itemId,
      quantity: Number(receiveQuantities[line.id] ?? 0) || 0,
      unitCost: Number(receivePrices[line.id] || 0) || undefined,
      assetGroup: receiveAssetGroups[line.id] || "",
      ...(receiveTerms[line.id] || emptyReceiveTerms),
    }));
    const extraLines = receiveExtras.map((extra) => ({
      itemId: extra.itemId,
      unitCode: extra.unitCode,
      quantity: Number(receiveQuantities[extra.key] ?? 0) || 0,
      unitCost: Number(receivePrices[extra.key] || 0) || 0,
      assetGroup: receiveAssetGroups[extra.key] || "",
      ...(receiveTerms[extra.key] || emptyReceiveTerms),
    }));
    // Lỗi hiện trong hộp thoại: trước đây setMessage ghi ra trang phía sau, bị hộp thoại che nên
    // người dùng tưởng nút "Xác nhận nhận hàng" bấm không được (khách 26/10/2026).
    setReceiveError("");
    if (lines.every((line) => line.quantity <= 0) && extraLines.length === 0) {
      setReceiveError("Chưa nhập số lượng cần nhận.");
      return;
    }
    const missingExtra = extraLines.find((line) => !(line.quantity > 0));
    if (missingExtra) {
      setReceiveError(`Nhập số lượng cho mặt hàng thêm ${data.items.find((item) => item.id === missingExtra.itemId)?.name || ""} hoặc bấm Bỏ dòng.`);
      return;
    }
    const lineErrors = receiveLineErrors([...receiveLineInfos(receivingOrder), ...receiveExtraInfos()], receiveLineValues(receivingOrder));
    if (lineErrors.length > 0) {
      setReceiveError(lineErrors.join(" · "));
      return;
    }
    setReceiving(true);
    setMessage("");
    try {
      const response = await fetch("/api/procurement", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "RECEIVE_ORDER", orderId: receivingOrder.id, lines, extraLines, note: receiveNote, receivedDate: receiveDate, purchaseCost: Number(receivePurchaseCost || 0) || 0 }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setReceiveError(payload.error || "Không nhận được hàng từ PO");
        return;
      }
      const parts: string[] = [];
      if (payload.receiptCode) parts.push(`phiếu nhập kho ${payload.receiptCode} vào ${receivingOrder.warehouseCode}`);
      if (payload.assetsCreated > 0) parts.push(`${payload.assetsCreated} tài sản/CCDC đã vào sổ Tài sản & Khấu hao`);
      setMessage(`Đã nhận hàng từ ${receivingOrder.code}: ${parts.join(" · ") || "cập nhật thành công"}.`);
      setReceivingOrder(null);
      await loadData();
    } finally {
      setReceiving(false);
    }
  };

  /** Gửi phiếu cho NCC: mở hộp thoại xem trước + gửi Zalo/email/SMS/ảnh (send-po-dialog.tsx). */
  const sharePO = (order: PurchaseOrder) => {
    setMessage("");
    setSendingOrder(order);
  };

  const cancelOrder = async (order: PurchaseOrder) => {
    const sent = Boolean(order.shareToken);
    const reason = window.prompt(
      `Huỷ đơn ${order.code} (${order.supplierName})?\n` +
        (sent ? "Link/QR đã gửi NCC vẫn mở được nhưng hiện rõ ĐƠN ĐÃ HUỶ — nên báo NCC ngay sau khi huỷ.\n" : "") +
        "Yêu cầu mua sẽ trở về Chờ mua hàng để sửa báo giá hoặc lập đơn khác.\n\nLý do huỷ (không bắt buộc, chỉ lưu nội bộ):",
      "",
    );
    if (reason === null) return;
    const ok = await send("PATCH", { action: "CANCEL_ORDER", orderId: order.id, reason }, `Đã huỷ đơn ${order.code}.${sent ? " Bấm \"Báo huỷ NCC\" để gửi thông báo huỷ cho nhà cung cấp." : ""}`);
    if (ok && sent) setSendingOrder({ ...order, status: "CANCELLED" });
  };

  /** PO chưa gửi NCC lần nào — nút Gửi NCC tô đỏ cho dễ thấy (khách 25/10/2026). */
  const notSentYet = (order: PurchaseOrder) => order.status !== "CANCELLED" && !order.shareToken;

  const sendLabel = (order: PurchaseOrder) => {
    if (order.status === "CANCELLED") return "Báo huỷ NCC";
    if (order.status === "DRAFT") return canApprove ? "Duyệt & gửi NCC" : "Gửi NCC";
    return order.shareToken ? "Gửi lại NCC" : "Gửi NCC";
  };

  const revokeShare = async (order: PurchaseOrder) => {
    if (!window.confirm(`Thu hồi link phiếu của ${order.code}? NCC đang giữ link/QR cũ sẽ không mở được nữa.`)) return;
    await send("PATCH", { action: "REVOKE_SHARE_LINK", orderId: order.id }, `Đã thu hồi link phiếu ${order.code}.`);
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
    // Kho nhận lấy theo gợi ý phân nhóm mặt hàng của PR (ô "Kho nhận" ở tab Đơn mua hàng đã bỏ
    // 03/10/2026 — khách tưởng là bộ lọc). Đổi kho thì sửa trên PO nháp.
    await send("POST", { action: "CREATE_ORDER", requestId: request.id, supplierCode: quote.supplierCode, supplierName: quote.supplierName, branchCode: request.branchCode, departmentCode: request.departmentCode, warehouseCode: suggestedWarehouseForRequest(request), lines: quote.lines.map((line) => unitPayload(line, line.unitCost)) }, "Đã tạo PO nháp từ báo giá. Vui lòng duyệt PO trước khi nhận hàng.");
    setActive("orders");
  };

  const totalPRs = data.requests.length;
  
  const totalPOs = data.orders.length;
  const openPOs = data.orders.filter((o) => !["COMPLETED", "RECEIVED"].includes(o.status)).length;

  if (loading) return <div className="h-screen grid place-items-center bg-slate-100">Đang tải...</div>;

  const quotedRequests = ((quoteRange.from || quoteRange.to) && quoteRangeRequests ? quoteRangeRequests : data.requests).filter((request) => request.quotes.length > 0);
  const requestTotal = (request: PurchaseRequest) => request.lines.reduce((sum, line) => sum + line.quantity * line.estimatedUnitCost, 0);
  const orderKeyword = orderFilter.search.trim().toLowerCase();
  const filteredOrders = (orderList?.rows || []).filter((order) => !orderKeyword
    || `${order.code} ${order.supplierName} ${order.supplierCode} ${order.note || ""}`.toLowerCase().includes(orderKeyword)
    || order.lines.some((line) => line.item.code.toLowerCase().includes(orderKeyword) || line.item.name.toLowerCase().includes(orderKeyword)));
  const requestKeyword = requestFilter.search.trim().toLowerCase();
  const filteredRequests = (requestList?.rows || []).filter((request) => !requestKeyword
    || `${request.code} ${request.reason} ${request.requestedBy}`.toLowerCase().includes(requestKeyword)
    || request.lines.some((line) => line.item.code.toLowerCase().includes(requestKeyword) || line.item.name.toLowerCase().includes(requestKeyword)));

  return (
    // Khung rộng như Kho & Định lượng (khách yêu cầu 03/10/2026): bảng báo giá / bảng giá nhiều cột.
    <ModuleFrame title="Mua hàng & Nhà cung cấp" subtitle="PR theo mẫu, so sánh giá, bảng giá NCC, PO gửi NCC và nhận hàng" role={user?.role} contentClassName="max-w-[1680px]">
      {/* Operational Summary Cards */}
      <StickyFilterBar>
      <div className="hidden sm:grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500">Tổng yêu cầu PR</span>
            <span className="material-symbols-outlined text-blue-500 text-xl">assignment</span>
          </div>
          <p className="text-lg font-bold text-slate-800 mt-1">{totalPRs} yêu cầu</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500">PR chờ mua hàng</span>
            <span className="material-symbols-outlined text-amber-500 text-xl">pending_actions</span>
          </div>
          <p className="text-lg font-bold text-amber-600 mt-1">{waitingForPurchase} yêu cầu</p>
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

      {active === "templates" && (
        <TemplatesTab
          user={user}
          canCreate={canCreate}
          canEdit={canEdit}
          items={data.items}
          templates={data.templates}
          departments={data.departments}
          warehouses={data.warehouses}
          suppliers={supplierOptions}
          notify={setMessage}
          reload={loadData}
        />
      )}

      {active === "price-lists" && (
        <PriceListsTab
          user={user}
          canCreate={canCreate}
          canDelete={canDelete}
          items={data.items}
          suppliers={data.suppliers}
          notify={setMessage}
        />
      )}

      {active === "requests" && (
        <div className="space-y-5">
          {/* Form mở khi bấm "Tạo yêu cầu mua" / Sửa, chiếm cả bề ngang; danh sách bên dưới rộng
              hết khung như Kho & Định lượng (khách yêu cầu 03/10/2026). */}
          {((canCreate && showRequestForm) || editingRequest) && (
            <form onSubmit={submitRequest} className="bg-white border border-slate-200 rounded-lg p-4 sm:p-5 space-y-4 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <h2 className="font-bold text-slate-800">
                  {editingRequest ? `Sửa đề nghị ${editingRequest.code}` : "Tạo yêu cầu mua"}
                </h2>
                <button type="button" onClick={resetRequestForm} className="icon-button" title="Đóng form"><span className="material-symbols-outlined">close</span></button>
              </div>

              <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
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

                <Field label="Kho nhận hàng">
                  <select value={requestForm.warehouseCode} onChange={(e) => setRequestForm({ ...requestForm, warehouseCode: e.target.value })} className="control">
                    <option value="">-- Thu mua chọn lúc duyệt --</option>
                    {warehousesForBranch(requestForm.branchCode).map((warehouse) => (
                      <option key={warehouse.code} value={warehouse.code}>{warehouse.name} ({warehouse.code})</option>
                    ))}
                  </select>
                </Field>

                <Field label="Nhà cung cấp đề xuất">
                  <div className="mt-1.5">
                    <SearchableSelect
                      value={requestForm.supplierCode}
                      onChange={(supplierCode) => setRequestForm({ ...requestForm, supplierCode })}
                      options={[{ value: "", label: "Để thu mua chọn" }, ...supplierOptions]}
                      placeholder="Để thu mua chọn"
                    />
                  </div>
                </Field>

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
                  <input
                    value={requestForm.reason}
                    onChange={(e) => setRequestForm({ ...requestForm, reason: e.target.value })}
                    className="control"
                    required
                  />
                </Field>
              </div>

              {/* Danh sách dòng hàng: PR nhiều mặt hàng trong một phiếu */}
              <div className="space-y-3 border border-slate-100 rounded-lg p-3.5 bg-slate-50/50">
                <div className="flex items-center justify-between border-b border-slate-200/60 pb-2">
                  <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Mặt hàng cần mua</h3>
                  {/* PR dài thì dòng mới chèn lên ĐẦU danh sách cho khỏi kéo xuống cuối (khách 25/10/2026). */}
                  <button type="button" className="text-xs font-bold text-blue-600 hover:underline flex items-center gap-0.5" onClick={() => setRequestRows([emptyRequestRow(), ...requestRows])}>
                    <span className="material-symbols-outlined text-sm font-bold">add</span>Thêm dòng
                  </button>
                </div>
                {/* Điện thoại: thẻ từng dòng. Máy tính: dạng bảng (khách 22/10/2026 — thẻ 3 cột khó dò). */}
                <div className="grid gap-3 md:hidden">
                {requestRows.map((row, index) => {
                  const rowItem = data.items.find((item) => item.id === row.itemId);
                  const suggestion = row.itemId ? data.priceSuggestions[row.itemId] : undefined;
                  return (
                    <div key={row.uid} className="bg-white border border-slate-200 rounded-xl p-3 space-y-2 shadow-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Hàng #{index + 1}</span>
                        {requestRows.length > 1 && (
                          <button type="button" className="text-xs font-bold text-rose-600 hover:underline" onClick={() => setRequestRows(requestRows.filter((_, rowIndex) => rowIndex !== index))}>Xóa</button>
                        )}
                      </div>
                      <SearchableSelect
                        value={row.itemId}
                        onChange={(itemId) => pickRequestRowItem(index, itemId)}
                        options={itemOptions}
                        placeholder="Chọn mặt hàng..."
                      />
                      {rowItem && purchaseUnitOptions(rowItem.unit, rowItem.unitConversions).length > 1 && (
                        <select className="control !mt-0" value={row.unitCode || rowItem.unit} onChange={(e) => pickRequestRowUnit(index, e.target.value)} aria-label="ĐVT đặt hàng">
                          {purchaseUnitOptions(rowItem.unit, rowItem.unitConversions).map((option) => <option key={option.unitCode} value={option.unitCode}>{option.label}</option>)}
                        </select>
                      )}
                      <div className="grid grid-cols-2 gap-3">
                        <label className="block text-[11px] font-bold text-slate-600">Số lượng{rowItem ? ` (${row.unitCode || rowItem.unit})` : ""}
                          <QuantityInput className="control" value={row.quantity} required ariaLabel="Số lượng"
                            onChange={(quantity) => setRequestRows(requestRows.map((candidate, rowIndex) => rowIndex === index ? { ...candidate, quantity } : candidate))} />
                        </label>
                        <label className="block text-[11px] font-bold text-slate-600">Đơn giá dự kiến{rowItem ? ` (đ/${row.unitCode || rowItem.unit})` : ""}
                          <input type="number" min="0" step="any" inputMode="numeric" className="control" value={row.estimatedUnitCost} required
                            onChange={(e) => setRequestRows(requestRows.map((candidate, rowIndex) => rowIndex === index ? { ...candidate, estimatedUnitCost: e.target.value } : candidate))} />
                        </label>
                      </div>
                      {suggestion && (
                        <p className="text-[11px] text-slate-500">
                          Đề xuất <b className="text-slate-700">{unitPrice(suggestion.price)} đ/{rowItem?.unit}</b> {priceSourceLabel(suggestion)}.
                        </p>
                      )}
                      {rowItem?.requiresImage && (
                        <label className="block text-[11px] font-bold text-slate-600">URL hình ảnh (bắt buộc cho mặt hàng này)
                          <input type="url" className="control" placeholder="https://..." value={row.imageUrl} required
                            onChange={(e) => setRequestRows(requestRows.map((candidate, rowIndex) => rowIndex === index ? { ...candidate, imageUrl: e.target.value } : candidate))} />
                        </label>
                      )}
                    </div>
                  );
                })}
                </div>
                <div className="hidden md:block overflow-x-auto rounded-lg border border-slate-200 bg-white">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-[11px] uppercase text-slate-500">
                      <tr>
                        <th className="px-2 py-2 text-left w-8">#</th>
                        <th className="px-2 py-2 text-left min-w-[260px]">Mặt hàng</th>
                        <th className="px-2 py-2 text-left w-44">ĐVT đặt</th>
                        <th className="px-2 py-2 text-right w-28">Số lượng</th>
                        <th className="px-2 py-2 text-right w-36">Đơn giá dự kiến</th>
                        <th className="px-2 py-2 text-left w-48">NCC</th>
                        <th className="px-2 py-2 text-right w-32">Thành tiền</th>
                        <th className="px-2 py-2 w-10" />
                      </tr>
                    </thead>
                    <tbody>
                      {requestRows.map((row, index) => {
                        const rowItem = data.items.find((item) => item.id === row.itemId);
                        const suggestion = row.itemId ? data.priceSuggestions[row.itemId] : undefined;
                        const unit = row.unitCode || rowItem?.unit || "";
                        const rate = rowItem ? conversionRateForUnit(rowItem.unit, rowItem.unitConversions || [], unit) || 1 : 1;
                        const unitOptions = rowItem ? purchaseUnitOptions(rowItem.unit, rowItem.unitConversions) : [];
                        const patch = (changes: Partial<RequestRow>) => setRequestRows(requestRows.map((candidate, rowIndex) => rowIndex === index ? { ...candidate, ...changes } : candidate));
                        return (
                          <tr key={row.uid} className="border-t border-slate-100 align-top">
                            <td className="px-2 py-2 text-xs font-bold text-slate-400">{index + 1}</td>
                            <td className="px-2 py-1.5">
                              <SearchableSelect value={row.itemId} onChange={(itemId) => pickRequestRowItem(index, itemId)} options={itemOptions} placeholder="Chọn mặt hàng..." />
                              {rowItem?.requiresImage && (
                                <input type="url" className="control !mt-1" placeholder="URL hình ảnh (bắt buộc) https://..." value={row.imageUrl} required onChange={(e) => patch({ imageUrl: e.target.value })} />
                              )}
                            </td>
                            <td className="px-2 py-1.5">
                              {unitOptions.length > 1 ? (
                                <select className="control !mt-0" value={unit} onChange={(e) => pickRequestRowUnit(index, e.target.value)} aria-label="ĐVT đặt hàng">
                                  {unitOptions.map((option) => <option key={option.unitCode} value={option.unitCode}>{option.label}</option>)}
                                </select>
                              ) : <span className="block py-2 text-slate-600">{unit || "-"}</span>}
                            </td>
                            <td className="px-2 py-1.5">
                              <QuantityInput className="control !mt-0 text-right" value={row.quantity} required ariaLabel="Số lượng" onChange={(quantity) => patch({ quantity })} />
                            </td>
                            <td className="px-2 py-1.5">
                              <input type="number" min="0" step="any" inputMode="numeric" className="control !mt-0 text-right" value={row.estimatedUnitCost} required aria-label="Đơn giá dự kiến"
                                onChange={(e) => patch({ estimatedUnitCost: e.target.value })} />
                              {suggestion && (
                                <small className="mt-0.5 block text-right text-[11px] text-slate-500" title={`Đề xuất ${unitPrice(suggestion.price)} đ/${rowItem?.unit} ${priceSourceLabel(suggestion)}`}>
                                  Gợi ý {unitPrice(suggestion.price * rate)} đ/{unit}
                                </small>
                              )}
                            </td>
                            <td className="px-2 py-1.5">
                              <SearchableSelect
                                value={row.supplierCode || ""}
                                onChange={(supplierCode) => patch({ supplierCode })}
                                options={[{ value: "", label: "Theo NCC của phiếu" }, ...supplierOptions.filter((option) => option.value)]}
                                placeholder="Theo NCC của phiếu"
                                searchPlaceholder="Gõ tên hoặc mã NCC..."
                              />
                            </td>
                            <td className="px-2 py-2 text-right tabular-nums text-slate-700">{money(Number(row.quantity || 0) * Number(row.estimatedUnitCost || 0))}</td>
                            <td className="px-1 py-1.5 text-center">
                              {requestRows.length > 1 && (
                                <ActionIcon kind="delete" title="Xoá dòng" onClick={() => setRequestRows(requestRows.filter((_, rowIndex) => rowIndex !== index))} />
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <button type="button" className="w-full border-t border-slate-100 px-3 py-2 text-left text-xs font-bold text-blue-600 hover:bg-blue-50" onClick={() => setRequestRows([...requestRows, emptyRequestRow()])}>
                    + Thêm dòng
                  </button>
                </div>
                <p className="text-right text-xs font-bold text-slate-700">
                  Tạm tính: {money(requestRows.reduce((sum, row) => sum + Number(row.quantity || 0) * Number(row.estimatedUnitCost || 0), 0))} đ
                </p>
              </div>

              <div className="flex gap-2">
                {editingRequest && (
                  <button type="button" onClick={resetRequestForm} className="px-4 rounded-lg border border-slate-300 bg-white py-2 text-sm font-bold text-slate-600 hover:bg-slate-50">
                    Huỷ
                  </button>
                )}
                <button className="primary-button flex-1 xl:flex-none xl:min-w-[240px] xl:ml-auto">
                  <span className="material-symbols-outlined text-lg">{editingRequest ? "save" : "add"}</span>
                  {editingRequest ? "Lưu thay đổi" : "Tạo PR"}
                </button>
              </div>
            </form>
          )}

          <section className="table-panel shadow-sm">
            {/* Điện thoại: tiêu đề và nút xếp dọc, ẩn đoạn giải thích (từng bị ép thành cột chữ hẹp). */}
            <div className="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="min-w-0">
                <h2 className="font-bold">Danh sách PR</h2>
                <p className="hidden sm:block text-xs text-slate-500 mt-1">
                  Yêu cầu gửi lên chờ thu mua duyệt → lên PO. &quot;Giá dự kiến&quot; do hệ thống tự đề xuất, chỉ để tham khảo — giá chính thức theo bảng giá / báo giá NCC.
                </p>
              </div>
              <div className="flex flex-wrap items-center sm:justify-end gap-2 sm:shrink-0">
                {canCreate && !showRequestForm && !editingRequest && (
                  <button type="button" onClick={() => setShowRequestForm(true)} className="secondary-button bg-white whitespace-nowrap">
                    <span className="material-symbols-outlined text-lg">add</span>Tạo yêu cầu mua
                  </button>
                )}
                {canApprove && (
                  <button
                    type="button"
                    onClick={openPoModal}
                    disabled={supplierGroups.length === 0}
                    title={supplierGroups.length === 0 ? "Chưa có yêu cầu mua nào kèm báo giá để đặt hàng" : "Gom mặt hàng theo nhà cung cấp để tạo đơn đặt hàng"}
                    className="whitespace-nowrap flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white text-sm font-bold px-3 py-2"
                  >
                    <span className="material-symbols-outlined text-lg">local_shipping</span>
                    Tạo đơn đặt hàng
                  </button>
                )}
                <ExportExcelButton fileName="danh_sach_pr" sheetName="PR" />
                <button type="button" title="Tải lại" onClick={loadData} className="icon-button"><span className="material-symbols-outlined text-lg">refresh</span></button>
              </div>
            </div>

            {/* Lọc theo cửa hàng, phòng ban, trạng thái, khoảng ngày yêu cầu (khách yêu cầu 03/10/2026). */}
            <div className="px-4 sm:px-5 pb-4 grid grid-cols-2 lg:grid-cols-6 gap-3">
              <Field label="Cửa hàng">
                <select className="control" value={requestFilter.branchCode} onChange={(e) => setRequestFilter({ ...requestFilter, branchCode: e.target.value, departmentCode: "ALL" })}>
                  <option value="ALL">Tất cả cửa hàng</option>
                  {visibleStoreOptions(user).map((option) => <option key={option.code} value={option.code}>{storeLabel(option.code)}</option>)}
                </select>
              </Field>
              <Field label="Phòng ban">
                <select className="control" value={singleDepartment || requestFilter.departmentCode} disabled={Boolean(singleDepartment)} onChange={(e) => setRequestFilter({ ...requestFilter, departmentCode: e.target.value })}>
                  {!singleDepartment && <option value="ALL">Tất cả phòng ban</option>}
                  {data.departments
                    .filter((item) => !ownDepartments || ownDepartments.includes(item.code.toUpperCase()))
                    .filter((item) => requestFilter.branchCode === "ALL" || !item.branch || item.branch === "ALL" || item.branch === requestFilter.branchCode)
                    .map((item) => <option key={item.id} value={item.code}>{item.name}{item.branch && item.branch !== "ALL" && requestFilter.branchCode === "ALL" ? ` (${storeLabel(item.branch)})` : ""}</option>)}
                  {!ownDepartments && <option value="NONE">Chưa gán phòng ban</option>}
                </select>
              </Field>
              <Field label="Trạng thái">
                <select className="control" value={requestFilter.status} onChange={(e) => setRequestFilter({ ...requestFilter, status: e.target.value })}>
                  <option value="ALL">Tất cả trạng thái</option>
                  <option value="WAITING">Chờ thu mua duyệt</option>
                  <option value="ORDERED">Đã lên PO</option>
                  <option value="COMPLETED">Hoàn tất</option>
                  <option value="REJECTED">Bị từ chối</option>
                  <option value="CANCELLED">Đã huỷ</option>
                  <option value="DRAFT">Nháp</option>
                </select>
              </Field>
              <Field label="Từ ngày">
                <DateInput className="control" value={requestFilter.from} onChange={(value) => setRequestFilter({ ...requestFilter, from: value })} ariaLabel="Từ ngày" />
              </Field>
              <Field label="Đến ngày">
                <DateInput className="control" value={requestFilter.to} onChange={(value) => setRequestFilter({ ...requestFilter, to: value })} ariaLabel="Đến ngày" />
              </Field>
              <Field label="Tìm mã / lý do / mặt hàng">
                <input className="control" value={requestFilter.search} placeholder="Gõ để tìm..." onChange={(e) => setRequestFilter({ ...requestFilter, search: e.target.value })} />
              </Field>
            </div>
            <p className="px-4 sm:px-5 pb-3 text-xs text-slate-500">
              {requestList === null ? "Đang tải..." : <>Đang hiện <b>{filteredRequests.length}</b> yêu cầu · giá dự kiến <b>{money(filteredRequests.reduce((sum, request) => sum + requestTotal(request), 0))} đ</b>{requestList.truncated ? " — khoảng ngày quá rộng, chỉ hiện 2.000 phiếu mới nhất." : ""}</>}
            </p>

            {/* Mobile: thẻ PR — Desktop: bảng */}
            <div className="md:hidden px-3 pb-3 space-y-2.5">
              {filteredRequests.map((request) => (
                <div key={request.id} className="border border-slate-200 rounded-xl p-3.5 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <CopyableText value={request.code}><b>{request.code}</b></CopyableText>
                      <p className="text-xs text-slate-500">{new Date(request.requestDate).toLocaleDateString("vi-VN")} · {storeLabel(request.branchCode)} · {departmentName(request.departmentCode)}</p>
                    </div>
                    <span className={`status ${requestStatusStyle(request.status)} shrink-0`}>{requestStatusLabel(request.status)}</span>
                  </div>
                  <p className="text-sm text-slate-700">{request.reason}{request.warehouseCode ? <span className="text-xs text-slate-500"> · Kho {request.warehouseCode}</span> : null}{request.supplierName ? <span className="text-xs text-slate-500"> · NCC {request.supplierName}</span> : null}</p>
                  <LinesPreview items={request.lines.map((line) => `${line.item.name}: ${qtyText(line.quantity, line)}${line.note ? ` · ${line.note}` : ""}`)} />
                  {request.status === "REJECTED" && <p className="text-xs text-rose-700">Thu mua từ chối{request.rejectReason ? `: ${request.rejectReason}` : ""} — bấm Sửa để chỉnh và gửi lại, hoặc Huỷ phiếu.</p>}
                  <div className="flex items-center justify-between pt-1 border-t border-slate-100">
                    <b className="text-sm">{money(requestTotal(request))} đ</b>
                    <div className="flex items-center gap-1">
                      {canApprove && canApproveRequest(request) && (
                        <>
                          <ActionIcon kind="approve" title="Duyệt → lên PO" onClick={() => setApprovingRequest(request)} />
                          <ActionIcon kind="cancel" title="Từ chối (trả người đặt sửa)" onClick={() => void rejectRequest(request)} />
                        </>
                      )}
                      {canCreate && canCancelRequest(request) && (
                        <ActionIcon kind="cancel" title="Huỷ phiếu" onClick={() => void cancelRequest(request)} />
                      )}
                      <RowActions
                        session={user}
                        module={href}
                        compact
                        onEdit={() => startEditRequest(request)}
                        onDelete={() => {
                          setDeleteError(null);
                          setDeleteTarget({ type: "REQUEST", id: request.id, title: `Xoá đề nghị mua hàng ${request.code}?`, description: `${request.reason} · ${departmentName(request.departmentCode)}`, label: `đề nghị mua hàng ${request.code}` });
                        }}
                        editDisabledReason={requestLockReason(request)}
                        deleteDisabledReason={requestLockReason(request)}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="hidden md:block">
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
              {filteredRequests.map((request) => (
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
                    <LinesPreview items={request.lines.map((line) => `${line.item.name}: ${qtyText(line.quantity, line)}${line.imageUrl ? " · có hình" : ""}${line.note ? ` · ${line.note}` : ""}`)} />
                  </td>
                  <td className="cell text-right font-semibold">
                    {money(requestTotal(request))} đ
                  </td>
                  <td className="cell">
                    <span className={`status ${requestStatusStyle(request.status)}`}>{requestStatusLabel(request.status)}</span>
                    {request.status === "REJECTED" && request.rejectReason && <small className="text-rose-700">{request.rejectReason}</small>}
                    {request.warehouseCode && <small>Kho {request.warehouseCode}</small>}
                    {request.supplierName && <small>NCC {request.supplierName}</small>}
                  </td>
                  <td className="cell">
                    <div className="flex items-center justify-end gap-2">
                      {canApprove && canApproveRequest(request) && (
                        <>
                          <ActionIcon kind="approve" title="Duyệt → lên PO" onClick={() => setApprovingRequest(request)} />
                          <ActionIcon kind="cancel" title="Từ chối (trả người đặt sửa)" onClick={() => void rejectRequest(request)} />
                        </>
                      )}
                      {canCreate && canCancelRequest(request) && (
                        <ActionIcon kind="cancel" title="Huỷ phiếu" onClick={() => void cancelRequest(request)} />
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
            </div>
          </section>
        </div>
      )}

      {active === "quotes" && (
        <div className="space-y-5">
          {(canCreate || editingQuote) && (() => {
            const quoteLines = (editingQuote ? editingQuote.lines : selectedRequest?.lines || []) as Array<UnitFields & { itemId: string; quantity: number; item?: Item }>;
            const rows = quoteLines.map((line) => {
              const item = line.item || data.items.find((candidate) => candidate.id === line.itemId);
              // Giá gõ theo ĐVT đặt → nhân số lượng theo ĐVT đặt.
              const price = Number(quoteLineCosts[line.itemId] || 0);
              const vatCode = quoteLineVat[line.itemId] || "KKKNT";
              const before = Math.round(toPurchaseQuantity(line.quantity, line) * price);
              const vat = vatAmountOf(before, VAT_RATE_OPTIONS.find((option) => option.code === vatCode)?.rate ?? null);
              return { line, item, price, vatCode, before, vat };
            });
            const totalBefore = rows.reduce((sum, row) => sum + row.before, 0);
            const totalVat = rows.reduce((sum, row) => sum + row.vat, 0);
            return (
            <form onSubmit={submitQuote} className="bg-white border border-slate-200 rounded-lg p-4 sm:p-5 space-y-4 shadow-sm">
              <h2 className="font-bold text-slate-800">
                {editingQuote ? `Sửa báo giá của ${editingQuote.supplierName}` : "Nhập báo giá"}
              </h2>

              <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-3">
              <Field label="Yêu cầu mua">
                <select
                  value={editingQuote ? quoteForm.requestId : (selectedRequest?.id || "")}
                  onChange={(e) => { const value = e.target.value; setQuoteForm((form) => ({ ...form, requestId: value })); }}
                  className="control"
                  disabled={Boolean(editingQuote)}
                >
                  <option value="">-- Chọn yêu cầu mua --</option>
                  {quotableRequests.map((item) => (
                    <option key={item.id} value={item.id}>{item.code} - {item.reason}</option>
                  ))}
                </select>
              </Field>

              <Field label="Nhà cung cấp">
                <div className="mt-1.5">
                  <PartnerPicker
                    value={quoteForm.supplierCode}
                    onChange={pickSupplier}
                    options={supplierOptions}
                    placeholder="-- Chọn nhà cung cấp --"
                    disabled={Boolean(editingQuote)}
                    canCreate={canCreatePartner}
                    defaultPartnerType="SUPPLIER"
                    onCreated={onSupplierCreated}
                  />
                </div>
              </Field>

                <Field label="Giao trong (ngày)">
                  <input type="number" inputMode="numeric" value={quoteForm.deliveryDays} onChange={(e) => setQuoteForm({ ...quoteForm, deliveryDays: e.target.value })} className="control" />
                </Field>
                <Field label="Điều khoản">
                  <input value={quoteForm.paymentTerms} onChange={(e) => setQuoteForm({ ...quoteForm, paymentTerms: e.target.value })} className="control" />
                </Field>
              </div>

              {/* Chưa có yêu cầu nào thì nói rõ phải làm gì, thay vì để dropdown trống trơn. */}
              {!editingQuote && quotableRequests.length === 0 && (
                <p className="text-xs rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-800">
                  Chưa có yêu cầu mua nào để nhập báo giá. Hãy tạo yêu cầu ở tab{" "}
                  <button type="button" onClick={() => setActive("templates")} className="font-bold underline">Đặt theo mẫu</button> hoặc{" "}
                  <button type="button" onClick={() => setActive("requests")} className="font-bold underline">Yêu cầu mua</button> — gửi xong là báo giá được ngay, không cần duyệt.
                </p>
              )}

              {/* Lưới giá theo TỪNG mặt hàng của PR: đơn giá trước thuế, thành tiền trước thuế, thuế
                  suất, tiền thuế, sau thuế (khách yêu cầu 03/10/2026). Có Bảng giá NCC đang hiệu lực
                  thì đơn giá + thuế suất tự điền, vẫn sửa tay được. */}
              {rows.length > 0 && (
                <div className="border border-slate-200 rounded-lg overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-xs text-slate-500 uppercase border-b border-slate-200">
                      <tr>
                        {["Mặt hàng", "Số lượng", "Đơn giá trước thuế", "Thành tiền trước thuế", "Thuế suất", "Tiền thuế", "Thành tiền sau thuế"].map((label, index) => (
                          <th key={label} className={`px-3 py-2 font-bold whitespace-nowrap ${index === 0 ? "text-left" : index === 4 ? "text-center" : "text-right"}`}>{label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(({ line, item, before, vat, vatCode }) => (
                        <tr key={line.itemId} className="border-t border-slate-100 align-top">
                          <td className="px-3 py-2 min-w-[220px]">
                            <b className="text-slate-800">{item?.name || line.itemId}</b>
                            <small className="block text-slate-500">{item?.code}</small>
                            {quotePriceSource[line.itemId] && <small className="block text-emerald-700 font-semibold">Theo bảng giá {quotePriceSource[line.itemId]}</small>}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{qtyText(line.quantity, { ...line, item })}</td>
                          <td className="px-3 py-2 text-right">
                            <input
                              type="number"
                              min="0"
                              step="any"
                              inputMode="decimal"
                              className="control !mt-0 w-32 text-right"
                              placeholder={`đ/${purchaseLineUnit({ ...line, item }) || "ĐVT"}`}
                              value={quoteLineCosts[line.itemId] ?? ""}
                              onChange={(e) => setQuoteLineCosts({ ...quoteLineCosts, [line.itemId]: e.target.value })}
                              aria-label={`Đơn giá ${item?.name || line.itemId}`}
                            />
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{money(before)}</td>
                          <td className="px-3 py-2 text-center">
                            <select className="control !mt-0 w-24" value={vatCode} onChange={(e) => setQuoteLineVat({ ...quoteLineVat, [line.itemId]: e.target.value })} aria-label={`Thuế suất ${item?.name || line.itemId}`}>
                              {VAT_RATE_OPTIONS.map((option) => <option key={option.code} value={option.code}>{option.code}</option>)}
                            </select>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{money(vat)}</td>
                          <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap font-bold">{money(before + vat)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-slate-50 font-bold">
                      <tr className="border-t-2 border-slate-200">
                        <td className="px-3 py-2" colSpan={3}>Cộng</td>
                        <td className="px-3 py-2 text-right tabular-nums">{money(totalBefore)}</td>
                        <td />
                        <td className="px-3 py-2 text-right tabular-nums">{money(totalVat)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{money(totalBefore + totalVat)} đ</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}

              {/* Trên điện thoại thông báo đầu trang nằm khuất — báo lại ngay cạnh nút (chưa chọn NCC, dòng giá 0...). */}
              {message && <p className="px-3 py-2 rounded-lg border border-amber-200 bg-amber-50 text-sm text-amber-800">{message}</p>}

              <div className="flex gap-2 justify-end">
                {editingQuote && (
                  <button type="button" onClick={resetQuoteForm} className="px-4 rounded-lg border border-slate-300 bg-white py-2 text-sm font-bold text-slate-600 hover:bg-slate-50">
                    Huỷ
                  </button>
                )}
                <button className="primary-button min-w-[200px] disabled:bg-slate-300 disabled:cursor-not-allowed" disabled={!editingQuote && !selectedRequest}>
                  <span className="material-symbols-outlined text-lg">{editingQuote ? "save" : "add"}</span>
                  {editingQuote ? "Lưu thay đổi" : "Thêm báo giá"}
                </button>
              </div>
            </form>
            );
          })()}

          <section className="space-y-4 min-w-0">
            <div className="table-panel shadow-sm p-4 flex flex-wrap items-end justify-between gap-3">
              <DateRangeFilter label="Ngày yêu cầu mua" value={quoteRange} onChange={setQuoteRange} />
              <p className="text-xs text-slate-500">{quotedRequests.length} yêu cầu có báo giá{!quoteRange.from && !quoteRange.to ? " (trong 100 yêu cầu mới nhất)" : ""}</p>
            </div>
            {quotedRequests.map((request) => {
              /** Giá rẻ nhất từng mặt hàng để tô nổi trong ma trận so sánh. */
              const bestCost = new Map<string, number>();
              for (const line of request.lines) {
                const costs = request.quotes
                  .map((quote) => quote.lines.find((quoteLine) => quoteLine.itemId === line.itemId)?.unitCost || 0)
                  .filter((cost) => cost > 0);
                if (costs.length > 0) bestCost.set(line.itemId, Math.min(...costs));
              }
              return (
              <div key={request.id} className="table-panel shadow-sm p-4">
                <div className="flex items-center justify-between gap-2 pb-3 mb-3 border-b border-slate-100">
                  <div className="min-w-0">
                    <b><CopyableText value={request.code} /> — {request.reason}</b>
                    <LinesPreview items={request.lines.map((line) => `${line.item.name} (${qtyText(line.quantity, line)})${line.note ? ` · ${line.note}` : ""}`)} />
                  </div>
                  <span className={`status ${requestStatusStyle(request.status)} shrink-0`}>{requestStatusLabel(request.status)}</span>
                </div>

                {/* PR đã lên đơn: báo giá bị khoá — đưa luôn thao tác gửi NCC / huỷ đơn ra đây để khỏi phải đi tìm. */}
                {liveOrdersOf(request).map((order) => (
                  <div key={order.id} className="mb-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-sky-900">
                    <span className="material-symbols-outlined text-base">local_shipping</span>
                    <span className="flex-1 min-w-[200px]">
                      Đã lên đơn <b>{order.code}</b> với <b>{order.supplierName}</b> · <span className={`status ${orderStatusStyle(order.status)}`}>{orderStatusLabel(order.status)}</span>
                      {order.shareToken && <span className="ml-1 text-sky-700">· đã gửi NCC</span>}
                      <span className="block text-sky-700/80">Muốn sửa/xoá báo giá: huỷ đơn trước.</span>
                    </span>
                    {canCreate && (
                      <button onClick={() => sharePO(order)} className="action-link text-sky-700 hover:underline font-bold">
                        {order.status === "DRAFT" ? "Duyệt & gửi NCC" : order.shareToken ? "Gửi lại NCC" : "Gửi NCC"}
                      </button>
                    )}
                    {canApprove && canCancelOrder(order) && (
                      <ActionIcon kind="cancel" title="Huỷ đơn" onClick={() => void cancelOrder(order)} />
                    )}
                  </div>
                ))}

                <div className="overflow-x-auto max-h-[300px] overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-xs text-slate-500 uppercase border-b border-slate-200 sticky top-0 z-10">
                      <tr>
                        <th className="px-3 py-2 text-left">Nhà cung cấp</th>
                        <th className="px-3 py-2 text-right">Trước thuế</th>
                        <th className="px-3 py-2 text-right">Thuế GTGT</th>
                        <th className="px-3 py-2 text-right">Sau thuế</th>
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
                            {quote.isSelected && <span className="status bg-emerald-50 text-emerald-700 ml-1.5">Đã chốt giá</span>}
                            <small>{quote.supplierCode}</small>
                          </td>
                          <td className="cell text-right font-bold">{money(quote.totalAmount)} đ</td>
                          <td className="cell text-right">{money(quoteVatTotal(quote))} đ</td>
                          <td className="cell text-right font-bold">{money(quote.totalAmount + quoteVatTotal(quote))} đ</td>
                          <td className="cell text-center">{quote.deliveryDays ? `${quote.deliveryDays} ngày` : "N/A"}</td>
                          <td className="cell">{quote.paymentTerms || "N/A"}</td>
                          <td className="cell">
                            <div className="flex items-center justify-end gap-2">
                              {canApprove && !quote.isSelected && (
                                <button onClick={() => void send("PATCH", { action: "SELECT_QUOTE", quoteId: quote.id }, `Đã chốt giá với ${quote.supplierName}.`)} className="action-link text-emerald-700 hover:underline">
                                  Chốt giá
                                </button>
                              )}
                              {canApprove && quote.isSelected && (
                                <button onClick={() => void send("PATCH", { action: "UNSELECT_QUOTE", quoteId: quote.id }, `Đã bỏ chốt giá với ${quote.supplierName}.`)} className="action-link text-slate-500 hover:underline">
                                  Bỏ chốt
                                </button>
                              )}
                              {canApprove && !requestHasOrder(request) && (
                                <button onClick={() => void createOrder(request, quote)} className="action-link text-blue-700 hover:underline">
                                  Chọn &amp; Tạo PO
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

                {/* Ma trận so sánh giá theo từng mặt hàng khi có từ 2 báo giá */}
                {request.quotes.length >= 2 && request.lines.length > 0 && (
                  <div className="mt-3 border-t border-slate-100 pt-3">
                    <p className="text-xs font-bold text-slate-600 uppercase tracking-wider mb-2">So sánh giá từng mặt hàng <span className="font-normal normal-case text-slate-400">(ô xanh = rẻ nhất)</span></p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50 text-xs text-slate-500 border-b border-slate-200">
                          <tr>
                            <th className="px-3 py-2 text-left">Mặt hàng</th>
                            {request.quotes.map((quote) => (
                              <th key={quote.id} className="px-3 py-2 text-right whitespace-nowrap">
                                {quote.supplierName}{quote.isSelected ? " ★" : ""}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {request.lines.map((line) => (
                            <tr key={line.itemId} className="border-t border-slate-100">
                              <td className="px-3 py-1.5">{line.item.name} <small className="text-slate-400">× {qtyText(line.quantity, line)}</small>{line.note ? <small className="block text-amber-700">{line.note}</small> : null}</td>
                              {request.quotes.map((quote) => {
                                const quoteLine = quote.lines.find((candidate) => candidate.itemId === line.itemId);
                                const cost = quoteLine?.unitCost || 0;
                                const best = cost > 0 && bestCost.get(line.itemId) === cost;
                                return (
                                  <td key={quote.id} className={`px-3 py-1.5 text-right ${best ? "bg-emerald-50 text-emerald-800 font-bold" : ""}`}>
                                    {cost > 0 && quoteLine ? `${unitPrice(toPurchasePrice(cost, quoteLine))} đ/${purchaseLineUnit({ ...quoteLine, item: line.item })}` : "-"}
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                          <tr className="border-t-2 border-slate-200 font-bold">
                            <td className="px-3 py-2">Tổng theo NCC</td>
                            {request.quotes.map((quote) => (
                              <td key={quote.id} className="px-3 py-2 text-right">{money(quote.totalAmount)} đ</td>
                            ))}
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
              );
            })}
          </section>
        </div>
      )}

      {active === "orders" && (
        <section className="table-panel shadow-sm">
          <div className="p-4 sm:p-5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-bold">Đơn mua hàng (PO)</h2>
              <p className="text-xs text-slate-500 mt-1">Duyệt PO → &quot;Gửi NCC&quot; gửi phiếu thẳng qua Zalo / email / SMS → nhận hàng tại đây hoặc ở Kho &amp; Định lượng. Không đặt nữa thì &quot;Huỷ đơn&quot;.</p>
            </div>
            <div className="flex items-center gap-2">
              <ExportExcelButton fileName="don_mua_hang" sheetName="PO" />
              <button type="button" title="Tải lại" onClick={loadData} className="icon-button"><span className="material-symbols-outlined text-lg">refresh</span></button>
            </div>
          </div>

          {/* Lọc theo cửa hàng, phòng ban, trạng thái, ngày đặt, đã gửi NCC chưa (khách yêu cầu 03/10/2026). */}
          <div className="px-4 sm:px-5 pt-4 grid grid-cols-2 lg:grid-cols-7 gap-3">
            <Field label="Cửa hàng">
              <select className="control" value={orderFilter.branchCode} onChange={(e) => setOrderFilter({ ...orderFilter, branchCode: e.target.value, departmentCode: "ALL" })}>
                <option value="ALL">Tất cả cửa hàng</option>
                {visibleStoreOptions(user).map((option) => <option key={option.code} value={option.code}>{storeLabel(option.code)}</option>)}
              </select>
            </Field>
            <Field label="Phòng ban">
              <select className="control" value={singleDepartment || orderFilter.departmentCode} disabled={Boolean(singleDepartment)} onChange={(e) => setOrderFilter({ ...orderFilter, departmentCode: e.target.value })}>
                {!singleDepartment && <option value="ALL">Tất cả phòng ban</option>}
                {data.departments
                  .filter((item) => !ownDepartments || ownDepartments.includes(item.code.toUpperCase()))
                  .filter((item) => orderFilter.branchCode === "ALL" || !item.branch || item.branch === "ALL" || item.branch === orderFilter.branchCode)
                  .map((item) => <option key={item.id} value={item.code}>{item.name}{item.branch && item.branch !== "ALL" && orderFilter.branchCode === "ALL" ? ` (${storeLabel(item.branch)})` : ""}</option>)}
                {!ownDepartments && <option value="NONE">Chưa gán phòng ban</option>}
              </select>
            </Field>
            <Field label="Trạng thái">
              <select className="control" value={orderFilter.status} onChange={(e) => setOrderFilter({ ...orderFilter, status: e.target.value })}>
                <option value="ALL">Tất cả trạng thái</option>
                {["DRAFT", "APPROVED", "PARTIALLY_RECEIVED", "COMPLETED", "CANCELLED"].map((status) => <option key={status} value={status}>{orderStatusLabel(status)}</option>)}
              </select>
            </Field>
            <Field label="Gửi NCC">
              <select className="control" value={orderFilter.sent} onChange={(e) => setOrderFilter({ ...orderFilter, sent: e.target.value })}>
                <option value="ALL">Tất cả</option>
                <option value="YES">Đã gửi NCC</option>
                <option value="NO">Chưa gửi NCC</option>
              </select>
            </Field>
            <Field label="Từ ngày">
              <DateInput className="control" value={orderFilter.from} onChange={(value) => setOrderFilter({ ...orderFilter, from: value })} ariaLabel="Từ ngày" />
            </Field>
            <Field label="Đến ngày">
              <DateInput className="control" value={orderFilter.to} onChange={(value) => setOrderFilter({ ...orderFilter, to: value })} ariaLabel="Đến ngày" />
            </Field>
            <Field label="Tìm mã / NCC / mặt hàng">
              <input className="control" value={orderFilter.search} placeholder="Gõ để tìm..." onChange={(e) => setOrderFilter({ ...orderFilter, search: e.target.value })} />
            </Field>
          </div>
          <p className="px-4 sm:px-5 py-3 text-xs text-slate-500 border-b border-slate-100">
            {orderList === null ? "Đang tải..." : <>Đang hiện <b>{filteredOrders.length}</b> đơn · tổng tiền <b>{money(filteredOrders.reduce((sum, order) => sum + order.totalAmount, 0))} đ</b> · đã gửi NCC <b>{filteredOrders.filter((order) => order.shareToken).length}</b>{orderList.truncated ? " — khoảng ngày quá rộng, chỉ hiện 2.000 đơn mới nhất." : ""}</>}
          </p>

          {/* Mobile: thẻ PO — Desktop: bảng */}
          <div className="md:hidden px-3 py-3 space-y-2.5">
            {filteredOrders.map((order) => {
              const totalOrdered = order.lines.reduce((sum, line) => sum + line.orderedQuantity, 0);
              const totalReceived = order.lines.reduce((sum, line) => sum + line.receivedQuantity, 0);
              return (
                <div key={order.id} className="border border-slate-200 rounded-xl p-3.5 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <CopyableText value={order.code}><b>{order.code}</b></CopyableText>
                      <p className="text-xs text-slate-500">{new Date(order.orderDate).toLocaleDateString("vi-VN")} · {storeLabel(order.branchCode)} · {order.warehouseCode}</p>
                    </div>
                    <span className={`status ${orderStatusStyle(order.status)} shrink-0`}>{orderStatusLabel(order.status)}</span>
                  </div>
                  <p className="text-sm font-semibold text-slate-800">{order.supplierName}</p>
                  <LinesPreview items={order.lines.map((line) => `${line.item.name} (${qty(toPurchaseQuantity(line.receivedQuantity, line))}/${qtyText(line.orderedQuantity, line)})`)} />
                  <div className="flex items-center justify-between pt-1 border-t border-slate-100">
                    <div>
                      <b className="text-sm">{money(order.totalAmount)} đ</b>
                      <p className="text-[11px] text-slate-500">Đã nhận {qty(totalReceived)}/{qty(totalOrdered)}</p>
                    </div>
                    <div className="flex items-center gap-1.5 flex-wrap justify-end">
                      {canApprove && order.status === "DRAFT" && (
                        <ActionIcon kind="approve" title="Duyệt PO" onClick={() => void send("PATCH", { action: "APPROVE_ORDER", orderId: order.id }, "Đã duyệt PO.")} />
                      )}
                      {canApprove && order.status === "APPROVED" && totalReceived === 0 && !order.payable && (
                        <ActionIcon kind="reopen" title="Bỏ duyệt (mở lại để sửa)" onClick={() => {
                            if (!window.confirm(`Bỏ duyệt đơn ${order.code}? Đơn quay về Nháp để sửa, và link đã gửi nhà cung cấp sẽ bị thu hồi.`)) return;
                            void send("PATCH", { action: "UNAPPROVE_ORDER", orderId: order.id }, `Đã bỏ duyệt ${order.code}. Sửa lại rồi duyệt PO lần nữa.`);
                          }} />
                      )}
                      {canCreate && (order.status !== "CANCELLED" || order.shareToken) && (
                        <button onClick={() => sharePO(order)} className={`rounded-lg text-xs font-bold px-3 py-2 inline-flex items-center gap-1 ${notSentYet(order) ? "bg-red-600 text-white" : "bg-sky-50 text-sky-700"}`}>
                          <span className="material-symbols-outlined text-sm">send</span>
                          {sendLabel(order)}
                        </button>
                      )}
                      {canApprove && canCancelOrder(order) && (
                        <ActionIcon kind="cancel" title="Huỷ đơn" onClick={() => void cancelOrder(order)} />
                      )}
                      {canEdit && ["APPROVED", "PARTIALLY_RECEIVED"].includes(order.status) && (
                        <button onClick={() => startReceiving(order)} className="rounded-lg bg-emerald-600 text-white text-xs font-bold px-3 py-2">Nhận hàng</button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="hidden md:block">
          <Table
            headers={[
              { label: "Mã PO" },
              { label: "Nhà cung cấp" },
              { label: "Cửa hàng/Kho" },
              { label: "Phòng ban" },
              { label: "Tổng tiền", align: "right" },
              { label: "Trạng thái" },
              { label: "Tài sản/CCDC" },
              { label: "Công nợ phát sinh", align: "right" },
              { label: "Thao tác", align: "right" },
            ]}
          >
            {filteredOrders.map((order) => {
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
                    <LinesPreview items={order.lines.map((line) => `${line.item.name} (${qty(toPurchaseQuantity(line.receivedQuantity, line))}/${qtyText(line.orderedQuantity, line)})`)} />
                  </td>
                  <td className="cell">
                    <b>{storeLabel(order.branchCode)}</b>
                    <small>Kho: {order.warehouseCode}</small>
                  </td>
                  <td className="cell">
                    <b>{order.departmentCode ? departmentName(order.departmentCode) : <span className="text-slate-400 font-normal">Chưa gán</span>}</b>
                    {order.departmentCode && <small>{order.departmentCode}</small>}
                  </td>
                  <td className="cell text-right font-bold">{money(order.totalAmount)} đ</td>
                  <td className="cell">
                    <span className={`status ${orderStatusStyle(order.status)}`}>{orderStatusLabel(order.status)}</span>
                    <small className="block mt-0.5 text-[10px] text-slate-500">Đã nhận: {totalReceived}/{totalOrdered}</small>
                    <small className={`block text-[10px] font-semibold ${order.shareToken ? "text-sky-700" : "text-slate-400"}`}>{order.shareToken ? "Đã gửi NCC" : "Chưa gửi NCC"}</small>
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
                        <ActionIcon kind="approve" title="Duyệt PO" onClick={() => void send("PATCH", { action: "APPROVE_ORDER", orderId: order.id }, "Đã duyệt PO.")} />
                      )}
                      {canApprove && order.status === "APPROVED" && order.lines.every((line) => line.receivedQuantity === 0) && !order.payable && (
                        <ActionIcon kind="reopen" title="Bỏ duyệt (mở lại để sửa)" onClick={() => {
                            if (!window.confirm(`Bỏ duyệt đơn ${order.code}? Đơn quay về Nháp để sửa, và link đã gửi nhà cung cấp sẽ bị thu hồi.`)) return;
                            void send("PATCH", { action: "UNAPPROVE_ORDER", orderId: order.id }, `Đã bỏ duyệt ${order.code}. Sửa lại rồi duyệt PO lần nữa.`);
                          }} />
                      )}
                      {canCreate && (order.status !== "CANCELLED" || order.shareToken) && (
                        <button onClick={() => sharePO(order)} className={`action-link hover:underline ${notSentYet(order) ? "text-red-600 font-bold" : "text-sky-700"}`} title="Gửi phiếu đặt hàng cho NCC qua Zalo / email / SMS / ảnh">
                          {sendLabel(order)}
                        </button>
                      )}
                      {canApprove && canCancelOrder(order) && (
                        <ActionIcon kind="cancel" title="Huỷ đơn" onClick={() => void cancelOrder(order)} />
                      )}
                      {canCreate && order.shareToken && (
                        <button onClick={() => void revokeShare(order)} className="action-link text-slate-500 hover:underline" title="Thu hồi link đã gửi NCC">
                          Thu hồi link
                        </button>
                      )}
                      {canEdit && ["APPROVED", "PARTIALLY_RECEIVED"].includes(order.status) && (
                        <button onClick={() => startReceiving(order)} className="action-link text-emerald-700 hover:underline">
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
          </div>
        </section>
      )}

      {poModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-3xl shadow-xl max-h-[90vh] flex flex-col">
            <div className="p-5 border-b border-slate-200 flex items-start justify-between gap-3">
              <div>
                <h3 className="font-bold text-slate-900">Tạo đơn đặt hàng theo nhà cung cấp</h3>
                <p className="text-sm text-slate-500 mt-1">
                  Mặt hàng từ các PR đã duyệt được gom theo nhà cung cấp báo giá. Chọn nhà cung cấp muốn đặt để tạo PO nháp.
                </p>
              </div>
              <button type="button" onClick={() => setPoModalOpen(false)} className="icon-button" title="Đóng">
                <span className="material-symbols-outlined text-lg">close</span>
              </button>
            </div>

            <div className="p-5 space-y-4 overflow-y-auto">
              {supplierGroups.length === 0 && (
                <p className="text-sm text-slate-500">
                  Không còn PR đã duyệt kèm báo giá để đặt hàng. Hãy duyệt PR và nhập báo giá ở tab So sánh giá trước.
                </p>
              )}
              {supplierGroups.map((group) => {
                const groupTotal = group.entries.reduce((sum, entry) => sum + entry.quote.totalAmount, 0);
                return (
                  <div key={group.supplierCode} className="border border-slate-200 rounded-lg overflow-hidden">
                    <div className="px-4 py-3 bg-slate-50 flex items-center justify-between gap-3">
                      <div>
                        <b className="text-slate-800">{group.supplierName}</b>
                        <span className="text-xs text-slate-500 ml-2">{group.supplierCode}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-bold text-slate-700">{money(groupTotal)} đ</span>
                        <button
                          type="button"
                          disabled={creatingOrders}
                          onClick={() => void createOrdersForSupplier(group)}
                          className="rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white text-xs font-bold px-3 py-1.5"
                        >
                          {creatingOrders ? "Đang tạo..." : "Đặt hàng NCC này"}
                        </button>
                      </div>
                    </div>
                    <table className="w-full text-sm">
                      <thead className="bg-white text-xs text-slate-500 uppercase border-y border-slate-100">
                        <tr>
                          <th className="px-4 py-2 text-left">PR / Cửa hàng</th>
                          <th className="px-4 py-2 text-left">Mặt hàng</th>
                          <th className="px-4 py-2 text-right">Thành tiền</th>
                          <th className="px-4 py-2 text-left">Kho nhận</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.entries.map(({ request, quote }) => (
                          <tr key={`${group.supplierCode}-${request.id}`} className="border-t border-slate-100 align-top">
                            <td className="px-4 py-2">
                              <b>{request.code}</b>
                              <small className="block text-slate-500">{storeLabel(request.branchCode)}</small>
                            </td>
                            <td className="px-4 py-2 text-slate-600">
                              {quote.lines.map((line) => {
                                const item = line.item || data.items.find((candidate) => candidate.id === line.itemId);
                                return `${item?.name || line.itemId}: ${qtyText(line.quantity, { ...line, item })} × ${unitPrice(toPurchasePrice(line.unitCost, line))} đ`;
                              }).join(", ")}
                            </td>
                            <td className="px-4 py-2 text-right font-semibold">{money(quote.totalAmount)} đ</td>
                            <td className="px-4 py-2">
                              <select
                                value={poWarehouseByRequest[request.id] || suggestedWarehouseForRequest(request)}
                                onChange={(e) => setPoWarehouseByRequest({ ...poWarehouseByRequest, [request.id]: e.target.value })}
                                className="control py-1 px-2 text-xs"
                              >
                                {warehousesForBranch(request.branchCode).map((warehouse) => (
                                  <option key={warehouse.id} value={warehouse.code}>{warehouse.name} ({warehouse.code})</option>
                                ))}
                              </select>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {approvingRequest && (
        <ApproveRequestDialog
          request={approvingRequest}
          supplierOptions={supplierOptions}
          warehouses={warehousesForBranch(approvingRequest.branchCode)}
          defaultWarehouse={suggestedWarehouseForRequest(approvingRequest)}
          canCreatePartner={canCreatePartner}
          onSupplierCreated={(partner) => setData((current) => ({ ...current, suppliers: [...current.suppliers, { id: partner.id, code: partner.code, name: partner.name }] }))}
          onClose={() => setApprovingRequest(null)}
          onApproved={async (text) => {
            setApprovingRequest(null);
            setMessage(text);
            await loadData();
          }}
        />
      )}

      {receivingOrder && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-end sm:items-center justify-center sm:p-4">
          <div className="bg-white rounded-t-2xl sm:rounded-xl w-full max-w-lg lg:max-w-[1200px] shadow-xl max-h-[92vh] flex flex-col">
            <div className="p-5 border-b border-slate-200 flex items-start justify-between gap-3">
              <div>
                <h3 className="font-bold text-slate-900">Nhận hàng từ {receivingOrder.code}</h3>
                <p className="text-sm text-slate-500 mt-1">
                  {receivingOrder.supplierName} · nhập kho <b>{receivingOrder.warehouseCode}</b>. Sửa số lượng theo thực nhận (giao thiếu hoặc thừa đều được); dòng để 0 sẽ nhận sau. NCC giao thêm hàng thì thêm dòng ở cuối bảng.
                </p>
              </div>
              <button type="button" onClick={() => setReceivingOrder(null)} className="icon-button" title="Đóng">
                <span className="material-symbols-outlined text-lg">close</span>
              </button>
            </div>

            <div className="p-4 sm:p-5 space-y-3 overflow-y-auto">
              <div className="grid grid-cols-2 gap-2">
                <label className="block text-xs font-bold text-slate-600">Ngày nhận
                  <DateInput value={receiveDate} onChange={setReceiveDate} className="control" ariaLabel="Ngày nhận hàng" />
                </label>
                <label className="block text-xs font-bold text-slate-600">Chi phí mua hàng (đ)
                  <MoneyInput className="control text-right" value={receivePurchaseCost} onChange={setReceivePurchaseCost} placeholder="0 nếu không có" ariaLabel="Chi phí mua hàng" />
                </label>
                <p className="col-span-2 text-[11px] text-slate-500">Chi phí vận chuyển, bốc xếp... (nếu có) được phân bổ vào giá nhập theo tiền hàng từng dòng và cộng vào công nợ NCC của PO.</p>
              </div>
              <PurchaseReceiveLines
                lines={[...receiveLineInfos(receivingOrder), ...receiveExtraInfos()]}
                values={receiveLineValues(receivingOrder)}
                onChange={patchReceiveLine}
                purchaseCost={Number(receivePurchaseCost || 0) || 0}
                addOptions={data.items.map((item) => ({ value: item.id, label: `${item.name} (${item.code})`, subLabel: item.unit }))}
                onAdd={addReceiveExtra}
              />
              {receivingOrder.lines.some((line) => ["TOOL", "ASSET"].includes(line.item.itemType)) && (
                <p className="text-xs rounded-lg bg-indigo-50 border border-indigo-100 text-indigo-800 px-3 py-2">
                  Dòng Tài sản/CCDC sẽ vào sổ <b>Tài sản &amp; Khấu hao</b> (không cộng tồn kho); các dòng còn lại sinh phiếu Nhập mua ở Kho &amp; Định lượng.
                </p>
              )}
              <label className="block text-xs font-bold text-slate-600">Ghi chú
                <input className="control" value={receiveNote} onChange={(e) => setReceiveNote(e.target.value)} placeholder="VD: giao thiếu 2kg, nhận phần còn lại sau" />
              </label>
            </div>

            <div className="p-4 sm:p-5 border-t border-slate-200 space-y-2">
              {receiveError && <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">{receiveError}</p>}
              {(() => {
                // Công nợ NCC tăng thêm lần nhận này = Σ thành tiền sau thuế (đã trừ chiết khấu) + chi phí mua hàng.
                const { total } = receiveFigures([...receiveLineInfos(receivingOrder), ...receiveExtraInfos()], receiveLineValues(receivingOrder), Number(receivePurchaseCost || 0) || 0);
                return (
                  <p className="text-xs text-slate-600 text-right">
                    Sau thuế <b>{money(total.afterTax)} đ</b>{total.costShare > 0 ? <> + chi phí <b>{money(total.costShare)} đ</b></> : null} = công nợ NCC <b className="text-slate-900">{money(total.purchaseValue)} đ</b>
                  </p>
                );
              })()}
              <div className="flex gap-2">
              <button type="button" onClick={() => setReceivingOrder(null)} className="secondary-button">Huỷ</button>
              <button type="button" disabled={receiving} onClick={() => void submitReceive()} className="primary-button flex-1 !min-h-12">
                <span className="material-symbols-outlined text-lg">inventory</span>
                {receiving ? "Đang nhận hàng..." : "Xác nhận nhận hàng"}
              </button>
              </div>
            </div>
          </div>
        </div>
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
                  {data.warehouses.length === 0 && (
                    <>
                      <option value="KHO_HCM">Kho Cửa hàng 1 (KHO_HCM)</option>
                      <option value="KHO_HN">Kho Cửa hàng 2 (KHO_HN)</option>
                    </>
                  )}
                  {data.warehouses.map((warehouse) => (
                    <option key={warehouse.id} value={warehouse.code}>{warehouse.name} ({warehouse.code})</option>
                  ))}
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

      {sendingOrder && (
        <SendPurchaseOrderDialog
          key={sendingOrder.id + sendingOrder.status}
          order={sendingOrder}
          contact={data.suppliers.find((supplier) => supplier.code === sendingOrder.supplierCode) || {}}
          canApprove={canApprove}
          onClose={() => setSendingOrder(null)}
          onChanged={loadData}
        />
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
