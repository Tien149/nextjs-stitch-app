import { prisma } from "@/lib/prisma";
import { assertBranchAccess } from "@/lib/accounting";
import { normalizeHeader, type ImportType } from "@/lib/import-templates";
import type { ParsedImportResult, ParsedImportRow } from "@/lib/import-parser";
import type { DemoSession } from "@/lib/auth-demo";
import { isInboundStockType, isOutboundStockType, isStockTransactionType, normalizeStockTransactionType } from "@/lib/inventory-stock";

type MasterItem = {
  type: string;
  code: string;
  name: string;
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
  const candidates = items.filter(
    (item) => item.type === type && item.status === "ACTIVE" &&
      (item.code.toUpperCase() === value.toUpperCase() || normalizeHeader(item.name) === normalized),
  );
  return candidates.find((item) => item.branch === branchCode) ||
    candidates.find((item) => !item.branch || item.branch === "ALL") ||
    candidates[0] || null;
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
  else row.values.category_code = category.code;

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
  if (!from) addError(row, `Nguồn chuyển [${text(row.values.from_money_source_code)}] không tồn tại`);
  else row.values.from_money_source_code = from.code;
  if (!to) addError(row, `Nguồn nhận [${text(row.values.to_money_source_code)}] không tồn tại`);
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

export async function validateImportResult(
  result: ParsedImportResult,
  importType: ImportType,
  session: DemoSession,
) {
  const masterItems = await prisma.masterDataItem.findMany({
    where: { type: { in: ["BRANCH", "MONEY_SOURCE", "PARTNER", "REVENUE_EXPENSE_CATEGORY", "WAREHOUSE"] } },
    select: { type: true, code: true, name: true, branch: true, status: true },
  });
  const inventoryItems = ["OPENING_BALANCE", "INVENTORY_TRANSACTION", "BOM", "STOCKTAKE", "REVENUE_POS"].includes(importType)
    ? await prisma.inventoryItem.findMany({ select: { code: true, itemType: true, status: true, unit: true, unitConversions: { select: { unitCode: true, conversionRate: true } } } })
    : [];
  const inventoryBalances = importType === "INVENTORY_TRANSACTION"
    ? await prisma.inventoryBalance.findMany({ include: { item: { select: { code: true } } } })
    : [];

  const branchTypes: ImportType[] = ["VOUCHER", "INTERNAL_TRANSFER", "DEBT_OPENING", "OPENING_BALANCE", "REVENUE_POS", "PAYROLL", "INVENTORY_TRANSACTION", "STOCKTAKE"];
  const openingBalanceKeys = new Set<string>();
  const revenueStockUsage = new Map<string, number>();
  for (const row of result.rows) {
    if (branchTypes.includes(importType)) validateBranch(row, session, masterItems);

    if (importType === "VOUCHER") validateVoucher(row, masterItems);
    if (importType === "INTERNAL_TRANSFER") validateTransfer(row, masterItems);
    if (importType === "DEBT_OPENING") validateDebt(row, masterItems);
    if (importType === "INVENTORY_TRANSACTION") validateInventoryTransaction(row, masterItems, inventoryItems, inventoryBalances);
    if (importType === "BOM") validateBom(row, inventoryItems);
    if (importType === "STOCKTAKE") validateStocktake(row, masterItems, inventoryItems);
    if (importType === "INVENTORY_ITEM") {
      const itemType = normalizeItemType(row.values.item_type);
      row.values.item_type = itemType;
      if (!["RAW_MATERIAL", "SEMI_FINISHED", "FINISHED", "PACKAGING", "TOOL", "ASSET"].includes(itemType)) {
        addError(row, "Loại mặt hàng không hợp lệ");
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
      const debit = numberValue(row.values.debit_amount);
      const credit = numberValue(row.values.credit_amount);
      if ((debit <= 0 && credit <= 0) || (debit > 0 && credit > 0)) addError(row, "Mỗi giao dịch phải có đúng một bên Ghi nợ hoặc Ghi có");
      if (text(row.values.branch_code)) validateBranch(row, session, masterItems);
    }
  }

  result.validRows = result.rows.filter((row) => row.errors.length === 0).length;
  result.errorRows = result.rows.length - result.validRows;
  return result;
}
