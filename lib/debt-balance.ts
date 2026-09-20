/**
 * QUY ƯỚC DẤU của số dư công nợ — dùng chung cho bảng tổng hợp và ledger từng đối tác:
 * **dương = MÌNH NỢ đối tác (phải trả), âm = ĐỐI TÁC NỢ MÌNH (phải thu)**, đúng như cách màn
 * hình Công nợ gắn nhãn.
 *
 * Trước đây mỗi nguồn tự chọn dấu một kiểu: số dư đầu kỳ AR và AP cùng cộng dương (dù ngược
 * chiều nhau), khoản công nợ khai tay lại ngược chiều với số dư đầu kỳ, còn phiếu thu/chi bị
 * TRỪ vào số dư nên càng trả tiền nhà cung cấp thì nợ phải trả càng phình ra — đúng lỗi khách
 * báo: "thanh toán rồi mà công nợ lại tăng".
 *
 * Tách khỏi route để cùng một luật dấu được dùng ở cả ba chỗ (dòng ledger, phần gộp vào Đầu
 * kỳ, công thức Số dư) và để kiểm thử được.
 */

/** Số dư đầu kỳ: AP là mình nợ (+), AR là đối tác nợ mình (−). Cả hai đều lưu số dương. */
export function openingBalanceSigned(balanceType: string, amount: number) {
  return balanceType === "AP" ? amount : -amount;
}

/** Khoản công nợ khai tay hoặc sinh từ nghiệp vụ (nhập hàng, bảng lương, chi hộ). */
export function debtRecordSigned(debtType: string, outstandingAmount: number) {
  return debtType === "PAYABLE" ? outstandingAmount : -outstandingAmount;
}

/**
 * Khoản công nợ ghi theo số PHÁT SINH (còn nợ + đã gạch), không phải số còn nợ.
 *
 * Sổ công nợ ghi gộp: khoản nợ đứng nguyên số phát sinh, phiếu thu/chi gạch nợ đứng thành dòng
 * riêng đúng ngày và đúng số tiền của phiếu. Ghi theo số còn nợ như trước thì phiếu gạch nợ phải
 * giấu đi (kẻo trừ hai lần), và phần đối tác trả DƯ — tiền vào nhiều hơn khoản họ nợ — biến mất
 * khỏi sổ: khách báo 20/09/2026 Cô Thoa chuyển 119 triệu trả khoản chi hộ 59,8 triệu mà bảng
 * công nợ ghi "Đã cân" thay vì mình đang nợ lại cô 59,1 triệu.
 *
 * Cộng "còn nợ + đã gạch" thay vì lấy số gốc để số dư luôn khớp số còn nợ thật, kể cả khi khoản
 * nợ từng được sửa số gốc sau khi đã gạch một phần.
 */
export function debtRecordGrossSigned(debtType: string, outstandingAmount: number, settledAmount: number) {
  return debtRecordSigned(debtType, outstandingAmount + settledAmount);
}

/** Tiền khách đặt cọc còn giữ: đang cầm tiền của khách nên là một khoản phải trả. */
export function depositSigned(remainingAmount: number) {
  return remainingAmount;
}

/** Tiền vào tài khoản từ đối tác làm giảm phải thu; tiền ra làm giảm phải trả. */
export function bankSigned(creditAmount: number, debitAmount: number) {
  return creditAmount - debitAmount;
}

/** Phiếu thu làm giảm phải thu (+), phiếu chi làm giảm phải trả (−). */
export function voucherSigned(voucherType: string, amount: number) {
  return voucherType === "RECEIPT" ? amount : -amount;
}

/**
 * Các cột trên bảng tổng hợp giữ số dương để hiển thị cho dễ đọc; dấu nghiệp vụ chỉ áp ở đây.
 * `openingAmount`, `bankMatched` và `voucherNet` đã mang sẵn dấu theo các hàm ở trên.
 */
export function debtBalanceOf(row: {
  openingAmount: number;
  purchasePayable: number;
  debtPayable: number;
  debtReceivable: number;
  depositHolding: number;
  bankMatched: number;
  voucherNet: number;
}) {
  return row.openingAmount
    + row.purchasePayable
    + row.debtPayable
    - row.debtReceivable
    + row.depositHolding
    + row.bankMatched
    + row.voucherNet;
}
