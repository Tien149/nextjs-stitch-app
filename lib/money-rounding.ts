import { Prisma } from "@prisma/custom-client";

/**
 * Làm tròn TIỀN tới đồng ngay lúc ghi sổ.
 *
 * Số lẻ sinh ra ở khắp nơi — phân bổ chia đều theo kỳ, phí app/ví theo %, giá vốn bình quân
 * nhân số lượng, file import khai số lẻ — rồi cộng dồn lên báo cáo thành "1.923.347.490,265 đ"
 * (khách báo 21/09/2026). Chặn ở tầng hiển thị chỉ giấu số lẻ đi, số trong sổ vẫn lẻ và xuất
 * Excel ra vẫn lẻ.
 *
 * LUẬT: chỉ những trường trong danh sách dưới mới bị làm tròn, tức là TIỀN tính bằng đồng.
 * KHÔNG đụng tới:
 *  - số lượng (0,2 KG tròn thành 0 là báo sai tồn kho),
 *  - hệ số quy đổi, tỷ lệ hao hụt, tỷ lệ %,
 *  - ĐƠN GIÁ theo ĐVT nhỏ (nguyên liệu tính theo g/ml có giá vốn 0,35 đ/g — tròn đồng là
 *    mất sạch giá vốn), nên `unitCost`, `inputUnitCost`, `averageCost`, `estimatedUnitCost`
 *    đều đứng ngoài. Thành tiền của dòng (`totalCost`) thì có làm tròn.
 */
export const MONEY_FIELDS: Record<string, readonly string[]> = {
  Document: ["amount"],
  Deposit: ["amount", "remainingAmount"],
  DepositHistory: ["amount"],
  OpeningBalance: ["amount"],
  BankStatementTransaction: ["debitAmount", "creditAmount", "balanceAfter", "grossAmount", "grabExpenseAmount", "cardFeeAmount"],
  BankStatementAllocation: ["debitAmount", "creditAmount", "grossAmount", "grabExpenseAmount", "cardFeeAmount"],
  RevenueImportRow: ["grossAmount", "discountAmount", "vatAmount", "feeAmount", "cardFeeAmount", "appFeeAmount", "netAmount"],
  FinancialVoucher: ["amount"],
  DebtRecord: ["originalAmount", "outstandingAmount"],
  DebtSettlement: ["amount"],
  VoucherAllocation: ["amount"],
  AssetRecord: ["originalCost", "currentValue", "accumulatedDepreciation", "residualValue", "payableAmount", "disposalAmount"],
  ReconciliationMatch: ["targetAmount", "matchedAmount"],
  SupplierQuote: ["totalAmount"],
  SupplierQuoteLine: ["totalCost"],
  PurchaseOrder: ["totalAmount"],
  PurchaseOrderLine: ["totalCost"],
  SupplierPayable: ["originalAmount", "outstandingAmount"],
  Recipe: ["sellingPrice"],
  InventoryTransactionLine: ["totalCost"],
  AssetDepreciation: ["depreciationAmount", "accumulatedDepreciation", "remainingValue"],
  AssetMaintenance: ["cost"],
  AssetDamageReport: ["repairCost"],
  CashbookAdjustment: ["amount"],
  MoneyTransfer: ["amount", "feeAmount", "grabExpenseAmount"],
  MoneyTransferDenomination: ["amount"],
  ManualRevenueEntry: ["cashAmount", "transferAmount", "cardAmount", "grabAmount", "otherAmount", "totalAmount"],
  Accrual: ["totalAmount", "actualAmount"],
  AccrualSchedule: ["amount"],
  CostReallocation: ["totalAmount"],
  CostReallocationLine: ["amount"],
  JournalLine: ["debit", "credit"],
  PayrollImportRow: ["baseSalary", "allowanceAmount", "bonusAmount", "insuranceAmount", "taxAmount", "deductionAmount", "netAmount"],
  PayrollDepartmentRow: ["monthlySalary", "hourlySalary", "mealAllowance", "parkingAllowance", "svcAmount", "kpiAmount", "otherAllowance", "companyInsurance", "mandatoryInsurance", "totalCompanyCost", "netAmount"],
  ForecastAssumption: ["amount"],
  ReportTarget: ["targetValue"],
};

/**
 * Tròn tới đồng, đối xứng quanh 0: -1,5 ra -2 chứ không phải -1 như `Math.round`.
 * Tiền âm (giảm trừ, hoàn tiền) phải tròn cùng độ lớn với tiền dương, nếu không hai vế của
 * một cặp bút toán lệch nhau 1 đồng.
 */
