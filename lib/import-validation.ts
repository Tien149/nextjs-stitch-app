import { prisma } from "@/lib/prisma";
import { assertBranchAccess } from "@/lib/accounting";
import { normalizeHeader, type ImportType } from "@/lib/import-templates";
import type { ParsedImportResult, ParsedImportRow } from "@/lib/import-parser";
import type { DemoSession } from "@/lib/auth-demo";

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

export async function validateImportResult(
  result: ParsedImportResult,
  importType: ImportType,
  session: DemoSession,
) {
  const masterItems = await prisma.masterDataItem.findMany({
    where: { type: { in: ["BRANCH", "MONEY_SOURCE", "PARTNER", "REVENUE_EXPENSE_CATEGORY"] } },
    select: { type: true, code: true, name: true, branch: true, status: true },
  });
  const inventoryItems = importType === "OPENING_BALANCE"
    ? await prisma.inventoryItem.findMany({ select: { code: true, status: true } })
    : [];

  const branchTypes: ImportType[] = ["VOUCHER", "INTERNAL_TRANSFER", "DEBT_OPENING", "OPENING_BALANCE", "REVENUE_POS", "PAYROLL"];
  const openingBalanceKeys = new Set<string>();
  for (const row of result.rows) {
    if (branchTypes.includes(importType)) validateBranch(row, session, masterItems);

    if (importType === "VOUCHER") validateVoucher(row, masterItems);
    if (importType === "INTERNAL_TRANSFER") validateTransfer(row, masterItems);
    if (importType === "DEBT_OPENING") validateDebt(row, masterItems);
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
