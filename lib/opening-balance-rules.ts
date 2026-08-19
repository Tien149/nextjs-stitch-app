import type { Prisma } from "@prisma/custom-client";
import { moneySourceMatchesBranch, normalizeMoneySourceGroup } from "@/lib/money-sources";

export const OPENING_BALANCE_EFFECTIVE_STATUSES = ["POSTED", "CONFIRMED"] as const;
export const CASH_SOURCE_OPENING_TYPES = ["CASH", "BANK", "WALLET_POS"] as const;

export const OPENING_BALANCE_TYPES = [
  "CASH", "BANK", "WALLET_POS", "AR", "AP", "DEPOSIT",
  "INVENTORY", "ASSET", "PREPAID_EXPENSE",
] as const;

export type OpeningBalanceInput = {
  period: string;
  branchCode: string;
  balanceType: string;
  objectCode: string | null;
  objectName: string | null;
  moneySourceCode: string | null;
  warehouseCode: string | null;
  departmentCode: string | null;
  quantity: number | null;
  unitCost: number | null;
  allocationMonths: number | null;
  allocationStartPeriod: string | null;
  amount: number;
  note: string | null;
};

export function normalizeOpeningBalanceInput(body: Record<string, unknown>): OpeningBalanceInput {
  const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
  const nullableText = (value: unknown) => text(value) || null;
  const number = (value: unknown) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const nullableNumber = (value: unknown) => value === undefined || value === null || value === "" ? null : number(value);

  return {
    period: text(body.period),
    branchCode: text(body.branchCode).toUpperCase(),
    balanceType: text(body.balanceType).toUpperCase(),
    objectCode: nullableText(body.objectCode)?.toUpperCase() || null,
    objectName: nullableText(body.objectName),
    moneySourceCode: nullableText(body.moneySourceCode)?.toUpperCase() || null,
    warehouseCode: nullableText(body.warehouseCode)?.toUpperCase() || null,
    departmentCode: nullableText(body.departmentCode)?.toUpperCase() || null,
    quantity: nullableNumber(body.quantity),
    unitCost: nullableNumber(body.unitCost),
    allocationMonths: nullableNumber(body.allocationMonths) === null ? null : Math.floor(number(body.allocationMonths)),
    allocationStartPeriod: nullableText(body.allocationStartPeriod),
    amount: number(body.amount),
    note: nullableText(body.note),
  };
}

export async function validateOpeningBalanceInput(tx: Prisma.TransactionClient, input: OpeningBalanceInput) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.period)) throw new Error("Kỳ số dư không hợp lệ (YYYY-MM)");
  if (!OPENING_BALANCE_TYPES.includes(input.balanceType as typeof OPENING_BALANCE_TYPES[number])) throw new Error("Loại số dư không hợp lệ");
  // Tài sản hết kỳ phân bổ vẫn còn hiện vật cần theo dõi — giá trị 0 hợp lệ, chỉ cấm âm.
  if (input.balanceType === "ASSET") {
    if (input.amount < 0) throw new Error("Giá trị tài sản đầu kỳ không được âm");
  } else if (!(input.amount > 0)) {
    throw new Error("Số tiền phải lớn hơn 0");
  }

  const branch = await tx.masterDataItem.findUnique({ where: { type_code: { type: "BRANCH", code: input.branchCode } } });
  if (!branch || branch.status !== "ACTIVE") throw new Error(`Cửa hàng [${input.branchCode}] không tồn tại hoặc đã ngừng hoạt động`);

  const needsSource = CASH_SOURCE_OPENING_TYPES.includes(input.balanceType as typeof CASH_SOURCE_OPENING_TYPES[number]);
  if (needsSource) {
    if (!input.moneySourceCode) throw new Error("Bắt buộc chọn nguồn tiền");
    const source = await tx.masterDataItem.findUnique({ where: { type_code: { type: "MONEY_SOURCE", code: input.moneySourceCode } } });
    if (!source || source.status !== "ACTIVE" || !moneySourceMatchesBranch(source, input.branchCode)) {
      throw new Error(`Nguồn tiền [${input.moneySourceCode}] không còn hợp lệ hoặc không thuộc cửa hàng đã chọn`);
    }
    const expected = input.balanceType === "WALLET_POS" ? "WALLET" : input.balanceType;
    if (input.balanceType !== "DEPOSIT" && normalizeMoneySourceGroup(source.group) !== expected) {
      throw new Error(`Nguồn tiền [${input.moneySourceCode}] không đúng nhóm ${expected}`);
    }
  }

  if (["AR", "AP", "DEPOSIT"].includes(input.balanceType)) {
    if (!input.objectCode) throw new Error("Bắt buộc chọn đối tượng công nợ/tiền cọc");
    const partner = await tx.masterDataItem.findUnique({ where: { type_code: { type: "PARTNER", code: input.objectCode } } });
    if (!partner || partner.status !== "ACTIVE") throw new Error(`Đối tác [${input.objectCode}] không còn hợp lệ`);
    // Dữ liệu PROD trước đây cho phép chọn mọi đối tác ACTIVE cho AR/AP/DEPOSIT.
    // Không siết partnerType tại đây để tránh làm mất tương thích với các mã lịch sử.
    input.objectName = partner.name;
  }

  if (input.balanceType === "INVENTORY" && (!input.objectCode || !input.warehouseCode || !(input.quantity && input.quantity > 0) || !(input.unitCost && input.unitCost > 0))) {
    throw new Error("Tồn kho đầu kỳ cần mặt hàng, kho, số lượng và đơn giá lớn hơn 0");
  }
  if (input.balanceType === "INVENTORY") {
    const [item, warehouse] = await Promise.all([
      tx.inventoryItem.findUnique({ where: { code: input.objectCode || "" } }),
      tx.masterDataItem.findUnique({ where: { type_code: { type: "WAREHOUSE", code: input.warehouseCode || "" } } }),
    ]);
    if (!item || item.status !== "ACTIVE") throw new Error(`Mặt hàng [${input.objectCode}] không còn hợp lệ`);
    if (!warehouse || warehouse.status !== "ACTIVE" || warehouse.branch !== input.branchCode) {
      throw new Error(`Kho [${input.warehouseCode}] không còn hợp lệ hoặc không thuộc cửa hàng đã chọn`);
    }
  }
  // Nguyên giá không bắt buộc: khách theo dõi quản trị, tài sản hết khấu hao giá trị 0
  // vẫn phải nhập được. Chỉ cần mã, tên, số lượng; đơn giá có khai thì không được âm.
  if (input.balanceType === "ASSET" && (!input.objectCode || !input.objectName || !(input.quantity && input.quantity > 0))) {
    throw new Error("Tài sản đầu kỳ cần mã, tên và số lượng lớn hơn 0");
  }
  if (input.balanceType === "ASSET" && input.unitCost !== null && input.unitCost < 0) {
    throw new Error("Đơn giá tài sản đầu kỳ không được âm");
  }
  if (input.balanceType === "PREPAID_EXPENSE" && (!input.objectCode || !input.allocationStartPeriod || !input.allocationMonths || input.allocationMonths <= 1)) {
    throw new Error("Chi phí phân bổ cần mã, kỳ bắt đầu và số kỳ lớn hơn 1");
  }
}