export function roundVnd(value: number) {
  if (!Number.isFinite(value)) return value;
  return Math.sign(value) * Math.round(Math.abs(value));
}

/** Model -> tên quan hệ -> model đích, để đi xuống các nhánh ghi lồng (`lines: { create: [...] }`). */
const relationTargets = new Map<string, Map<string, string>>(
  Prisma.dmmf.datamodel.models.map((model) => [
    model.name,
    new Map(model.fields.filter((field) => field.kind === "object").map((field) => [field.name, field.type])),
  ]),
);

/** Ghi lồng của Prisma: các nhánh bên trong vẫn là data của model đích. */
const NESTED_KEYS = ["create", "update", "upsert", "createMany", "updateMany", "connectOrCreate"] as const;

function roundValue(value: unknown): unknown {
  if (typeof value === "number") return roundVnd(value);
  // Dạng { increment: n } / { decrement: n } / { set: n } / { multiply: n }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 0 && entries.every(([key]) => ["increment", "decrement", "set", "multiply", "divide"].includes(key))) {
      // `multiply`/`divide` là hệ số, không phải tiền — chỉ tròn vế cộng/trừ/gán.
      return Object.fromEntries(entries.map(([key, inner]) =>
        ["increment", "decrement", "set"].includes(key) && typeof inner === "number" ? [key, roundVnd(inner)] : [key, inner]));
    }
  }
  return value;
}

/**
 * Làm tròn tại chỗ mọi trường tiền trong một payload ghi, đi xuống cả các nhánh ghi lồng.
 * Trả về chính đối tượng đã truyền vào (Prisma dùng lại `args` nên sửa tại chỗ là đủ).
 */
export function roundMoneyWrite(model: string | undefined, data: unknown): unknown {
  if (!model || !data || typeof data !== "object") return data;
  if (Array.isArray(data)) {
    for (const entry of data) roundMoneyWrite(model, entry);
    return data;
  }
  const fields = MONEY_FIELDS[model];
  const relations = relationTargets.get(model);
  const record = data as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (fields?.includes(key)) {
      record[key] = roundValue(value);
      continue;
    }
    // `data` lồng trong createMany/updateMany vẫn thuộc chính model này.
    if (key === "data") {
      roundMoneyWrite(model, value);
      continue;
    }
    const target = relations?.get(key);
    if (!target || !value || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      roundMoneyWrite(target, value);
      continue;
    }
    const branch = value as Record<string, unknown>;
    let touched = false;
    for (const nested of NESTED_KEYS) {
      if (branch[nested] !== undefined) {
        roundMoneyWrite(target, branch[nested]);
        touched = true;
      }
    }
    // `{ lines: { ...fields } }` (ghi lồng rút gọn) thì chính nhánh đó là data của model đích.
    if (!touched) roundMoneyWrite(target, branch);
  }
  return data;
}

/**
 * Làm tròn các dòng của một bút toán mà vẫn giữ Nợ = Có.
 *
 * Tròn từng dòng rồi thôi là hỏng sổ: một vế 1.000,5 tròn lên 1.001 trong khi hai vế kia
 * 500,25 + 500,25 tròn xuống 500 + 500 — lệch 1 đồng và bút toán không vào sổ được. Nên
 * phần dôi ra được dồn hết vào dòng LỚN NHẤT của vế thiếu: sai số 1 đồng nằm ở dòng lớn
 * thì không ai đọc sai bản chất nghiệp vụ.
 */
export function roundJournalLines<T extends { debit?: number; credit?: number }>(lines: T[]): T[] {
  const rounded = lines.map((line) => ({ ...line, debit: roundVnd(line.debit || 0), credit: roundVnd(line.credit || 0) }));
  const debitTotal = rounded.reduce((sum, line) => sum + line.debit, 0);
  const creditTotal = rounded.reduce((sum, line) => sum + line.credit, 0);
  const gap = debitTotal - creditTotal;
  if (gap === 0) return rounded;
  const side: "debit" | "credit" = gap > 0 ? "credit" : "debit";
  let target = -1;
  for (let index = 0; index < rounded.length; index += 1) {
    if (rounded[index][side] <= 0) continue;
    if (target < 0 || rounded[index][side] > rounded[target][side]) target = index;
  }
  if (target < 0) return rounded;
  rounded[target][side] += Math.abs(gap);
  return rounded;
}
