/**
 * Nối TAY một dòng sao kê với chứng từ ngân hàng đã có.
 *
 * Khách báo 21/09/2026: các dòng chi lương / chi bảo hiểm đang mang nhãn "CHƯA VÀO SỔ" kèm
 * lời nhắn "Phiếu UNC-... đã bị xóa; chờ đối soát thủ công", nhưng KHÔNG có nút nào để xử —
 * nút "Vào sổ" cũ chỉ hiện cho dòng tiền VÀO của nghiệp vụ Quyết toán ví. Tức là màn hình
 * giao một việc phải làm rồi không đưa công cụ nào để làm.
 *
 * Nối tay phục vụ cả hai ca:
 *  - Xoá nhầm: khôi phục chứng từ ở Thùng rác rồi nối lại dòng cũ (khôi phục KHÔNG tự nối,
 *    nó chỉ bỏ cờ xoá).
 *  - Xoá có chủ đích: lập chứng từ mới ở màn Chứng từ ngân hàng rồi nối vào.
 */

/** Chiều tiền của dòng sao kê: Ghi Nợ = tiền RA, Ghi Có = tiền VÀO. */
export function bankRowDirection(row: { debitAmount: number; creditAmount: number }) {
  return Math.round(row.creditAmount) > 0 ? ("RECEIPT" as const) : ("PAYMENT" as const);
}

/** Số tiền của dòng sao kê, không quan tâm chiều. */
export function bankRowAmount(row: { debitAmount: number; creditAmount: number }) {
  return Math.round(Math.max(row.creditAmount, row.debitAmount));
}

export type LinkableVoucher = {
  id: string;
  code: string;
  voucherType: string;
  status: string;
  branchCode: string;
  amount: number;
  documentChannel: string;
};

export type LinkableBankRow = {
  branchCode: string | null;
  debitAmount: number;
  creditAmount: number;
};

/**
 * Chứng từ này có nối được vào dòng sao kê kia không, và nếu không thì vì sao.
 *
 * Trả lý do bằng câu người dùng đọc được, vì đây là chỗ kế toán hay bị chặn nhất: cùng số
 * tiền nhưng khác cửa hàng, hoặc phiếu thu đem nối vào dòng chi.
 */
export function bankVoucherLinkError(row: LinkableBankRow, voucher: LinkableVoucher): string | null {
  if (voucher.documentChannel !== "BANK") {
    return `Chứng từ ${voucher.code} là phiếu tiền mặt, không nối được vào dòng sao kê ngân hàng.`;
  }
  if (voucher.status !== "APPROVED") {
    return `Chứng từ ${voucher.code} chưa được duyệt nên chưa nối được.`;
  }
  if (voucher.branchCode !== row.branchCode) {
    return `Chứng từ ${voucher.code} thuộc cửa hàng khác với dòng sao kê.`;
  }
  const direction = bankRowDirection(row);
  if (voucher.voucherType !== direction) {
    // Ghi Nợ = tiền ra tài khoản, phải là phiếu CHI. Nối ngược chiều là số dư ngân hàng đi
    // sai hướng đúng hai lần số tiền.
    return direction === "PAYMENT"
      ? `Dòng sao kê này là tiền RA (cột Ghi Nợ) nên phải nối với phiếu CHI, mà ${voucher.code} là phiếu thu.`
      : `Dòng sao kê này là tiền VÀO (cột Ghi Có) nên phải nối với phiếu THU, mà ${voucher.code} là phiếu chi.`;
  }
  const amount = bankRowAmount(row);
  if (Math.round(voucher.amount) !== amount) {
    return `Số tiền trên chứng từ ${voucher.code} (${Math.round(voucher.amount).toLocaleString("vi-VN")} đ) khác số tiền sao kê (${amount.toLocaleString("vi-VN")} đ).`;
  }
  return null;
}

/** Chứng từ ứng viên của một dòng: đủ điều kiện nối và chưa bị dòng khác chiếm. */
export function pickVoucherCandidates(
  row: LinkableBankRow,
  vouchers: LinkableVoucher[],
  takenVoucherIds: ReadonlySet<string>,
) {
  return vouchers.filter((voucher) => !takenVoucherIds.has(voucher.id) && bankVoucherLinkError(row, voucher) === null);
}
