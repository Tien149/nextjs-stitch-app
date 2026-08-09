import { prisma } from "@/lib/prisma";
import { assertBranchAccess } from "@/lib/accounting";
import { isMasterDataImportType, normalizeHeader, type ImportType } from "@/lib/import-templates";
import type { ParsedImportResult, ParsedImportRow } from "@/lib/import-parser";
import type { DemoSession } from "@/lib/auth-demo";
import { isInboundStockType, isOutboundStockType, isStockTransactionType, normalizeStockTransactionType } from "@/lib/inventory-stock";
import { normalizeCashflowCategoryType } from "@/lib/voucher-rules";
import { ensureRevenuePosReference, revenuePosReferenceKey } from "@/lib/revenue-pos-reference";
import { groupBankStatementRows } from "@/lib/bank-statement-import";

type MasterItem = {
  type: string;
  code: string;
  name: string;
  group?: string | null;
  branch: string | null;
  status: string;
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

function validateBranch(row: ParsedImportRow, session: DemoSession, masterItems: MasterItem[]) {
  const branchCode = text(row.values.branch_code).toUpperCase();
  row.values.branch_code = branchCode;
  if (!branchCode || branchCode === "ALL") {
    addError(row, "Cửa hàng import là bắt buộc và không được chọn Admin / Tất cả cửa hàng");
    return;
  }
  try {
    assertBranchAccess(session, branchCode);
  } catch (error) {
    addError(row, error instanceof Error ? error.message : "Không có quyền với chi nhánh import");
  }
  const branch = resolveMaster(masterItems, "BRANCH", branchCode);
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

  const supplierInput = row.values.supplier_code || row.values.supplier_name;
  if (text(supplierInput)) {
    const supplier = resolveMaster(masterItems, "PARTNER", supplierInput, branchCode);
    if (supplier) {
      row.values.supplier_code = supplier.code;
      row.values.supplier_name = supplier.name;
    }
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

function normalizeBankStatementRow(row: ParsedImportRow, masterItems: MasterItem[], session: DemoSession) {
  row.values.transaction_code = text(row.values.transaction_code).toUpperCase();
  const debit = numberValue(row.values.debit_amount);
  const credit = numberValue(row.values.credit_amount);
  if ((debit <= 0 && credit <= 0) || (debit > 0 && credit > 0)) {
    addError(row, "Mỗi dòng sao kê phải có đúng một bên Ghi nợ hoặc Ghi có");
  }

  const rawSources = [
    row.values.summary_money_source_code,
    row.values.increase_money_source_code,
    row.values.decrease_money_source_code,
  ];
  let branchCode = text(row.values.branch_code).toUpperCase();
  if (!branchCode) {
    branchCode = rawSources
      .map((value) => resolveBankMoneySource(masterItems, value)?.branch || "")
      .find(Boolean) || "";
    row.values.branch_code = branchCode;
  }
  if (branchCode) validateBranch(row, session, masterItems);

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

  // Hướng Thu/Chi được kiểm tra lại theo số ròng của cả nhóm sau khi gom mã giao dịch.
  validateBankStatementCategory(row, masterItems, debit, credit, false);

  const increaseGroup = resolvedSources.increase_money_source_code?.group;
  const decreaseGroup = resolvedSources.decrease_money_source_code?.group;
  let autoProcessType = "MANUAL_REQUIRED";
  let autoProcessNote = "Thiếu thông tin để tự động tạo phiếu";
  if (credit > 0 && increaseGroup === "BANK" && decreaseGroup === "WALLET" && row.values.revenue_date) {
    autoProcessType = "WALLET_SETTLEMENT";
    autoProcessNote = "Đủ thông tin tạo phiếu quyết toán ví chờ duyệt";
  } else if (credit > 0 && increaseGroup === "BANK" && text(row.values.category_code)) {
    autoProcessType = "RECEIPT";
    autoProcessNote = "Đủ thông tin tạo phiếu thu chờ duyệt";
  } else if (debit > 0 && decreaseGroup === "BANK" && text(row.values.category_code)) {
    autoProcessType = "PAYMENT";
    autoProcessNote = "Đủ thông tin tạo phiếu chi chờ duyệt";
  }
  row.values.auto_process_type = autoProcessType;
  row.values.auto_process_note = autoProcessNote;
  row.values.import_action = "CREATE";
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
    where: { type: { in: ["BRANCH", "MONEY_SOURCE", "PARTNER", "REVENUE_EXPENSE_CATEGORY", "WAREHOUSE", "INVENTORY_ITEM_GROUP", "ASSET_GROUP", "DEPARTMENT"] } },
    select: { type: true, code: true, name: true, group: true, branch: true, status: true },
  });
  const inventoryItems = ["OPENING_BALANCE", "INVENTORY_TRANSACTION", "BOM", "STOCKTAKE", "REVENUE_POS"].includes(importType)
    ? await prisma.inventoryItem.findMany({ select: { code: true, itemType: true, status: true, unit: true, unitConversions: { select: { unitCode: true, conversionRate: true } } } })
    : [];
  const inventoryBalances = importType === "INVENTORY_TRANSACTION"
    ? await prisma.inventoryBalance.findMany({ include: { item: { select: { code: true } } } })
    : [];
  const existingAssetCodes = importType === "ASSET"
    ? new Set((await prisma.assetRecord.findMany({ where: { deletedAt: null }, select: { code: true } })).map((asset) => asset.code.toUpperCase()))
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
      if (["CASH", "BANK", "WALLET_POS", "DEPOSIT"].includes(balanceType) && !text(row.values.money_source_code)) {
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
      if (numberValue(row.values.gross_amount) < 0 || numberValue(row.values.net_amount) < 0) addError(row, "Doanh thu không được âm");
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
            transactionCode: { in: groups.map((group) => text(group.rows[0].values.transaction_code)) },
          },
          select: { id: true, transactionCode: true },
        })
      : [];
    const existingKeys = new Set(existing.map((row) => row.transactionCode.toUpperCase()));

    for (const group of groups) {
      const existingKey = text(group.rows[0].values.transaction_code).toUpperCase();
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
          row.values.auto_process_type = "MANUAL_REQUIRED";
          row.values.auto_process_note = `Loại thu/chi [${text(row.values.category_code)}] ngược chiều Nợ/Có — đã giữ phân loại của khách và chờ kiểm tra thủ công`;
        }
      }

      if (group.rows.length > 1) {
        if (!group.isMultiAllocation) {
          for (const row of group.rows) {
            row.values.auto_process_type = "MANUAL_REQUIRED";
            row.values.auto_process_note = "Mã giao dịch có cả Nợ và Có nhưng giá trị ròng khác 0 — cần kiểm tra thủ công";
          }
        } else {
          for (const row of group.rows) {
            row.values.import_action = "GROUP_ALLOCATION";
            row.values.auto_process_note = `Gộp ${group.rows.length} dòng thành 1 giao dịch; giữ từng ngày doanh thu ở bảng phân bổ`;
          }
        }
      }
    }
  }

  result.validRows = result.rows.filter((row) => row.errors.length === 0).length;
  result.errorRows = result.rows.length - result.validRows;
  return result;
}
