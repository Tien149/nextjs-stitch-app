import { normalizeHeader } from "@/lib/import-templates";
import { normalizeMoneySourceGroup } from "@/lib/money-sources";
import { normalizeCashflowCategoryType } from "@/lib/voucher-rules";
import { bankStatementSpecialCategory } from "@/lib/bank-statement-category";

export { bankStatementSpecialCategory } from "@/lib/bank-statement-category";

type MasterReference = {
  code: string;
  name?: string | null;
  group?: string | null;
  status?: string | null;
};

export type BankStatementApprovalInput = {
  autoProcessType: string;
  debitAmount: number;
  creditAmount: number;
  branchCode: string;
  revenueDate?: Date | null;
  increaseSource?: MasterReference | null;
  decreaseSource?: MasterReference | null;
  category?: MasterReference | null;
  walletGrossAmount?: number | null;
};

export type BankStatementApprovalDecision = {
  autoApprove: boolean;
  reason: string;
};

function active(item?: MasterReference | null) {
  return Boolean(item && item.status === "ACTIVE");
}

/**
 * Quyết định trạng thái ngay tại thời điểm commit sao kê.
 *
 * Auto-approve chỉ áp dụng cho dữ liệu đã đủ căn cứ hạch toán. Các dòng thiếu danh mục,
 * sai chiều nguồn hoặc cần sinh thêm hệ quả cọc/công nợ/phân bổ vẫn để kế toán xử lý tay.
 */
export function evaluateBankStatementAutoApproval(
  input: BankStatementApprovalInput,
): BankStatementApprovalDecision {
  const processType = input.autoProcessType.toUpperCase();
  const amount = Math.round(input.creditAmount || input.debitAmount);
  if (!input.branchCode || amount <= 0) {
    return { autoApprove: false, reason: "Thiếu chi nhánh hoặc số tiền hợp lệ" };
  }

  const increaseGroup = normalizeMoneySourceGroup(input.increaseSource?.group);
  const decreaseGroup = normalizeMoneySourceGroup(input.decreaseSource?.group);

  if (processType === "WALLET_SETTLEMENT") {
    const categoryValue = normalizeHeader(`${input.category?.code || ""} ${input.category?.name || ""}`);
    if (!active(input.category) || !categoryValue.includes("thu") || !categoryValue.includes("ban hang")) {
      return { autoApprove: false, reason: "Loại thu phải là Thu Tiền Từ Bán Hàng Tại Nhà Hàng" };
    }
    if (!active(input.increaseSource) || increaseGroup !== "BANK") {
      return { autoApprove: false, reason: "Nguồn tiền nhận phải là tài khoản ngân hàng đang hoạt động" };
    }
    if (!active(input.decreaseSource) || decreaseGroup !== "WALLET") {
      return { autoApprove: false, reason: "Nguồn tiền đi phải là ví/POS đang hoạt động" };
    }
    if (!input.revenueDate) {
      return { autoApprove: false, reason: "Thiếu ngày doanh thu để quyết toán ví" };
    }
    if (!input.walletGrossAmount || input.walletGrossAmount < amount) {
      return { autoApprove: false, reason: "Không đủ doanh thu ví để clear số tiền ngân hàng" };
    }
    return { autoApprove: true, reason: "Đủ điều kiện tự động duyệt quyết toán ví" };
  }

  if (!["RECEIPT", "PAYMENT"].includes(processType)) {
    return { autoApprove: false, reason: "Loại xử lý cần kiểm tra thủ công" };
  }
  if (!active(input.category)) {
    return { autoApprove: false, reason: "Khoản mục thu/chi không tồn tại hoặc đã ngưng hoạt động" };
  }
  const specialCategory = bankStatementSpecialCategory(input.category);
  // Thu cọc qua ngân hàng có đủ căn cứ để tạo phiếu cọc ngay. Các nghiệp vụ đặc biệt
  // còn lại vẫn cần mã tham chiếu hoặc thông tin phân bổ nên không được tự duyệt.
  if (specialCategory && !(specialCategory === "DEPOSIT" && processType === "RECEIPT")) {
    return { autoApprove: false, reason: "Khoản mục cọc/công nợ/phân bổ cần bổ sung thông tin nghiệp vụ" };
  }

  const categoryType = normalizeCashflowCategoryType(input.category?.group);
  if (processType === "RECEIPT") {
    if (categoryType !== "RECEIPT") {
      return { autoApprove: false, reason: "Khoản mục thu/chi không đúng chiều tiền vào" };
    }
    if (!active(input.increaseSource) || increaseGroup !== "BANK") {
      return { autoApprove: false, reason: "Nguồn tiền tăng phải là tài khoản ngân hàng đang hoạt động" };
    }
  }
  if (processType === "PAYMENT") {
    if (categoryType !== "PAYMENT") {
      return { autoApprove: false, reason: "Khoản mục thu/chi không đúng chiều tiền ra" };
    }
    if (!active(input.decreaseSource) || decreaseGroup !== "BANK") {
      return { autoApprove: false, reason: "Nguồn tiền giảm phải là tài khoản ngân hàng đang hoạt động" };
    }
  }

  return { autoApprove: true, reason: "Đủ điều kiện tự động duyệt theo sao kê ngân hàng" };
}
