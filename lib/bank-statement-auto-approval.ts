import { normalizeHeader } from "@/lib/import-templates";
import { normalizeMoneySourceGroup } from "@/lib/money-sources";
import { normalizeCashflowCategoryType } from "@/lib/voucher-rules";
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
  /** Mã người dùng khai trên file. Khi danh mục không tìm thấy thì đây là thứ duy nhất còn lại
   *  để gọi tên đúng chỗ sai; thiếu nó thông báo chỉ nói được "(trống)". */
  categoryCodeText?: string | null;
  increaseSourceCodeText?: string | null;
  decreaseSourceCodeText?: string | null;
};

export type BankStatementApprovalDecision = {
  autoApprove: boolean;
  reason: string;
};

/** Gọi tên đúng thứ đang sai, để người đọc biết phải đi sửa cái nào chứ không phải đoán. */
function label(item?: MasterReference | null, rawCode?: string | null) {
  if (!item) return rawCode ? `[${rawCode}]` : "";
  return item.name ? `${item.name} (${item.code})` : item.code;
}

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
    return { autoApprove: false, reason: "Thiếu Cửa hàng hoặc số tiền — bổ sung trên file sao kê rồi import lại" };
  }

  const increaseGroup = normalizeMoneySourceGroup(input.increaseSource?.group);
  const decreaseGroup = normalizeMoneySourceGroup(input.decreaseSource?.group);

  if (processType === "WALLET_SETTLEMENT") {
    const categoryValue = normalizeHeader(`${input.category?.code || ""} ${input.category?.name || ""}`);
    if (!active(input.category) || !categoryValue.includes("thu") || !categoryValue.includes("ban hang")) {
      return { autoApprove: false, reason: `Quyết toán ví phải mang loại thu bán hàng, file đang khai ${label(input.category, input.categoryCodeText) || "(trống)"} — sửa cột Loại thu/chi trên file, hoặc bật lại khoản mục ở Danh mục → Khoản mục thu chi` };
    }
    if (!active(input.increaseSource) || increaseGroup !== "BANK") {
      return { autoApprove: false, reason: `Nguồn tiền nhận ${label(input.increaseSource, input.increaseSourceCodeText) || "(trống)"} không phải tài khoản ngân hàng đang hoạt động — khai lại ở Danh mục → Nguồn tiền (nhóm phải là Ngân hàng, trạng thái Đang hoạt động)` };
    }
    if (!active(input.decreaseSource) || decreaseGroup !== "WALLET") {
      return { autoApprove: false, reason: `Nguồn tiền đi ${label(input.decreaseSource, input.decreaseSourceCodeText) || "(trống)"} không phải ví/POS đang hoạt động — khai lại ở Danh mục → Nguồn tiền (nhóm phải là Ví)` };
    }
    if (!input.revenueDate) {
      return { autoApprove: false, reason: "Thiếu Ngày doanh thu — bổ sung cột Ngày doanh thu trên file sao kê rồi import lại" };
    }
    // Gross ví thuộc luồng doanh thu POS. Khai thiếu thì vẫn ghi nhận tiền đã về ngân hàng,
    // phần phí để đối chiếu sau; chỉ chặn khi khai một con số mâu thuẫn với sao kê.
    if (input.walletGrossAmount && input.walletGrossAmount < amount) {
      return { autoApprove: false, reason: `Gross ví khai ${input.walletGrossAmount?.toLocaleString("vi-VN")} nhỏ hơn tiền ngân hàng đã nhận ${amount.toLocaleString("vi-VN")} — sửa cột Gross trên file, hoặc để trống để hệ thống tự suy từ doanh thu POS` };
    }
    return { autoApprove: true, reason: "Đủ điều kiện tự động duyệt quyết toán ví" };
  }

  if (!["RECEIPT", "PAYMENT"].includes(processType)) {
    return { autoApprove: false, reason: `Loại nghiệp vụ ${processType || "(trống)"} chưa tự lập được chứng từ — cần kế toán xử lý tay` };
  }
  if (!active(input.category)) {
    return { autoApprove: false, reason: `Khoản mục thu/chi ${label(input.category, input.categoryCodeText) || "(trống)"} không tồn tại hoặc đã ngưng hoạt động — bật lại ở Danh mục → Khoản mục thu chi, hoặc sửa cột Loại thu/chi trên file` };
  }
  const categoryType = normalizeCashflowCategoryType(input.category?.group);
  if (processType === "RECEIPT") {
    if (categoryType !== "RECEIPT") {
      return { autoApprove: false, reason: `Tiền vào nhưng khoản mục ${label(input.category, input.categoryCodeText)} lại thuộc nhóm chi — đổi sang một khoản mục Thu trên file` };
    }
    if (!active(input.increaseSource) || increaseGroup !== "BANK") {
      return { autoApprove: false, reason: `Nguồn tiền tăng ${label(input.increaseSource, input.increaseSourceCodeText) || "(trống)"} không phải tài khoản ngân hàng đang hoạt động — khai lại ở Danh mục → Nguồn tiền` };
    }
  }
  if (processType === "PAYMENT") {
    if (categoryType !== "PAYMENT") {
      return { autoApprove: false, reason: `Tiền ra nhưng khoản mục ${label(input.category, input.categoryCodeText)} lại thuộc nhóm thu — đổi sang một khoản mục Chi trên file` };
    }
    if (!active(input.decreaseSource) || decreaseGroup !== "BANK") {
      return { autoApprove: false, reason: `Nguồn tiền giảm ${label(input.decreaseSource, input.decreaseSourceCodeText) || "(trống)"} không phải tài khoản ngân hàng đang hoạt động — khai lại ở Danh mục → Nguồn tiền` };
    }
  }

  return { autoApprove: true, reason: "Đủ điều kiện tự động duyệt theo sao kê ngân hàng" };
}
