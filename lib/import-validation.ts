import { prisma, prismaRaw } from "@/lib/prisma";
import { assertBranchAccess } from "@/lib/accounting";
import { isMasterDataImportType, normalizeHeader, type ImportType } from "@/lib/import-templates";
import type { ParsedImportResult, ParsedImportRow } from "@/lib/import-parser";
import type { DemoSession } from "@/lib/auth-demo";
import { isInboundStockType, isOutboundStockType, isStockTransactionType, normalizeStockTransactionType } from "@/lib/inventory-stock";
import { normalizeCashflowCategoryType } from "@/lib/voucher-rules";
import { ensureRevenuePosReference, revenuePosReferenceKey } from "@/lib/revenue-pos-reference";
import { groupBankStatementRows } from "@/lib/bank-statement-import";
import { isPeriodLocked } from "@/lib/phase3";
import { normalizeMoneySourceGroup } from "@/lib/money-sources";
import {
  parseSettlementRevenueRange,
  resolveWalletFromDescription,
  walletKeywordsInText,
} from "@/lib/bank-statement-wallet-hints";
import { selectWalletDeclaredRevenue, walletRevenueBucket } from "@/lib/wallet-revenue-reconciliation";
import { vietnamBusinessDayBounds, vietnamBusinessDayKey } from "@/lib/revenue-date";

type MasterItem = {
  type: string;
  code: string;
  name: string;
  group?: string | null;
  partnerType?: string | null;
  branch: string | null;
  status: string;
  accountNo?: string | null;
  settlementBankCode?: string | null;
};

