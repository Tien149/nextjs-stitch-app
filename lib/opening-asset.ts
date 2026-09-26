/**
 * Tài sản / CCDC khai ở số dư đầu kỳ khi đang PHÂN BỔ DỞ (khách gửi danh sách CCDC 26/09/2026):
 * mỗi dòng có nguyên giá ban đầu, tổng số kỳ, số kỳ + giá trị đã phân bổ trước khi lên hệ thống,
 * và giá trị + số kỳ còn lại. Hệ thống chỉ phân bổ tiếp PHẦN CÒN LẠI, chia đều cho số kỳ còn lại.
 *
 * Mọi nơi (form nhập tay, import, chạy khấu hao, danh sách tài sản) đọc qua đây để cùng một luật.
 */

export type OpeningAssetInput = {
  quantity?: number | null;
  unitCost?: number | null;
  /** Nguyên giá ban đầu (Tổng giá trị). */
  originalCost?: number | null;
  /** Tổng số kỳ phân bổ/khấu hao từ đầu. */
  totalPeriods?: number | null;
  depreciatedPeriods?: number | null;
  depreciatedAmount?: number | null;
  /** Số kỳ còn lại — chỉ để đối chiếu, suy được từ tổng − đã phân bổ. */
  remainingPeriods?: number | null;
  /** Giá trị còn lại (số dư đầu kỳ). */
  remainingValue?: number | null;
};

export type OpeningAssetValues = {
  originalCost: number;
  totalPeriods: number;
  depreciatedPeriods: number;
  depreciatedAmount: number;
  remainingPeriods: number;
  remainingValue: number;
};

const num = (value: number | null | undefined) => (typeof value === "number" && Number.isFinite(value) ? value : null);
/** Dung sai làm tròn: file khách tính đơn giá lẻ × số lượng rồi làm tròn từng ô. */
const TOLERANCE = 5;

/**
 * Chuẩn hoá một dòng tài sản đầu kỳ. Khai thiếu ô nào thì suy từ các ô còn lại; khai đủ mà
 * lệch nhau thì trả lỗi để chặn ngay ở bước xem trước, không đoán bừa.
 */
export function resolveOpeningAsset(input: OpeningAssetInput): { values: OpeningAssetValues; errors: string[] } {
  const errors: string[] = [];
  const quantity = num(input.quantity);
  const unitCost = num(input.unitCost);
  const depreciatedAmountRaw = num(input.depreciatedAmount);
  const remainingValueRaw = num(input.remainingValue);
  let originalCost = num(input.originalCost);
  if (originalCost === null && quantity !== null && unitCost !== null) originalCost = Math.round(quantity * unitCost);
  if (originalCost === null && remainingValueRaw !== null) originalCost = remainingValueRaw + (depreciatedAmountRaw || 0);
  originalCost = originalCost ?? 0;

  const depreciatedAmount = depreciatedAmountRaw ?? (remainingValueRaw !== null ? originalCost - remainingValueRaw : 0);
  const remainingValue = remainingValueRaw ?? originalCost - depreciatedAmount;

  const totalPeriods = Math.floor(num(input.totalPeriods) ?? 0);
  const remainingDeclared = num(input.remainingPeriods);
  const depreciatedPeriods = Math.floor(
    num(input.depreciatedPeriods) ?? (remainingDeclared !== null && totalPeriods > 0 ? totalPeriods - remainingDeclared : 0),
  );
  const remainingPeriods = Math.max(totalPeriods - depreciatedPeriods, 0);

  if (originalCost < 0 || depreciatedAmount < 0 || remainingValue < 0) errors.push("Nguyên giá, giá trị đã phân bổ và giá trị còn lại không được âm");
  if (Math.abs(originalCost - depreciatedAmount - remainingValue) > TOLERANCE) {
    errors.push(`Nguyên giá (${fmt(originalCost)}) phải bằng Giá trị đã phân bổ (${fmt(depreciatedAmount)}) + Giá trị còn lại (${fmt(remainingValue)})`);
  }
  if (quantity !== null && unitCost !== null && num(input.originalCost) !== null && Math.abs(quantity * unitCost - originalCost) > Math.max(TOLERANCE, quantity)) {
    errors.push(`Tổng giá trị (${fmt(originalCost)}) lệch Số lượng × Đơn giá (${fmt(quantity * unitCost)})`);
  }
  if (depreciatedPeriods < 0) errors.push("Số kỳ đã phân bổ không được âm");
  if (totalPeriods > 0 && depreciatedPeriods > totalPeriods) errors.push(`Số kỳ đã phân bổ (${depreciatedPeriods}) lớn hơn tổng số kỳ (${totalPeriods})`);
  if (remainingDeclared !== null && totalPeriods > 0 && Math.abs(remainingDeclared - remainingPeriods) > 0) {
    errors.push(`Số kỳ còn lại (${remainingDeclared}) phải bằng Tổng số kỳ (${totalPeriods}) − Số kỳ đã phân bổ (${depreciatedPeriods})`);
  }
  if (totalPeriods > 0 && remainingPeriods === 0 && remainingValue > TOLERANCE) {
    errors.push(`Đã hết kỳ phân bổ nhưng còn giá trị ${fmt(remainingValue)} — kiểm tra lại số kỳ còn lại`);
  }
  if (totalPeriods > 0 && remainingPeriods > 0 && remainingValue <= 0) {
    errors.push(`Còn ${remainingPeriods} kỳ nhưng giá trị còn lại bằng 0 — kiểm tra lại số kỳ còn lại`);
  }

  return {
    values: {
      originalCost: Math.round(originalCost),
      totalPeriods,
      depreciatedPeriods,
      depreciatedAmount: Math.round(depreciatedAmount),
      remainingPeriods,
      remainingValue: Math.round(Math.max(remainingValue, 0)),
    },
    errors,
  };
}

