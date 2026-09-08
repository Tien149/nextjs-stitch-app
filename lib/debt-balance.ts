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