function text(value: unknown) {
  return String(value || "").trim();
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeChoice(value: unknown, choices: Record<string, string>) {
  const normalized = normalizeHeader(text(value));
  return choices[normalized] || text(value).toUpperCase();
}

function normalizeItemType(value: unknown) {
  const normalized = normalizeHeader(text(value));
  const choices: Record<string, string> = {
    material: "RAW_MATERIAL",
    raw: "RAW_MATERIAL",
    nvl: "RAW_MATERIAL",
    "nguyen lieu": "RAW_MATERIAL",
    raw_material: "RAW_MATERIAL",
    btp: "SEMI_FINISHED",
    semi: "SEMI_FINISHED",
    "ban thanh pham": "SEMI_FINISHED",
    semi_finished: "SEMI_FINISHED",
    tp: "FINISHED",
    product: "FINISHED",
    "thanh pham": "FINISHED",
    finished: "FINISHED",
    packaging: "PACKAGING",
    baobi: "PACKAGING",
    "bao bi": "PACKAGING",
    tool: "TOOL",
    ccdc: "TOOL",
    asset: "ASSET",
    "tai san": "ASSET",
  };
  return choices[normalized] || text(value).toUpperCase();
}

function resolveMaster(
  items: MasterItem[],
  type: string,
  rawValue: unknown,
  branchCode?: string,
) {
  const value = text(rawValue);
  if (!value) return null;
  const normalized = normalizeHeader(value);
  const requestedBranch = text(branchCode).toUpperCase();
  const candidates = items.filter(
    (item) => item.type === type && item.status === "ACTIVE" &&
      (item.code.toUpperCase() === value.toUpperCase() || normalizeHeader(item.name) === normalized),
  );
  if (!requestedBranch || requestedBranch === "ALL") return candidates[0] || null;
  return candidates.find((item) => text(item.branch).toUpperCase() === requestedBranch) ||
    candidates.find((item) => !item.branch || text(item.branch).toUpperCase() === "ALL") ||
    null;
}

function addError(row: ParsedImportRow, message: string) {
  if (!row.errors.includes(message)) row.errors.push(message);
}

function validatePeriod(row: ParsedImportRow, field: string, label: string) {
  const value = text(row.values[field]);
  if (value && !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) addError(row, `${label} phải có dạng YYYY-MM`);
}

/**
 * Máy bán hàng ghi tên cửa hàng đầy đủ ("NAM MÊ Kitchen & Bar") thay vì mã ("NME"), nên khớp
 * thêm theo tên bắt đầu bằng tên trong danh mục. Chỉ nhận khi đúng một cửa hàng khớp, để không
 * đoán nhầm khi có hai cửa hàng tên gần giống nhau.
 */
function resolveBranchByName(masterItems: MasterItem[], rawValue: string) {
  const normalized = normalizeHeader(rawValue);
  if (!normalized) return null;
  const matches = masterItems.filter((item) => {
    if (item.type !== "BRANCH" || item.status !== "ACTIVE") return false;
    const name = normalizeHeader(item.name);
    return Boolean(name) && normalized.startsWith(name);
  });
  return matches.length === 1 ? matches[0] : null;
}

function validateBranch(row: ParsedImportRow, session: DemoSession, masterItems: MasterItem[]) {
  const rawBranch = text(row.values.branch_code);
  const branch = resolveMaster(masterItems, "BRANCH", rawBranch) || resolveBranchByName(masterItems, rawBranch);
  const branchCode = (branch?.code || rawBranch).toUpperCase();
  row.values.branch_code = branchCode;
  // Với các loại import này, cửa hàng nằm trong CỘT của từng dòng file — màn hình không có ô
  // chọn nào cả. Thông báo cũ "không được chọn Admin / Tất cả cửa hàng" làm người dùng đi tìm
  // một dropdown không tồn tại; phải chỉ thẳng vào ô cần sửa trong file.
  if (!branchCode) {
    // Cột bắt buộc đã có sẵn lỗi "Cửa hàng là bắt buộc" từ bước đọc file — không chồng thêm.
    if (!row.errors.some((message) => message.includes("Cửa hàng là bắt buộc"))) {
      addError(row, "Ô Cửa hàng của dòng này đang trống — điền mã (NME, ASA...) hoặc tên cửa hàng vào cột Cửa hàng trong file");
    }
    return;
  }
  if (branchCode === "ALL") {
    addError(row, `Cột Cửa hàng đang là [${rawBranch}] — phải ghi một cửa hàng cụ thể (mã NME/ASA... hoặc tên đầy đủ), không dùng ALL`);
    return;
  }
  try {
    assertBranchAccess(session, branchCode);
  } catch (error) {
    addError(row, error instanceof Error ? error.message : "Không có quyền với chi nhánh import");
  }
  if (!branch) addError(row, `Cửa hàng [${branchCode}] không tồn tại hoặc ngưng hoạt động`);
}

function validateVoucher(row: ParsedImportRow, masterItems: MasterItem[]) {
  const voucherType = text(row.values.voucher_type).toUpperCase();
  row.values.voucher_type = voucherType;
  if (!['RECEIPT', 'PAYMENT'].includes(voucherType)) addError(row, "Loại phiếu chỉ được là RECEIPT hoặc PAYMENT");
  if (numberValue(row.values.amount) <= 0) addError(row, "Số tiền phải lớn hơn 0");

  const branchCode = text(row.values.branch_code);
  const sourceScope = normalizeChoice(row.values.source_scope || "EXTERNAL", {
    "noi bo": "INTERNAL",
    "ben trong": "INTERNAL",
    internal: "INTERNAL",
    "ben ngoai": "EXTERNAL",
    external: "EXTERNAL",
  });
  row.values.source_scope = sourceScope;
  if (!['INTERNAL', 'EXTERNAL'].includes(sourceScope)) addError(row, "Loại nguồn chỉ được là Nội bộ hoặc Bên ngoài");

  const moneySource = resolveMaster(masterItems, "MONEY_SOURCE", row.values.money_source_code, branchCode);
  if (!moneySource) addError(row, `Nguồn tiền [${text(row.values.money_source_code)}] không tồn tại hoặc ngưng hoạt động`);
  else row.values.money_source_code = moneySource.code;

  const category = resolveMaster(masterItems, "REVENUE_EXPENSE_CATEGORY", row.values.category_code, branchCode);
  if (!category) addError(row, `Loại thu/chi [${text(row.values.category_code)}] không tồn tại hoặc ngưng hoạt động`);
  else {
    row.values.category_code = category.code;
    if (normalizeCashflowCategoryType(category.group) !== voucherType) {
      addError(row, voucherType === "RECEIPT"
        ? `Phiếu thu phải chọn danh mục loại Thu, [${category.code}] đang là loại Chi`
        : `Phiếu chi phải chọn danh mục loại Chi, [${category.code}] đang là loại Thu`);
    }
  }

  const partnerInput = row.values.partner_code || row.values.partner_name;
  const partner = resolveMaster(masterItems, "PARTNER", partnerInput, branchCode);
  if (partner) {
    row.values.partner_code = partner.code;
    row.values.partner_name = partner.name;
  } else if (text(partnerInput)) {
    addError(row, `Đối tượng [${text(partnerInput)}] không tồn tại hoặc ngưng hoạt động`);
  } else {
    addError(row, "Mã hoặc tên khách hàng/nhà cung cấp là bắt buộc");
  }

  const categoryHint = normalizeHeader(`${category?.code || ""} ${category?.name || ""}`);
  let depositAction = normalizeChoice(row.values.deposit_action, {
    "thu tien coc": "COLLECT",
    "nhan tien coc": "COLLECT",
    "khach chuyen bo sung": "SUPPLEMENT",
    "chuyen bo sung": "SUPPLEMENT",
    supplement: "SUPPLEMENT",
    collect: "COLLECT",
    "tru coc": "OFFSET",
    "can tru vao bill": "OFFSET",
    "can tru bill": "OFFSET",
    "can tru tien coc": "OFFSET",
    offset: "OFFSET",
    "hoan coc": "REFUND",
    "hoan coc khi khach thanh toan lai": "REFUND",
    "hoan coc do khong co phat sinh": "REFUND",
    refund: "REFUND",
    "chuyen doanh thu": "REVENUE",
    "ghi nhan doanh thu": "REVENUE",
    revenue: "REVENUE",
  });
  if (!depositAction && (categoryHint.includes("tien coc") || categoryHint.includes("deposit"))) {
    depositAction = voucherType === "RECEIPT" ? "COLLECT" : "REFUND";
  }
  row.values.deposit_action = depositAction || null;
  if (depositAction && !['COLLECT', 'SUPPLEMENT', 'OFFSET', 'REFUND', 'REVENUE'].includes(depositAction)) {
    addError(row, "Xử lý tiền cọc chỉ được là COLLECT, SUPPLEMENT, OFFSET, REFUND hoặc REVENUE");
  }
  if (['OFFSET', 'REFUND', 'REVENUE'].includes(depositAction) && !text(row.values.deposit_code)) {
    addError(row, "Trừ/hoàn/chuyển doanh thu tiền cọc bắt buộc có Mã tiền cọc");
  }
  if (depositAction === "COLLECT" && voucherType !== "RECEIPT") addError(row, "Thu tiền cọc phải dùng phiếu Thu");
  if (depositAction === "SUPPLEMENT" && voucherType !== "RECEIPT") addError(row, "Khách chuyển bổ sung tiền cọc phải dùng phiếu Thu");
  if (depositAction === "REFUND" && voucherType !== "PAYMENT") addError(row, "Hoàn tiền cọc phải dùng phiếu Chi");

  const debtAction = normalizeChoice(row.values.debt_action, {
    "giam cong no": "SETTLE",
    "thanh toan cong no": "SETTLE",
    settle: "SETTLE",
  });
  row.values.debt_action = debtAction || (text(row.values.debt_reference) ? "SETTLE" : null);
  if (row.values.debt_action && row.values.debt_action !== "SETTLE") addError(row, "Xử lý công nợ hiện chỉ hỗ trợ SETTLE");
  if (row.values.debt_action === "SETTLE" && !text(row.values.debt_reference)) addError(row, "Thanh toán công nợ bắt buộc có Mã công nợ");

  const allocationMonths = numberValue(row.values.allocation_months);
  if (allocationMonths < 0 || !Number.isInteger(allocationMonths)) addError(row, "Số kỳ phân bổ phải là số nguyên dương");
  if (allocationMonths > 1) {
    validatePeriod(row, "allocation_start_period", "Kỳ bắt đầu phân bổ");
    if (!text(row.values.allocation_start_period)) addError(row, "Chi phí phân bổ bắt buộc có kỳ bắt đầu");
    if (voucherType !== "PAYMENT") addError(row, "Chi phí phân bổ chỉ áp dụng cho phiếu Chi");
  }
}

function validateTransfer(row: ParsedImportRow, masterItems: MasterItem[]) {
  if (numberValue(row.values.amount) <= 0) addError(row, "Số tiền phải lớn hơn 0");
  const branchCode = text(row.values.branch_code);
  const from = resolveMaster(masterItems, "MONEY_SOURCE", row.values.from_money_source_code, branchCode);
  const to = resolveMaster(masterItems, "MONEY_SOURCE", row.values.to_money_source_code, branchCode);
  if (!from) addError(row, `Nguồn chuyển [${text(row.values.from_money_source_code)}] không tồn tại, đã ngưng hoặc không thuộc cửa hàng [${branchCode}]`);
  else row.values.from_money_source_code = from.code;
  if (!to) addError(row, `Nguồn nhận [${text(row.values.to_money_source_code)}] không tồn tại, đã ngưng hoặc không thuộc cửa hàng [${branchCode}]`);
  else row.values.to_money_source_code = to.code;
  if (from && to && from.code === to.code) addError(row, "Nguồn chuyển và nguồn nhận không được giống nhau");
}

function validateDebt(row: ParsedImportRow, masterItems: MasterItem[]) {
  const debtType = normalizeChoice(row.values.debt_type, {
    "phai thu": "RECEIVABLE",
    receivable: "RECEIVABLE",
    ar: "RECEIVABLE",
    "phai tra": "PAYABLE",
    payable: "PAYABLE",
    ap: "PAYABLE",
  });
  const partnerGroup = normalizeChoice(row.values.partner_group, {
    "noi bo": "INTERNAL",
    "ben trong": "INTERNAL",
    internal: "INTERNAL",
    "ben ngoai": "EXTERNAL",
    external: "EXTERNAL",
  });
  row.values.debt_type = debtType;
  row.values.partner_group = partnerGroup;
  if (!['RECEIVABLE', 'PAYABLE'].includes(debtType)) addError(row, "Loại công nợ phải là Phải thu hoặc Phải trả");
  if (!['INTERNAL', 'EXTERNAL'].includes(partnerGroup)) addError(row, "Nhóm đối tượng phải là Nội bộ hoặc Bên ngoài");
  if (numberValue(row.values.amount) <= 0) addError(row, "Số tiền công nợ phải lớn hơn 0");
  const partner = resolveMaster(masterItems, "PARTNER", row.values.partner_code || row.values.partner_name, text(row.values.branch_code));
  if (!partner) addError(row, `Đối tượng [${text(row.values.partner_code || row.values.partner_name)}] không tồn tại`);
  else {
    row.values.partner_code = partner.code;
    row.values.partner_name = partner.name;
  }
  const allocationMonths = numberValue(row.values.allocation_months);
  if (allocationMonths > 1) {
    validatePeriod(row, "allocation_start_period", "Kỳ bắt đầu phân bổ");
    if (!text(row.values.allocation_start_period)) addError(row, "Công nợ phân bổ bắt buộc có kỳ bắt đầu");
  }
}

function validateInventoryTransaction(
  row: ParsedImportRow,
  masterItems: MasterItem[],
  inventoryItems: Array<{
    code: string;
    itemType?: string;
    status: string;
    unit: string;
    unitConversions: Array<{ unitCode: string; conversionRate: number }>;
  }>,
  balances: Array<{ itemId: string; warehouseCode: string; quantity: number; item: { code: string } }>,
) {
  const transactionType = normalizeStockTransactionType(row.values.transaction_type);
  row.values.transaction_type = transactionType;
  if (!isStockTransactionType(transactionType)) addError(row, "Loai giao dich kho khong hop le");
  const quantity = numberValue(row.values.quantity);
  if (quantity <= 0) addError(row, "So luong phai lon hon 0");
  if (transactionType === "NHAP_MUA" && numberValue(row.values.unit_cost) <= 0) addError(row, "Nhap mua bat buoc co don gia");

  const branchCode = text(row.values.branch_code).toUpperCase();
  const warehouse = resolveMaster(masterItems, "WAREHOUSE", row.values.warehouse_code, branchCode);
  if (!warehouse) addError(row, `Kho [${text(row.values.warehouse_code)}] khong ton tai hoac khong thuoc cua hang`);
  else row.values.warehouse_code = warehouse.code;

  if (transactionType === "DIEU_CHUYEN") {
    const toWarehouse = resolveMaster(masterItems, "WAREHOUSE", row.values.to_warehouse_code);
    if (!toWarehouse) addError(row, `Kho nhan [${text(row.values.to_warehouse_code)}] khong ton tai`);
    else row.values.to_warehouse_code = toWarehouse.code;
    if (warehouse && toWarehouse && warehouse.code === toWarehouse.code) addError(row, "Kho xuat va kho nhan khong duoc giong nhau");
  }

  if ((isOutboundStockType(transactionType) || transactionType === "DIEU_CHUYEN") && !text(row.values.warehouse_code)) {
    addError(row, "Giao dich xuat/dieu chuyen bat buoc co kho xuat");
  }
  if (isInboundStockType(transactionType) && !text(row.values.warehouse_code)) {
    addError(row, "Giao dich nhap bat buoc co kho nhap");
  }

  const itemCode = text(row.values.item_code).toUpperCase();
  row.values.item_code = itemCode;
  const item = inventoryItems.find((candidate) => candidate.code.toUpperCase() === itemCode);
  if (!item) {
    addError(row, `Khong tim thay mat hang ${itemCode}`);
    return;
  }
  if (item.status !== "ACTIVE") addError(row, `Mat hang ${itemCode} dang ngung hoat dong`);

  const unitCode = text(row.values.unit_code) || item.unit;
  row.values.unit_code = unitCode;
  const conversion = item.unitConversions.find((unit) => unit.unitCode.toUpperCase() === unitCode.toUpperCase());
  const conversionRate = conversion?.conversionRate || (unitCode.toUpperCase() === item.unit.toUpperCase() ? 1 : 0);
  if (!conversionRate) {
    addError(row, `DVT ${unitCode} khong ton tai trong quy doi cua mat hang ${itemCode}`);
    return;
  }
  row.values.converted_quantity = quantity * conversionRate;

  if (isOutboundStockType(transactionType) || transactionType === "DIEU_CHUYEN") {
    const currentBalance = balances.find((balance) => balance.item.code.toUpperCase() === itemCode && balance.warehouseCode === text(row.values.warehouse_code));
    if ((currentBalance?.quantity || 0) < quantity * conversionRate) addError(row, "Khong the xuat vuot ton kho");
  }
}

function validateBom(
  row: ParsedImportRow,
  inventoryItems: Array<{
    code: string;
    itemType?: string;
    status: string;
    unit: string;
    unitConversions: Array<{ unitCode: string; conversionRate: number }>;
  }>,
) {
  const productCode = text(row.values.product_code).toUpperCase();
  const ingredientCode = text(row.values.ingredient_code).toUpperCase();
  row.values.product_code = productCode;
  row.values.ingredient_code = ingredientCode;
  const product = inventoryItems.find((item) => item.code.toUpperCase() === productCode);
  const ingredient = inventoryItems.find((item) => item.code.toUpperCase() === ingredientCode);
  if (!product) addError(row, `Khong tim thay san pham ${productCode}`);
  if (!ingredient) addError(row, `Khong tim thay nguyen lieu ${ingredientCode}`);
  if (product && product.itemType && !["FINISHED", "SEMI_FINISHED"].includes(product.itemType)) {
    addError(row, "San pham BOM phai la thanh pham hoac ban thanh pham");
  }
  if (product && product.status !== "ACTIVE") addError(row, `San pham ${productCode} dang ngung hoat dong`);
  if (ingredient && ingredient.status !== "ACTIVE") addError(row, `Nguyen lieu ${ingredientCode} dang ngung hoat dong`);
  if (productCode && ingredientCode && productCode === ingredientCode) addError(row, "BOM khong duoc tham chieu chinh san pham do");
  if (numberValue(row.values.quantity) <= 0) addError(row, "So luong dinh muc phai lon hon 0");
  if (numberValue(row.values.waste_rate) < 0) addError(row, "Hao hut khong duoc am");
}

function validateStocktake(
  row: ParsedImportRow,
  masterItems: MasterItem[],
  inventoryItems: Array<{
    code: string;
    itemType?: string;
    status: string;
    unit: string;
    unitConversions: Array<{ unitCode: string; conversionRate: number }>;
  }>,
) {
  const branchCode = text(row.values.branch_code).toUpperCase();
  const warehouse = resolveMaster(masterItems, "WAREHOUSE", row.values.warehouse_code, branchCode);
  if (!warehouse) addError(row, `Kho [${text(row.values.warehouse_code)}] khong ton tai hoac khong thuoc cua hang`);
  else row.values.warehouse_code = warehouse.code;
  const itemCode = text(row.values.item_code).toUpperCase();
  row.values.item_code = itemCode;
  const item = inventoryItems.find((candidate) => candidate.code.toUpperCase() === itemCode);
  if (!item) addError(row, `Khong tim thay mat hang ${itemCode}`);
  if (item && item.status !== "ACTIVE") addError(row, `Mat hang ${itemCode} dang ngung hoat dong`);
  if (numberValue(row.values.actual_quantity) < 0) addError(row, "Ton thuc te khong duoc am");
}

function validateAsset(row: ParsedImportRow, masterItems: MasterItem[], existingAssetCodes: Set<string>) {
  const branchCode = text(row.values.branch_code).toUpperCase();
  const assetCode = text(row.values.asset_code).toUpperCase();
  row.values.branch_code = branchCode;
  row.values.asset_code = assetCode || null;

  if (assetCode && existingAssetCodes.has(assetCode)) {
    addError(row, `Ma tai san [${assetCode}] da ton tai, khong tu ghi de khi import hang loat`);
  }

  const warehouse = resolveMaster(masterItems, "WAREHOUSE", row.values.warehouse_code, branchCode);
  if (!warehouse) addError(row, `Kho/Vi tri [${text(row.values.warehouse_code)}] khong ton tai hoac khong thuoc cua hang ${branchCode}`);
  else row.values.warehouse_code = warehouse.code;

  const assetGroup = resolveMaster(masterItems, "ASSET_GROUP", row.values.asset_group);
  if (!assetGroup) addError(row, `Nhom tai san [${text(row.values.asset_group)}] khong ton tai hoac ngung hoat dong`);
  else row.values.asset_group = assetGroup.code;

  const departmentInput = text(row.values.department_code);
  if (departmentInput) {
    const department = resolveMaster(masterItems, "DEPARTMENT", departmentInput, branchCode);
    if (!department) addError(row, `Phong ban [${departmentInput}] khong ton tai hoac ngung hoat dong`);
    else row.values.department_code = department.code;
  }
  if (!assetCode && !departmentInput) addError(row, "Phong ban la bat buoc khi de trong Ma tai san de tu sinh ma");

  const supplierInput = row.values.supplier_code || row.values.supplier_name;
  if (text(supplierInput)) {
    const supplier = resolveMaster(masterItems, "PARTNER", supplierInput, branchCode);
    const supplierType = text(supplier?.partnerType || supplier?.group).toUpperCase();
    if (supplier && ["SUPPLIER", "BOTH"].includes(supplierType)) {
      row.values.supplier_code = supplier.code;
      row.values.supplier_name = supplier.name;
    } else addError(row, `Doi tac [${text(supplierInput)}] khong phai Nha cung cap/Phai tra dang hoat dong`);
  }

  const paymentStatus = normalizeChoice(row.values.payment_status || "PAID", {
    paid: "PAID", "da thanh toan": "PAID", payable: "PAYABLE", "cong no": "PAYABLE", "phai tra": "PAYABLE",
  });
  row.values.payment_status = paymentStatus;
  if (!["PAID", "PAYABLE"].includes(paymentStatus)) addError(row, "Thanh toan chi nhan PAID hoac PAYABLE");
  if (paymentStatus === "PAYABLE") {
    const originalCost = numberValue(row.values.original_cost);
    const payableAmount = numberValue(row.values.payable_amount) || originalCost;
    row.values.payable_amount = payableAmount;
    if (!text(row.values.supplier_code)) addError(row, "Tai san cong no phai co Nha cung cap/Phai tra");
    if (payableAmount !== originalCost) addError(row, "So tien cong no tai san phai bang nguyen gia");
    if (row.values.payment_due_date && row.values.purchase_date && new Date(String(row.values.payment_due_date)) < new Date(String(row.values.purchase_date))) {
      addError(row, "Han thanh toan khong duoc truoc ngay mua");
    }
  } else {
    row.values.payable_amount = 0;
    row.values.payment_due_date = null;
  }

  if (numberValue(row.values.quantity) <= 0) addError(row, "So luong tai san/CCDC phai lon hon 0");
  if (numberValue(row.values.original_cost) <= 0) addError(row, "Nguyen gia phai lon hon 0");
  if (numberValue(row.values.residual_value) < 0) addError(row, "Gia tri thu hoi khong duoc am");
  if (numberValue(row.values.residual_value) > numberValue(row.values.original_cost)) {
    addError(row, "Gia tri thu hoi khong duoc lon hon nguyen gia");
  }

  const usefulLifeMonths = numberValue(row.values.useful_life_months);
  if (usefulLifeMonths < 0 || !Number.isInteger(usefulLifeMonths)) addError(row, "So ky phan bo/khau hao phai la so nguyen duong");
  if (usefulLifeMonths > 0 && !row.values.depreciation_start_date) {
    addError(row, "Tai san co so ky phan bo/khau hao phai co ngay bat dau phan bo");
  }

  const status = text(row.values.status).toUpperCase() || "IN_USE";
  row.values.status = status;
  if (!["IN_USE", "FULLY_ALLOCATED", "DISPOSED", "INACTIVE"].includes(status)) {
    addError(row, "Trang thai tai san chi duoc la IN_USE, FULLY_ALLOCATED, DISPOSED hoac INACTIVE");
  }
}

/**
 * Cột "Loại thu/chi" trên file sao kê: để trống thì giao dịch vẫn import được và chờ
 * đối soát phân loại sau, có khai thì phải là khoản mục đang dùng và đúng chiều tiền —
 * tiền vào (Ghi có) chỉ nhận khoản mục nhóm doanh thu, tiền ra (Ghi nợ) chỉ nhận
 * khoản mục chi phí, để không tạo ra dữ liệu phân loại ngược.
 */
function validateBankStatementCategory(
  row: ParsedImportRow,
  masterItems: MasterItem[],
  debit: number,
  credit: number,
  validateDirection = true,
) {
  const input = row.values.category_code;
  if (!text(input)) {
    row.values.category_code = null;
    return;
  }

  const category = resolveMaster(masterItems, "REVENUE_EXPENSE_CATEGORY", input, text(row.values.branch_code));
  if (!category) {
    addError(row, `Loại thu/chi [${text(input)}] không tồn tại hoặc đã ngưng hoạt động`);
    return;
  }
  row.values.category_code = category.code;

  const cashflowType = normalizeCashflowCategoryType(category.group);
  if (validateDirection && credit > 0 && cashflowType !== "RECEIPT") {
    addError(row, `Giao dịch tiền vào phải chọn danh mục loại Thu, [${category.code}] đang là loại Chi`);
  }
  if (validateDirection && debit > 0 && cashflowType !== "PAYMENT") {
    addError(row, `Giao dịch tiền ra phải chọn danh mục loại Chi, [${category.code}] đang là loại Thu`);
  }
}

const bankMoneySourceAliases: Record<string, string> = {
  "fds vpbank": "FDSCHKHVPBANK",
  "fds vietinbank": "FDSCHKHVIET",
  "momo edc": "MOMO_EDC_FDS",
};

function resolveBankMoneySource(masterItems: MasterItem[], rawValue: unknown, branchCode?: string) {
  const aliasCode = bankMoneySourceAliases[normalizeHeader(text(rawValue))];
  return resolveMaster(masterItems, "MONEY_SOURCE", aliasCode || rawValue, branchCode);
}

/**
 * Dò nguồn tiền theo SỐ TÀI KHOẢN mà ngân hàng in ra trên sao kê.
 *
 * Mỗi tài khoản ngân hàng đã khai sẵn ở danh mục Nguồn tiền, nên cột Tài khoản của file là
 * đủ để biết tiền vào/ra nguồn nào và thuộc cửa hàng nào. Nhờ đó người dùng không phải gõ
 * tay nguồn tiền và cửa hàng cho từng dòng sao kê.
 */
function resolveMoneySourceByAccountNo(masterItems: MasterItem[], rawValue: unknown) {
  const digits = text(rawValue).replace(/[^0-9]/g, "");
  if (!digits) return null;
  const matches = masterItems.filter((item) => item.type === "MONEY_SOURCE"
    && item.status === "ACTIVE"
    && text(item.accountNo).replace(/[^0-9]/g, "") === digits);
  // Số tài khoản dùng chung cho nhiều nguồn thì không suy ra được, để người dùng khai rõ.
  return matches.length === 1 ? matches[0] : null;
}

function inferBankOperationType(input: {
  row: ParsedImportRow;
  debit: number;
  credit: number;
  category?: MasterItem | null;
  increaseSource?: MasterItem | null;
  decreaseSource?: MasterItem | null;
}) {
  const { row, debit, credit, category, increaseSource, decreaseSource } = input;
  const categoryText = normalizeHeader(`${category?.code || ""} ${category?.name || ""}`);
  const categoryType = normalizeCashflowCategoryType(category?.group);
  const increaseGroup = text(increaseSource?.group).toUpperCase();
  const decreaseGroup = text(decreaseSource?.group).toUpperCase();

  if (credit > 0 && decreaseGroup === "WALLET") return "WALLET_SETTLEMENT";
  if (
    increaseSource
    && decreaseSource
    && increaseSource.code !== decreaseSource.code
    && increaseGroup !== "WALLET"
    && decreaseGroup !== "WALLET"
  ) return "INTERNAL_TRANSFER";
  if (text(row.values.debt_reference)) return credit > 0 ? "AR_COLLECTION" : "AP_PAYMENT";
  if (text(row.values.deposit_code)) return debit > 0 ? "DEPOSIT_REFUND" : "DEPOSIT_RECEIPT";
  if (categoryText.includes("coc") || categoryText.includes("deposit")) {
    return debit > 0 ? "DEPOSIT_REFUND" : "DEPOSIT_RECEIPT";
  }
  if (debit > 0 && categoryText.includes("phi") && categoryText.includes("ngan hang")) return "BANK_FEE";
  if (debit > 0 && text(row.values.pnl_item_code)) return "DIRECT_EXPENSE";
  if (credit > 0 && categoryType === "RECEIPT") {
    return categoryText.includes("ban hang") || categoryText.includes("doanh thu")
      ? "REVENUE_RECEIPT"
      : "OTHER_RECEIPT";
  }
  if (debit > 0 && categoryType === "PAYMENT") return "OTHER_PAYMENT";
  return "";
}

function normalizeBankStatementRow(row: ParsedImportRow, masterItems: MasterItem[], session: DemoSession) {
  row.values.transaction_code = text(row.values.transaction_code).toUpperCase();
  const debit = numberValue(row.values.debit_amount);
  const credit = numberValue(row.values.credit_amount);
  if ((debit <= 0 && credit <= 0) || (debit > 0 && credit > 0)) {
    addError(row, "Mỗi dòng sao kê phải có đúng một bên Ghi nợ hoặc Ghi có");
  }

  // Số tài khoản trên sao kê là căn cứ chắc nhất: một tài khoản chỉ thuộc một nguồn tiền.
  const accountSource = resolveMoneySourceByAccountNo(masterItems, row.values.bank_account);
  if (accountSource) {
    if (!text(row.values.summary_money_source_code)) row.values.summary_money_source_code = accountSource.code;
    // Tiền vào thì tài khoản là nguồn tăng, tiền ra thì là nguồn giảm.
    if (credit > 0 && !text(row.values.increase_money_source_code)) row.values.increase_money_source_code = accountSource.code;
    if (debit > 0 && !text(row.values.decrease_money_source_code)) row.values.decrease_money_source_code = accountSource.code;
  }

  const rawSources = [
    row.values.summary_money_source_code,
    row.values.increase_money_source_code,
    row.values.decrease_money_source_code,
  ];
  let branchCode = text(row.values.branch_code).toUpperCase();
  if (!branchCode) {
    branchCode = accountSource?.branch || rawSources
      .map((value) => resolveBankMoneySource(masterItems, value)?.branch || "")
      .find(Boolean) || "";
    row.values.branch_code = branchCode;
  }
  if (branchCode) validateBranch(row, session, masterItems);
  else addError(row, "Không xác định được Cửa hàng từ file sao kê");

  const resolvedSources = {
    summary_money_source_code: resolveBankMoneySource(masterItems, row.values.summary_money_source_code, branchCode),
    increase_money_source_code: resolveBankMoneySource(masterItems, row.values.increase_money_source_code, branchCode),
    decrease_money_source_code: resolveBankMoneySource(masterItems, row.values.decrease_money_source_code, branchCode),
  };
  for (const [field, source] of Object.entries(resolvedSources)) {
    if (text(row.values[field]) && !source) {
      addError(row, `Nguồn tiền [${text(row.values[field])}] không tồn tại hoặc đã ngưng hoạt động`);
    } else if (source) {
      row.values[field] = source.code;
    }
  }

  const summaryBank = resolvedSources.summary_money_source_code?.group === "BANK"
    ? resolvedSources.summary_money_source_code
    : null;
  const detailBank = [resolvedSources.increase_money_source_code, resolvedSources.decrease_money_source_code]
    .find((source) => source?.group === "BANK");
  const bankSource = summaryBank || detailBank;
  row.values.bank_account = bankSource?.code || text(row.values.bank_account).toUpperCase();
  if (!text(row.values.bank_account)) addError(row, "Không xác định được tài khoản ngân hàng từ Nguồn tiền tổng/chi tiết");

  // Tiền ví đổ về ngân hàng: diễn giải của ngân hàng đã nói rõ ví nào và doanh thu ngày nào.
  if (credit > 0 && bankSource && walletKeywordsInText(row.values.description).length > 0) {
    if (!text(row.values.decrease_money_source_code)) {
      const wallet = resolveWalletFromDescription({
        description: row.values.description,
        bankSourceCode: bankSource.code,
        branchCode,
        walletSources: masterItems.filter((item) => item.type === "MONEY_SOURCE"
          && normalizeMoneySourceGroup(item.group) === "WALLET"),
      });
      if (wallet) {
        row.values.decrease_money_source_code = wallet.code;
        resolvedSources.decrease_money_source_code = masterItems.find((item) => item.type === "MONEY_SOURCE" && item.code === wallet.code) || null;
      }
    }
    if (!row.values.revenue_date) {
      const range = parseSettlementRevenueRange(row.values.description);
      if (range) row.values.revenue_date = range.from;
    }
  }

  // Hướng Thu/Chi được kiểm tra lại theo số ròng của cả nhóm sau khi gom mã giao dịch.
  validateBankStatementCategory(row, masterItems, debit, credit, false);

  const explicitOperationType = normalizeChoice(row.values.operation_type, {
    "thu doanh thu": "REVENUE_RECEIPT",
    "thu ban hang": "REVENUE_RECEIPT",
    "chi phi truc tiep": "DIRECT_EXPENSE",
    "thu cong no": "AR_COLLECTION",
    "tra cong no": "AP_PAYMENT",
    "thanh toan cong no": "AP_PAYMENT",
    "thu tien coc": "DEPOSIT_RECEIPT",
    "hoan tien coc": "DEPOSIT_REFUND",
    "dieu tien noi bo": "INTERNAL_TRANSFER",
    "quyet toan vi": "WALLET_SETTLEMENT",
    "phi ngan hang": "BANK_FEE",
    "thu khac": "OTHER_RECEIPT",
    "chi khac": "OTHER_PAYMENT",
  });
  const supportedOperations = new Set([
    "REVENUE_RECEIPT", "DIRECT_EXPENSE", "AR_COLLECTION", "AP_PAYMENT",
    "DEPOSIT_RECEIPT", "DEPOSIT_REFUND", "INTERNAL_TRANSFER",
    "WALLET_SETTLEMENT", "BANK_FEE", "OTHER_RECEIPT", "OTHER_PAYMENT",
  ]);
  const bankCategory = masterItems.find((item) => item.type === "REVENUE_EXPENSE_CATEGORY" && item.code === text(row.values.category_code));
  const operationType = explicitOperationType || inferBankOperationType({
    row,
    debit,
    credit,
    category: bankCategory,
    increaseSource: resolvedSources.increase_money_source_code,
    decreaseSource: resolvedSources.decrease_money_source_code,
  });
  row.values.operation_type = operationType;
  // Từ 19/08/2026 file sao kê không còn cột "Ngày hạch toán" (khách xin bỏ: 758/758 giao dịch
  // đã import đều để trống). Cột DB và các nhánh dùng accountingDate vẫn giữ nguyên, chỉ là giá
  // trị nay luôn suy từ Ngày giao dịch tại đây. Muốn tách kỳ P&L trở lại thì khai lại field
  // accounting_date trong import-templates.ts, phần còn lại chạy được ngay.
  row.values.accounting_date = row.values.accounting_date || row.values.transaction_date;
  if (!operationType) {
    addError(row, "Không thể tự xác định Loại nghiệp vụ đích; hãy khai báo cột này hoặc bổ sung đủ Loại thu/chi và thông tin nghiệp vụ");
  } else if (!supportedOperations.has(operationType)) {
    addError(row, `Loại nghiệp vụ đích [${operationType}] không được hỗ trợ`);
  }
  if (operationType !== "INTERNAL_TRANSFER" && !bankCategory) {
    addError(row, `${operationType || "Giao dịch"} bắt buộc có Loại thu/chi hợp lệ`);
  }
  if (operationType === "WALLET_SETTLEMENT") {
    const categoryValue = normalizeHeader(`${bankCategory?.code || ""} ${bankCategory?.name || ""}`);
    if (!categoryValue.includes("thu") || !categoryValue.includes("ban hang")) {
      addError(row, "WALLET_SETTLEMENT phải dùng loại Thu Tiền Từ Bán Hàng Tại Nhà Hàng");
    }
  }

  const partner = resolveMaster(masterItems, "PARTNER", row.values.partner_code, branchCode);
  if (text(row.values.partner_code) && !partner) {
    addError(row, `Đối tác [${text(row.values.partner_code)}] không tồn tại hoặc đã ngừng hoạt động`);
  } else if (partner) row.values.partner_code = partner.code;

  const pnlItem = resolveMaster(masterItems, "PNL_ITEM", row.values.pnl_item_code, branchCode);
  if (text(row.values.pnl_item_code) && !pnlItem) {
    addError(row, `Hạng mục P&L [${text(row.values.pnl_item_code)}] không tồn tại hoặc đã ngừng hoạt động`);
  } else if (pnlItem) row.values.pnl_item_code = pnlItem.code;

  if (["AR_COLLECTION", "AP_PAYMENT", "DEPOSIT_RECEIPT", "DEPOSIT_REFUND"].includes(operationType) && !partner) {
    addError(row, `${operationType} bắt buộc có Mã đối tác hợp lệ`);
  }
  const partnerType = text(partner?.partnerType || partner?.group).toUpperCase();
  if (["AR_COLLECTION", "DEPOSIT_RECEIPT", "DEPOSIT_REFUND"].includes(operationType) && partner && !["CUSTOMER", "BOTH", "OTHER_PARTNER"].includes(partnerType)) {
    addError(row, `${operationType} phải dùng đối tác Khách hàng/BOTH`);
  }
  if (operationType === "AP_PAYMENT" && partner && !["SUPPLIER", "BOTH"].includes(partnerType)) {
    addError(row, "AP_PAYMENT phải dùng đối tác Nhà cung cấp/BOTH");
  }
  if (operationType === "DEPOSIT_REFUND" && !text(row.values.deposit_code)) {
    addError(row, "DEPOSIT_REFUND bắt buộc có Mã tiền cọc");
  }
  if (operationType === "DIRECT_EXPENSE" && !pnlItem) {
    addError(row, "DIRECT_EXPENSE bắt buộc có Hạng mục P&L");
  }
  if (["REVENUE_RECEIPT", "AR_COLLECTION", "DEPOSIT_RECEIPT", "OTHER_RECEIPT", "WALLET_SETTLEMENT"].includes(operationType) && credit <= 0) {
    addError(row, `${operationType} phải là giao dịch Ghi Có`);
  }
  if (["DIRECT_EXPENSE", "AP_PAYMENT", "DEPOSIT_REFUND", "BANK_FEE", "OTHER_PAYMENT"].includes(operationType) && debit <= 0) {
    addError(row, `${operationType} phải là giao dịch Ghi Nợ`);
  }
  if (credit > 0 && resolvedSources.increase_money_source_code?.group !== "BANK") {
    addError(row, "Giao dịch Ghi Có bắt buộc khai báo Cộng nguồn tiền chi tiết là nguồn BANK");
  }
  if (debit > 0 && resolvedSources.decrease_money_source_code?.group !== "BANK") {
    addError(row, "Giao dịch Ghi Nợ bắt buộc khai báo Trừ nguồn tiền chi tiết là nguồn BANK");
  }
  if (operationType === "WALLET_SETTLEMENT" && resolvedSources.decrease_money_source_code?.group !== "WALLET") {
    addError(row, "WALLET_SETTLEMENT bắt buộc khai báo Trừ nguồn tiền chi tiết là nguồn Ví/POS");
  }
  if (operationType === "INTERNAL_TRANSFER") {
    if (!resolvedSources.increase_money_source_code || !resolvedSources.decrease_money_source_code) {
      addError(row, "INTERNAL_TRANSFER bắt buộc có đủ nguồn tiền tăng và nguồn tiền giảm");
    }
    if (resolvedSources.increase_money_source_code?.code === resolvedSources.decrease_money_source_code?.code) {
      addError(row, "Nguồn tiền tăng và nguồn tiền giảm của INTERNAL_TRANSFER không được giống nhau");
    }
  }
  if (operationType === "WALLET_SETTLEMENT") {
    const grabExpense = numberValue(row.values.grab_expense_amount);
    const cardFee = numberValue(row.values.card_fee_amount);
    const gross = numberValue(row.values.gross_amount);
    if (!row.values.revenue_date) addError(row, "WALLET_SETTLEMENT bắt buộc có Ngày doanh thu");
    if (grabExpense < 0 || cardFee < 0) addError(row, "Phí Grab và phí cà thẻ/Ví không được âm");
    // Gross ví là số của luồng doanh thu POS, không phải thứ sao kê ngân hàng biết. File khai
    // thì kiểm tra cho khớp; không khai thì vẫn ghi nhận tiền về, phần phí đối chiếu sau khi
    // có doanh thu POS của đúng ví và đúng ngày doanh thu.
    if (gross > 0) {
      if (gross < credit) addError(row, "Gross Ví không được nhỏ hơn số tiền ngân hàng ghi Có");
      if (Math.abs(gross - credit - grabExpense - cardFee) > 1) {
        addError(row, "Gross Ví phải bằng Ghi Có ngân hàng + Phí Grab + Phí cà thẻ/Ví khác");
      }
    } else if (grabExpense > 0 || cardFee > 0) {
      addError(row, "Đã khai phí Ví thì phải khai luôn Gross doanh thu Ví để đối chiếu");
    }
  }

  const autoProcessType = operationType === "WALLET_SETTLEMENT"
    ? "WALLET_SETTLEMENT"
    : debit > 0 ? "PAYMENT" : "RECEIPT";
  const autoProcessNote = "Đủ dữ liệu file để ghi nhận tự động khi Commit";
  row.values.auto_process_type = autoProcessType;
  row.values.auto_process_note = autoProcessNote;
  row.values.import_action = "CREATE";
}

/**
 * Điền Gross doanh thu Ví và phí cho các dòng quyết toán ví chưa khai.
 *
 * Gross ví là số của luồng doanh thu POS chứ không phải thứ sao kê ngân hàng biết, nên người
 * dùng không việc gì phải gõ tay: hệ thống tra doanh thu đã import của đúng ví và đúng Ngày
 * doanh thu, trừ đi phần đã được quyết toán ở các lần import trước, phần còn lại là gross của
 * dòng này. Phí = gross - số tiền ngân hàng thực nhận, rồi tách về Phí Grab hoặc Phí cà thẻ
 * theo nhóm ví.
 *
 * Chưa import doanh thu POS thì để trống, dòng sao kê vẫn được ghi nhận và phí đối chiếu sau.
 */
async function fillWalletGrossFromPosRevenue(rows: ParsedImportRow[], masterItems: MasterItem[]) {
  const pending = rows.filter((row) => row.errors.length === 0
    && text(row.values.operation_type) === "WALLET_SETTLEMENT"
    && numberValue(row.values.gross_amount) <= 0
    && row.values.revenue_date instanceof Date
    && text(row.values.decrease_money_source_code)
    && text(row.values.branch_code));
  if (pending.length === 0) return;

  const revenueDates = [...new Set(pending.map((row) => (row.values.revenue_date as Date).toISOString()))]
    .map((value) => new Date(value));
  const branchCodes = [...new Set(pending.map((row) => text(row.values.branch_code)))];
  const walletCodes = [...new Set(pending.map((row) => text(row.values.decrease_money_source_code)))];
  // Doanh thu nhập trên giao diện lưu nửa đêm giờ Việt Nam, còn ngày trên file import là UTC
  // midnight. Truy vấn theo khoảng ngày nghiệp vụ để bắt được cả hai, rồi gom lại theo ngày.
  const dayRanges = revenueDates.map((date) => vietnamBusinessDayBounds(date));
  const rangeStart = new Date(Math.min(...dayRanges.map((range) => range.start.getTime())));
  const rangeEnd = new Date(Math.max(...dayRanges.map((range) => range.end.getTime())));

  const [posRows, manualRows, claimed] = await Promise.all([
    prisma.revenueImportRow.findMany({
      where: { branchCode: { in: branchCodes }, saleDate: { gte: rangeStart, lt: rangeEnd } },
      select: { saleDate: true, branchCode: true, paymentMethod: true, revenueSource: true, channel: true, netAmount: true },
    }),
    prisma.manualRevenueEntry.findMany({
      where: { branchCode: { in: branchCodes }, reportDate: { gte: rangeStart, lt: rangeEnd } },
      select: { reportDate: true, branchCode: true, cardAmount: true, grabAmount: true },
    }),
    // Phần doanh thu ví đã được quyết toán ở các batch trước, để không clear trùng.
    prisma.bankStatementAllocation.findMany({
      where: {
        revenueDate: { gte: rangeStart, lt: rangeEnd },
        decreaseMoneySourceCode: { in: walletCodes },
        grossAmount: { not: null },
      },
      select: { revenueDate: true, decreaseMoneySourceCode: true, grossAmount: true },
    }),
  ]);

  const dayKey = vietnamBusinessDayKey;
  const claimedByWallet = new Map<string, number>();
  for (const row of claimed) {
    if (!row.revenueDate || !row.decreaseMoneySourceCode) continue;
    const key = `${row.decreaseMoneySourceCode}|${dayKey(row.revenueDate)}`;
    claimedByWallet.set(key, (claimedByWallet.get(key) || 0) + (row.grossAmount || 0));
  }

  // Nhiều dòng cùng ví + cùng ngày doanh thu thì chia theo tỷ trọng tiền thực nhận.
  const groups = new Map<string, ParsedImportRow[]>();
  for (const row of pending) {
    const key = `${text(row.values.branch_code)}|${text(row.values.decrease_money_source_code)}|${dayKey(row.values.revenue_date as Date)}`;
    groups.set(key, [...(groups.get(key) || []), row]);
  }

  // Cùng một cửa hàng và cùng một ngày có thể có nhiều ví cùng nhóm, ví dụ hai ví Momo của hai
  // cửa hàng dùng chung số thu ngân khai. Cần biết trước ai đang tranh khoản doanh thu nào.
  const rivalsByBucket = new Map<string, string[]>();
  for (const key of groups.keys()) {
    const [branchCode, walletCode, day] = key.split("|");
    const wallet = masterItems.find((item) => item.type === "MONEY_SOURCE" && item.code === walletCode);
    if (!wallet) continue;
    const bucketKey = `${branchCode}|${day}|${walletRevenueBucket({ code: wallet.code, name: wallet.name })}`;
    rivalsByBucket.set(bucketKey, [...(rivalsByBucket.get(bucketKey) || []), walletCode]);
  }

  for (const [key, groupRows] of groups) {
    const [branchCode, walletCode, day] = key.split("|");
    const wallet = masterItems.find((item) => item.type === "MONEY_SOURCE" && item.code === walletCode);
    if (!wallet) continue;

    const dayPosRows = posRows
      .filter((item) => item.branchCode === branchCode && dayKey(item.saleDate) === day)
      .map((item) => ({
        paymentMethod: item.paymentMethod,
        revenueSource: item.revenueSource,
        channel: item.channel,
        netAmount: item.netAmount,
      }));
    const rivals = (rivalsByBucket.get(`${branchCode}|${day}|${walletRevenueBucket({ code: wallet.code, name: wallet.name })}`) || [])
      .filter((code) => code !== walletCode)
      .map((code) => masterItems.find((item) => item.type === "MONEY_SOURCE" && item.code === code))
      .filter((item): item is MasterItem => Boolean(item))
      .map((item) => ({ code: item.code, name: item.name }));

    const declared = selectWalletDeclaredRevenue({
      posRows: dayPosRows,
      manualRows: manualRows
        .filter((item) => item.branchCode === branchCode && dayKey(item.reportDate) === day)
        .map((item) => ({ cardAmount: item.cardAmount, grabAmount: item.grabAmount })),
      bucketSources: [{ code: wallet.code, name: wallet.name }],
      bucket: walletRevenueBucket({ code: wallet.code, name: wallet.name }),
      rivalSources: rivals,
    });

    // Doanh thu không quy được về đúng một ví thì không suy Gross. Chia đại sẽ đẻ ra phí sai rồi
    // vào thẳng chi phí; để trống thì phí vẫn được đối chiếu ở báo cáo "Tiền về đủ chưa".
    if (declared.contested) continue;

    const available = Math.round(declared.amount - (claimedByWallet.get(`${walletCode}|${day}`) || 0));
    const bankTotal = groupRows.reduce((sum, row) => sum + numberValue(row.values.credit_amount), 0);
    // Doanh thu chưa import, hoặc đã clear hết ở lần trước, hoặc không đủ để phủ số tiền về:
    // giữ nguyên trống để commit ghi nhận theo số thực nhận và đối chiếu phí sau.
    if (available < bankTotal) continue;

    const isGrab = walletRevenueBucket({ code: wallet.code, name: wallet.name }) === "GRAB";
    let remaining = available;
    groupRows.forEach((row, index) => {
      const credit = Math.round(numberValue(row.values.credit_amount));
      const gross = index === groupRows.length - 1
        ? remaining
        : Math.round((available * credit) / bankTotal);
      remaining -= gross;
      const fee = Math.max(0, gross - credit);
      row.values.gross_amount = gross;
      row.values.grab_expense_amount = isGrab ? fee : 0;
      row.values.card_fee_amount = isGrab ? 0 : fee;
    });
  }
}

export async function validateImportResult(
  result: ParsedImportResult,
  importType: ImportType,
  session: DemoSession,
  options: { expectedMasterType?: string } = {},
) {
  const expectedMasterType = text(options.expectedMasterType).toUpperCase();
  if (importType === "MASTER_DATA" && expectedMasterType && !isMasterDataImportType(expectedMasterType)) {
    throw new Error(`Loại danh mục yêu cầu [${expectedMasterType}] không được hỗ trợ import`);
  }
  const masterItems = await prisma.masterDataItem.findMany({
    where: { type: { in: ["BRANCH", "MONEY_SOURCE", "PARTNER", "PNL_ITEM", "REVENUE_EXPENSE_CATEGORY", "WAREHOUSE", "INVENTORY_ITEM_GROUP", "ASSET_GROUP", "DEPARTMENT"] } },
    select: { type: true, code: true, name: true, group: true, partnerType: true, branch: true, status: true, accountNo: true, settlementBankCode: true },
  });
  const inventoryItems = ["OPENING_BALANCE", "INVENTORY_TRANSACTION", "BOM", "STOCKTAKE", "REVENUE_POS"].includes(importType)
    ? await prisma.inventoryItem.findMany({ select: { code: true, itemType: true, status: true, unit: true, unitConversions: { select: { unitCode: true, conversionRate: true } } } })
    : [];
  const inventoryBalances = importType === "INVENTORY_TRANSACTION"
    ? await prisma.inventoryBalance.findMany({ include: { item: { select: { code: true } } } })
    : [];
  const existingAssetCodes = importType === "ASSET"
    ? new Set((await prismaRaw.assetRecord.findMany({ select: { code: true } })).map((asset) => asset.code.toUpperCase()))
    : new Set<string>();

  const branchTypes: ImportType[] = ["VOUCHER", "INTERNAL_TRANSFER", "DEBT_OPENING", "OPENING_BALANCE", "REVENUE_POS", "PAYROLL", "INVENTORY_TRANSACTION", "STOCKTAKE", "ASSET"];
  const openingBalanceKeys = new Set<string>();
  const revenueStockUsage = new Map<string, number>();
  const revenueReferenceRows = new Map<string, ParsedImportRow>();
  const importAssetCodes = new Set<string>();
  for (const row of result.rows) {
    if (branchTypes.includes(importType)) validateBranch(row, session, masterItems);

    if (importType === "VOUCHER") validateVoucher(row, masterItems);
    if (importType === "INTERNAL_TRANSFER") validateTransfer(row, masterItems);
    if (importType === "DEBT_OPENING") validateDebt(row, masterItems);
    if (importType === "INVENTORY_TRANSACTION") validateInventoryTransaction(row, masterItems, inventoryItems, inventoryBalances);
    if (importType === "BOM") validateBom(row, inventoryItems);
    if (importType === "STOCKTAKE") validateStocktake(row, masterItems, inventoryItems);
    if (importType === "ASSET") {
      validateAsset(row, masterItems, existingAssetCodes);
      const assetCode = text(row.values.asset_code).toUpperCase();
      if (assetCode) {
        if (importAssetCodes.has(assetCode)) addError(row, `File co ma tai san [${assetCode}] bi trung dong`);
        importAssetCodes.add(assetCode);
      }
    }
    if (importType === "INVENTORY_ITEM") {
      const itemType = normalizeItemType(row.values.item_type);
      row.values.item_type = itemType;
      if (!["RAW_MATERIAL", "SEMI_FINISHED", "FINISHED", "PACKAGING", "TOOL", "ASSET"].includes(itemType)) {
        addError(row, "Loại mặt hàng không hợp lệ");
      }
      const itemGroupInput = text(row.values.category);
      if (itemGroupInput) {
        const itemGroup = resolveMaster(masterItems, "INVENTORY_ITEM_GROUP", itemGroupInput);
        if (!itemGroup) addError(row, `Nhóm mặt hàng [${itemGroupInput}] không tồn tại hoặc ngưng hoạt động`);
        else row.values.category = itemGroup.code;
      }
      const purchaseUnit = text(row.values.purchase_unit);
      const conversionRate = numberValue(row.values.conversion_rate);
      if ((purchaseUnit || conversionRate > 0) && (!purchaseUnit || conversionRate < 1)) {
        addError(row, "ĐVT mua và tỷ lệ quy đổi phải hợp lệ");
      }
    }
    if (importType === "OPENING_BALANCE") {
      validatePeriod(row, "period", "Kỳ");
      if (numberValue(row.values.amount) === 0) addError(row, "Số dư đầu kỳ không được bằng 0");
      const balanceType = text(row.values.balance_type).toUpperCase();
      row.values.balance_type = balanceType;
      if (!["CASH", "BANK", "WALLET_POS", "AR", "AP", "DEPOSIT", "INVENTORY", "ASSET", "PREPAID_EXPENSE"].includes(balanceType)) {
        addError(row, "Loại số dư không hợp lệ");
      }
      const openingKey = [
        text(row.values.period),
        text(row.values.branch_code).toUpperCase(),
        balanceType,
        text(row.values.object_code).toUpperCase(),
        text(row.values.money_source_code).toUpperCase(),
        text(row.values.warehouse_code).toUpperCase(),
        text(row.values.department_code).toUpperCase(),
      ].join("|");
      if (openingBalanceKeys.has(openingKey)) {
        addError(row, "File co dong so du dau ky bi trung nguon/doi tuong");
      }
      openingBalanceKeys.add(openingKey);
      if (["CASH", "BANK", "WALLET_POS"].includes(balanceType) && !text(row.values.money_source_code)) {
        addError(row, "Loại số dư này bắt buộc có Nguồn tiền");
      }
      if (["AR", "AP", "DEPOSIT", "INVENTORY", "ASSET", "PREPAID_EXPENSE"].includes(balanceType) && !text(row.values.object_code)) {
        addError(row, "Loại số dư này bắt buộc có Mã đối tượng/Mã nguồn");
      }
      if (balanceType === "INVENTORY") {
        const itemCode = text(row.values.object_code).toUpperCase();
        const item = inventoryItems.find((candidate) => candidate.code.toUpperCase() === itemCode);
        if (itemCode && !item) addError(row, `Không tìm thấy mặt hàng ${itemCode}. Vui lòng tạo/import Danh mục mặt hàng trước`);
        if (item && item.status !== "ACTIVE") addError(row, `Mặt hàng ${itemCode} đang ngưng hoạt động`);
        if (!text(row.values.warehouse_code)) addError(row, "Tồn kho đầu kỳ bắt buộc có Kho");
        if (numberValue(row.values.quantity) <= 0) addError(row, "Tồn kho đầu kỳ bắt buộc có Số lượng > 0");
      }
      if (balanceType === "PREPAID_EXPENSE") {
        validatePeriod(row, "allocation_start_period", "Kỳ bắt đầu phân bổ");
        if (numberValue(row.values.allocation_months) <= 1) addError(row, "Chi phí phân bổ đầu kỳ cần số kỳ phân bổ > 1");
      }
    }
    if (importType === "REVENUE_POS") {
      if (numberValue(row.values.gross_amount) < 0 || numberValue(row.values.net_amount) < 0
        || numberValue(row.values.fee_amount) < 0 || numberValue(row.values.vat_amount) < 0) addError(row, "Doanh thu không được âm");
      // Tổng doanh thu là số lên báo cáo Tiền về đủ chưa, còn Doanh thu/SVC/VAT là ba phần
      // cấu thành. File dùng công thức thì luôn khớp; lệch nghĩa là sửa tay sót — chặn ngay
      // tại preview thay vì để số sai chảy vào đối soát. Dung sai 5 đ cho làm tròn từng món.
      const posParts = numberValue(row.values.gross_amount) + numberValue(row.values.fee_amount) + numberValue(row.values.vat_amount);
      if (posParts > 0 && Math.abs(posParts - numberValue(row.values.net_amount)) > 5) {
        addError(row, `Tổng doanh thu (${numberValue(row.values.net_amount).toLocaleString("vi-VN")}) không bằng Doanh thu + SVC + VAT (${posParts.toLocaleString("vi-VN")})`);
      }
      const productCode = text(row.values.product_code).toUpperCase();
      const productQuantity = numberValue(row.values.product_quantity);
      if (productCode || productQuantity > 0) {
        row.values.product_code = productCode;
        if (!productCode || productQuantity <= 0) addError(row, "Ma mon POS va So luong ban phai di cung nhau");
        const warehouse = resolveMaster(masterItems, "WAREHOUSE", row.values.warehouse_code, text(row.values.branch_code).toUpperCase());
        if (!warehouse) addError(row, "Dong POS co tru kho bat buoc co kho xuat hop le");
        else row.values.warehouse_code = warehouse.code;
        const product = inventoryItems.find((item) => item.code.toUpperCase() === productCode);
        if (!product) addError(row, `Khong tim thay ma mon POS ${productCode}`);
        if (product && product.status !== "ACTIVE") addError(row, `Ma mon POS ${productCode} dang ngung hoat dong`);
        if (product?.itemType && !["FINISHED", "SEMI_FINISHED"].includes(product.itemType)) addError(row, `Ma mon POS ${productCode} phai la thanh pham hoac ban thanh pham`);
        const activeRecipe = await prisma.recipe.findFirst({
          where: { productCode, status: "ACTIVE" },
          include: { lines: { include: { item: { include: { balances: true } } } } },
          orderBy: { version: "desc" },
        });
        if (productCode && !activeRecipe) addError(row, `Chua co dinh luong/BOM active cho ${productCode}`);
        if (activeRecipe && warehouse) {
          for (const line of activeRecipe.lines) {
            const requiredQuantity = line.quantity * (1 + line.wasteRate / 100) * productQuantity;
            const key = `${line.itemId}|${warehouse.code}`;
            const nextUsage = (revenueStockUsage.get(key) || 0) + requiredQuantity;
            revenueStockUsage.set(key, nextUsage);
            const balance = line.item.balances.find((candidate) => candidate.warehouseCode === warehouse.code);
            if ((balance?.quantity || 0) < nextUsage) {
              addError(row, `Khong du ton ${line.item.code} tai kho ${warehouse.code} de tru theo BOM`);
            }
          }
        }
      }
      ensureRevenuePosReference(row.values);
      const referenceKey = revenuePosReferenceKey(row.values);
      const duplicateReferenceRow = revenueReferenceRows.get(referenceKey);
      if (duplicateReferenceRow) {
        const message = `Mã tham chiếu POS [${text(row.values.external_ref)}] bị trùng trong file; hãy cung cấp mã riêng để phân biệt giao dịch`;
        addError(duplicateReferenceRow, message);
        addError(row, message);
      } else {
        revenueReferenceRows.set(referenceKey, row);
      }
    }
    if (importType === "MASTER_DATA") {
      const masterType = text(row.values.type).toUpperCase();
      row.values.type = masterType;
      if (!isMasterDataImportType(masterType)) {
        addError(row, `Loại danh mục [${masterType || "trống"}] không hợp lệ`);
      } else if (expectedMasterType && masterType !== expectedMasterType) {
        addError(row, `Màn hình này chỉ cho phép import loại ${expectedMasterType}, dòng hiện tại đang là ${masterType}`);
      }

      const group = text(row.values.group).toUpperCase();
      if (group) row.values.group = group;
      if (masterType === "PARTNER") {
        const partnerGroup = (text(row.values.partner_group) || "EXTERNAL").toUpperCase();
        row.values.partner_group = partnerGroup;
        if (!group || !["CUSTOMER", "SUPPLIER", "BOTH", "EMPLOYEE", "OTHER_PARTNER"].includes(group)) {
          addError(row, "Đối tác phải có Nhóm/Phân loại là CUSTOMER, SUPPLIER, BOTH, EMPLOYEE hoặc OTHER_PARTNER");
        }
        if (!["EXTERNAL", "INTERNAL"].includes(partnerGroup)) {
          addError(row, "Nhóm đối tượng phải là EXTERNAL hoặc INTERNAL");
        }
      } else if (masterType === "MONEY_SOURCE" && !["CASH", "BANK", "WALLET"].includes(group)) {
        addError(row, "Nguồn tiền phải có Nhóm/Phân loại là CASH, BANK hoặc WALLET");
      } else if (masterType === "REVENUE_EXPENSE_CATEGORY") {
        const cashflowType = normalizeCashflowCategoryType(text(row.values.group));
        row.values.group = cashflowType;
        if (!["RECEIPT", "PAYMENT"].includes(cashflowType || "")) {
          addError(row, "Danh mục Thu/Chi phải có Nhóm/Phân loại là Thu hoặc Chi");
        }
      }
    }
    if (importType === "PAYROLL") {
      validatePeriod(row, "period", "Kỳ lương");
      const gross = numberValue(row.values.base_salary) + numberValue(row.values.allowance_amount) + numberValue(row.values.bonus_amount);
      const deductions = numberValue(row.values.insurance_amount) + numberValue(row.values.tax_amount) + numberValue(row.values.deduction_amount);
      if (Math.abs(gross - deductions - numberValue(row.values.net_amount)) > 1) {
        addError(row, "Thực nhận không khớp thu nhập trừ các khoản khấu trừ");
      }
    }
    if (importType === "BANK_STATEMENT") {
      normalizeBankStatementRow(row, masterItems, session);
    }
  }

  if (importType === "BANK_STATEMENT") {
    const groups = groupBankStatementRows(result.rows);
    const existing = groups.length > 0
      ? await prisma.bankStatementTransaction.findMany({
          where: {
            OR: groups.map((group) => ({
              bankAccount: text(group.rows[0].values.bank_account),
              transactionCode: text(group.rows[0].values.transaction_code),
            })),
          },
          select: { id: true, bankAccount: true, transactionCode: true },
        })
      : [];
    const existingKeys = new Set(existing.map((row) => `${row.bankAccount}|${row.transactionCode}`.toUpperCase()));

    for (const group of groups) {
      const existingKey = `${text(group.rows[0].values.bank_account)}|${text(group.rows[0].values.transaction_code)}`.toUpperCase();
      if (existingKeys.has(existingKey)) {
        for (const row of group.rows) {
          row.values.import_action = "SKIP_EXISTING";
          row.values.auto_process_type = "SKIP_EXISTING";
          row.values.auto_process_note = "Giao dịch đã tồn tại trong hệ thống — commit sẽ bỏ qua, không làm lỗi cả batch";
        }
        continue;
      }

      if (group.isNetZero) {
        for (const row of group.rows) {
          row.values.import_action = "NET_ZERO";
          row.values.auto_process_type = "NET_ZERO";
          row.values.auto_process_note = `Cặp Nợ/Có đảo nhau, giá trị ròng 0 đ — lưu dấu vết và không tạo phiếu`;
        }
        continue;
      }

      for (const row of group.rows) {
        const category = masterItems.find((item) => item.type === "REVENUE_EXPENSE_CATEGORY" && item.code === text(row.values.category_code));
        const categoryType = normalizeCashflowCategoryType(category?.group);
        const directionMismatch = (group.creditAmount > 0 && categoryType !== "RECEIPT")
          || (group.debitAmount > 0 && categoryType !== "PAYMENT");
        if (directionMismatch) {
          addError(row, `Loại thu/chi [${text(row.values.category_code)}] ngược chiều Nợ/Có của giao dịch`);
        }
      }

      if (group.rows.length > 1) {
        if (!group.isMultiAllocation) {
          for (const row of group.rows) {
            addError(row, "Mã giao dịch có cả Nợ và Có nhưng giá trị ròng khác 0; cần sửa file trước khi Commit");
          }
        } else {
          const operationTypes = new Set(group.rows.map((row) => text(row.values.operation_type)));
          if (operationTypes.size !== 1) {
            for (const row of group.rows) addError(row, "Các dòng cùng mã giao dịch phải có cùng Loại nghiệp vụ đích");
          }
          const operationType = text(group.rows[0].values.operation_type);
          if (operationType !== "WALLET_SETTLEMENT") {
            const businessFields = [
              "branch_code",
              "category_code",
              "increase_money_source_code",
              "decrease_money_source_code",
              "partner_code",
              "pnl_item_code",
              "debt_reference",
              "deposit_code",
              // Trước đây là "accounting_date"; cột đó đã bỏ nên giá trị luôn bằng Ngày giao dịch.
              // Giữ phép kiểm bằng chính cột nguồn: các dòng cùng một mã giao dịch phải cùng ngày.
              "transaction_date",
            ];
            const hasMixedBusinessAllocation = businessFields.some((field) => (
              new Set(group.rows.map((row) => text(row.values[field]))).size > 1
            ));
            if (hasMixedBusinessAllocation) {
              for (const row of group.rows) {
                addError(row, "Một mã giao dịch ngoài Ví không được phân bổ sang nhiều nghiệp vụ/đối tượng; hãy tách mã giao dịch trong file trước khi Commit");
              }
            }
          }
          for (const row of group.rows) {
            row.values.import_action = "GROUP_ALLOCATION";
            row.values.auto_process_note = `Gộp ${group.rows.length} dòng thành 1 giao dịch; giữ từng ngày doanh thu ở bảng phân bổ`;
          }
        }
      }
    }

    const debtRows = result.rows.filter((row) => ["AR_COLLECTION", "AP_PAYMENT"].includes(text(row.values.operation_type)));
    const debtReferences = [...new Set(debtRows.map((row) => text(row.values.debt_reference)).filter(Boolean))];
    const debts = debtReferences.length > 0
      ? await prisma.debtRecord.findMany({
          where: { code: { in: debtReferences }, deletedAt: null },
          select: { code: true, debtType: true, partnerCode: true, branchCode: true, outstandingAmount: true, status: true },
        })
      : [];
    const debtByCode = new Map(debts.map((debt) => [debt.code, debt]));
    const amountByDebt = new Map<string, number>();
    for (const row of debtRows) {
      const reference = text(row.values.debt_reference);
      const debt = debtByCode.get(reference);
      const expectedType = text(row.values.operation_type) === "AR_COLLECTION" ? "RECEIVABLE" : "PAYABLE";
      const amount = Math.round(numberValue(row.values.credit_amount) || numberValue(row.values.debit_amount));
      amountByDebt.set(reference, (amountByDebt.get(reference) || 0) + amount);
      if (!debt) addError(row, `Mã công nợ [${reference}] không tồn tại`);
      else {
        if (debt.status === "SETTLED" || debt.outstandingAmount <= 0) addError(row, `Công nợ [${reference}] đã tất toán`);
        if (debt.debtType !== expectedType) addError(row, `Công nợ [${reference}] không đúng loại ${expectedType}`);
        if (debt.partnerCode !== text(row.values.partner_code)) addError(row, `Công nợ [${reference}] không thuộc đối tác đã khai báo`);
        if (debt.branchCode !== text(row.values.branch_code)) addError(row, `Công nợ [${reference}] không thuộc cửa hàng đã khai báo`);
      }
    }
    for (const row of debtRows) {
      const reference = text(row.values.debt_reference);
      const debt = debtByCode.get(reference);
      if (debt && (amountByDebt.get(reference) || 0) > debt.outstandingAmount + 1) {
        addError(row, `Tổng thanh toán công nợ [${reference}] vượt số còn phải thu/trả`);
      }
    }

    const refundRows = result.rows.filter((row) => text(row.values.operation_type) === "DEPOSIT_REFUND");
    const depositCodes = [...new Set(refundRows.map((row) => text(row.values.deposit_code)).filter(Boolean))];
    const deposits = depositCodes.length > 0
      ? await prisma.deposit.findMany({
          where: { code: { in: depositCodes }, deletedAt: null },
          select: { code: true, branchCode: true, partnerCode: true, remainingAmount: true },
        })
      : [];
    const depositByCode = new Map(deposits.map((deposit) => [deposit.code, deposit]));
    const amountByDeposit = new Map<string, number>();
    for (const row of refundRows) {
      const code = text(row.values.deposit_code);
      const deposit = depositByCode.get(code);
      const amount = Math.round(numberValue(row.values.debit_amount));
      amountByDeposit.set(code, (amountByDeposit.get(code) || 0) + amount);
      if (!deposit) addError(row, `Mã tiền cọc [${code}] không tồn tại`);
      else {
        if (deposit.branchCode !== text(row.values.branch_code)) addError(row, `Tiền cọc [${code}] không thuộc cửa hàng đã khai báo`);
        if (deposit.partnerCode !== text(row.values.partner_code)) addError(row, `Tiền cọc [${code}] không thuộc đối tác đã khai báo`);
      }
    }
    for (const row of refundRows) {
      const code = text(row.values.deposit_code);
      const deposit = depositByCode.get(code);
      if (deposit && (amountByDeposit.get(code) || 0) > deposit.remainingAmount + 1) {
        addError(row, `Tổng hoàn cọc [${code}] vượt số dư cọc còn lại`);
      }
    }

    await fillWalletGrossFromPosRevenue(result.rows, masterItems);

    // Commit khóa sổ theo CẢ HAI mốc ngày, và chỉ cần một dòng vướng kỳ đã khóa là rollback
    // sạch batch. Preview vì vậy phải soi đủ hai mốc, nếu không người dùng sẽ thấy file "hợp lệ"
    // rồi chết ở bước Commit mà không biết dòng nào sai.
    //
    // Không soi accounting_date nữa: cột "Ngày hạch toán" đã bỏ khỏi file nên giá trị luôn bằng
    // Ngày giao dịch — để lại thì thông báo lỗi chỉ vào một cột người dùng không hề có.
    const bankStatementPeriodFields = [
      { field: "transaction_date", label: "Ngày giao dịch" },
      { field: "source_date", label: "Ngày nguồn tiền" },
    ];
    const periodChecks = new Map<string, { date: Date; branchCode: string; labels: Set<string>; rows: Set<ParsedImportRow> }>();
    for (const row of result.rows) {
      const branchCode = text(row.values.branch_code);
      if (!branchCode) continue;
      for (const { field, label } of bankStatementPeriodFields) {
        const date = row.values[field] instanceof Date ? (row.values[field] as Date) : null;
        if (!date) continue;
        const key = `${branchCode}:${date.toISOString().slice(0, 7)}`;
        const current = periodChecks.get(key);
        if (current) {
          current.labels.add(label);
          current.rows.add(row);
        } else {
          periodChecks.set(key, { date, branchCode, labels: new Set([label]), rows: new Set([row]) });
        }
      }
    }
    for (const { date, branchCode, labels, rows } of periodChecks.values()) {
      if (await isPeriodLocked(date, branchCode)) {
        const period = date.toISOString().slice(0, 7);
        const fieldList = [...labels].join(" / ");
        for (const row of rows) addError(row, `Kỳ ${period} của ${branchCode} đã khóa (theo ${fieldList})`);
      }
    }
  }

  result.validRows = result.rows.filter((row) => row.errors.length === 0).length;
  result.errorRows = result.rows.length - result.validRows;
  return result;
}