/**
 * Số khấu hao một kỳ của tài sản, tính trên PHẦN CÒN LẠI khi lên hệ thống chia cho số kỳ còn lại.
 * Tài sản mới (chưa phân bổ trước) thì đúng bằng (nguyên giá − thu hồi) / tổng số kỳ như cũ.
 */
export function assetMonthlyDepreciation(asset: {
  originalCost: number;
  residualValue: number;
  usefulLifeMonths: number | null;
  accumulatedDepreciation: number;
  openingDepreciatedPeriods: number;
}) {
  const periodsLeft = Math.max((asset.usefulLifeMonths || 1) - (asset.openingDepreciatedPeriods || 0), 1);
  return Math.round((asset.originalCost - (asset.accumulatedDepreciation || 0) - asset.residualValue) / periodsLeft);
}

function fmt(value: number) {
  return new Intl.NumberFormat("vi-VN").format(Math.round(value));
}

/** Số dư đầu kỳ loại ASSET, đủ các cột để dựng AssetRecord. */
export type OpeningAssetBalance = {
  id: string;
  period: string;
  branchCode: string;
  objectCode: string | null;
  objectName: string | null;
  moneySourceCode: string | null;
  warehouseCode: string | null;
  departmentCode: string | null;
  quantity: number | null;
  unitCost: number | null;
  allocationMonths: number | null;
  allocationStartPeriod: string | null;
  originalCost: number | null;
  depreciatedPeriods: number | null;
  depreciatedAmount: number | null;
  amount: number;
  note: string | null;
};

/**
 * Dữ liệu AssetRecord sinh từ một dòng số dư đầu kỳ ASSET. Nguyên giá là nguyên giá BAN ĐẦU,
 * giá trị còn lại là số dư, phần đã phân bổ trước khi lên hệ thống nằm ở accumulatedDepreciation
 * + openingDepreciatedPeriods để lần chạy khấu hao đầu tiên tiếp đúng kỳ kế tiếp.
 *
 * Trước đây nguyên giá lấy `unitCost || amount` — tài sản số lượng 30 thì nguyên giá chỉ bằng
 * giá một cái.
 */
export function openingAssetRecordData(balance: OpeningAssetBalance) {
  const { values } = resolveOpeningAsset({
    quantity: balance.quantity,
    unitCost: balance.unitCost,
    originalCost: balance.originalCost,
    totalPeriods: balance.allocationMonths,
    depreciatedPeriods: balance.depreciatedPeriods,
    depreciatedAmount: balance.depreciatedAmount,
    remainingValue: balance.amount,
  });
  const startPeriod = balance.allocationStartPeriod || balance.period;
  return {
    name: balance.objectName || balance.objectCode || "",
    branchCode: balance.branchCode,
    departmentCode: balance.departmentCode || null,
    assetGroup: balance.moneySourceCode || "ASSET",
    location: balance.warehouseCode || "Văn phòng",
    warehouseCode: balance.warehouseCode || null,
    quantity: balance.quantity || 1,
    purchaseDate: new Date(`${balance.period}-01T00:00:00Z`),
    originalCost: values.originalCost,
    currentValue: values.remainingValue,
    accumulatedDepreciation: values.depreciatedAmount,
    openingDepreciatedPeriods: values.depreciatedPeriods,
    usefulLifeMonths: values.totalPeriods > 0 ? values.totalPeriods : null,
    depreciationStartDate: values.totalPeriods > 0 ? new Date(`${startPeriod}-01T00:00:00Z`) : null,
    residualValue: 0,
    supplierName: "Nhà cung cấp số dư đầu kỳ",
    status: "IN_USE",
    openingBalanceId: balance.id,
    note: balance.note || "Khởi tạo từ số dư đầu kỳ",
  };
}
