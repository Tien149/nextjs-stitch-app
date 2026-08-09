# Kế hoạch import sao kê và tự tạo phiếu chờ duyệt

## 1. Bối cảnh

File khách cung cấp có hai nhóm dữ liệu trong sheet `Import chuyển khoản`:

- Cột màu vàng: dữ liệu gốc lấy từ sao kê ngân hàng.
- Cột màu xanh: thông tin nghiệp vụ khách đã phân loại, bao gồm ngày nguồn tiền, ngày doanh thu, loại thu/chi và nguồn tiền cộng/trừ.

Hiện tại hệ thống chủ yếu nhập dữ liệu sao kê, sau đó người dùng vẫn phải qua màn hình Đối soát để chọn lại nguyên nhân, nguồn tiền và thực hiện quyết toán ví. Việc này làm người dùng nhập lại thông tin đã có trong file.

## 2. Mục tiêu

Khi một dòng sao kê có đầy đủ và hợp lệ các cột nghiệp vụ màu xanh, hệ thống sẽ tự xác định loại chứng từ và tạo phiếu ở trạng thái `PENDING_REVIEW`.

Phiếu chờ duyệt chưa làm thay đổi số dư nguồn tiền và chưa hoàn tất đối soát. Chỉ khi phiếu được duyệt, hệ thống mới cập nhật nguồn tiền, ghi nhận phí nếu có và chuyển dòng sao kê thành `MATCHED`.

Các dòng thiếu thông tin, không hợp lệ hoặc không xác định được duy nhất chứng từ liên quan vẫn được import nhưng giữ trạng thái `UNMATCHED` để xử lý thủ công.

## 3. Mapping dữ liệu

| Cột trên file | Trường nghiệp vụ | Ý nghĩa |
| --- | --- | --- |
| Ngày nguồn tiền | `source_date` | Ngày ghi nhận biến động nguồn tiền |
| Ngày doanh thu | `revenue_date` | Ngày doanh thu dùng để đối chiếu ví/POS |
| Loại thu/chi | `category_code` | Khoản mục thu hoặc chi |
| Nguồn tiền tổng | `summary_money_source_code` | Nguồn tổng dùng cho báo cáo |
| Cộng nguồn tiền chi tiết | `increase_money_source_code` | Nguồn tiền được cộng khi phiếu được duyệt |
| Trừ nguồn tiền chi tiết | `decrease_money_source_code` | Nguồn tiền bị trừ khi phiếu được duyệt |

Hệ thống cần cho phép mapping theo mã hoặc tên danh mục nhưng phải chuẩn hóa về mã trước khi lưu.

## 4. Quy tắc phân loại chứng từ

### 4.1. Quyết toán ví/POS

Tạo `MoneyTransfer` có `transferPurpose = WALLET_SETTLEMENT` khi:

- Sao kê là tiền vào ngân hàng.
- Nguồn cộng thuộc nhóm `BANK`.
- Nguồn trừ thuộc nhóm `WALLET`.
- Có ngày doanh thu để xác định doanh thu đang treo ở ví.

Số thực nhận là số tiền ghi Có trên sao kê. Số tiền gốc ở ví được đối chiếu từ doanh thu theo cửa hàng, ngày doanh thu và nguồn ví. Chênh lệch giữa tiền gốc và tiền thực nhận được ghi nhận là phí.

Chỉ tự tạo phiếu khi xác định được duy nhất khoản doanh thu cần quyết toán. Nếu không xác định được, hệ thống giữ dòng sao kê ở trạng thái `UNMATCHED` và nêu rõ lý do.

### 4.2. Phiếu thu

Tạo `FinancialVoucher` loại `RECEIPT` khi:

- Sao kê là tiền vào.
- Khoản mục thuộc nhóm Thu.
- Không phải luồng chuyển từ ví/POS về ngân hàng.
- Nguồn tiền nhận hợp lệ và thuộc đúng cửa hàng.

### 4.3. Phiếu chi

Tạo `FinancialVoucher` loại `PAYMENT` khi:

- Sao kê là tiền ra.
- Khoản mục thuộc nhóm Chi.
- Nguồn tiền chi hợp lệ và thuộc đúng cửa hàng.

### 4.4. Dòng không đủ điều kiện tự động

Không tạo phiếu tự động nếu gặp một trong các trường hợp:

- Thiếu loại thu/chi hoặc nguồn tiền bắt buộc.
- Loại Thu/Chi không đúng chiều tiền vào/ra.
- Nguồn tiền không tồn tại, đã ngưng hoạt động hoặc sai cửa hàng.
- Không tìm được hoặc tìm được nhiều hơn một khoản doanh thu ví phù hợp.
- Số tiền ví gốc nhỏ hơn tiền thực nhận.
- Kỳ kế toán đã khóa.
- Đã có phiếu chờ duyệt hoặc đã duyệt cho cùng giao dịch sao kê.

## 5. Vòng đời trạng thái

```text
Import sao kê
    |
    +-- Dữ liệu xanh hợp lệ --> Tạo phiếu PENDING_REVIEW
    |                              |
    |                              +-- Duyệt --> APPROVED + cập nhật nguồn tiền + MATCHED
    |                              |
    |                              +-- Từ chối/hủy --> không cập nhật số dư + UNMATCHED
    |
    +-- Thiếu hoặc không hợp lệ --> Không tạo phiếu + UNMATCHED + ghi lý do
```

Trong thời gian phiếu chờ duyệt, dòng sao kê nên hiển thị trạng thái nghiệp vụ `PENDING_REVIEW` hoặc nhãn tương đương để không xuất hiện như một giao dịch chưa từng được xử lý.

## 6. Nguyên tắc an toàn và chống trùng

- Mỗi giao dịch ngân hàng chỉ được liên kết với một phiếu tự động còn hiệu lực.
- Chống trùng theo tài khoản ngân hàng và số giao dịch; đồng thời kiểm tra `externalRef` trên phiếu.
- Tạo dòng sao kê, phiếu chờ duyệt và liên kết giữa hai bên trong cùng transaction database.
- Việc duyệt phiếu, cập nhật nguồn tiền và chuyển sao kê sang `MATCHED` phải thực hiện trong cùng transaction.
- Nếu duyệt thất bại, toàn bộ thay đổi phải rollback.
- Import lại cùng file không được tạo thêm phiếu.
- Phiếu chờ duyệt chưa được tính vào số dư thực tế hoặc sổ kế toán.

## 7. Thay đổi dự kiến trong code

### Bước 1: Mở rộng dữ liệu import

- Bổ sung 5 trường màu xanh còn thiếu vào template sao kê; trường `category_code` (Loại thu/chi) đã có sẵn và tiếp tục được tái sử dụng.
- Thêm alias tương ứng với tiêu đề trong file khách.
- Mở rộng model `BankStatementTransaction` để lưu dữ liệu đã chuẩn hóa và trạng thái xử lý tự động.
- Tạo migration Prisma.

### Bước 2: Validation

- Kiểm tra định dạng ngày.
- Resolve mã/tên loại thu chi và nguồn tiền.
- Kiểm tra khoản mục đúng chiều Thu/Chi.
- Kiểm tra nguồn cộng/trừ đúng nhóm và đúng cửa hàng.
- Đánh dấu dòng đủ điều kiện tự động hoặc cần xử lý thủ công.

### Bước 3: Bộ phân loại chứng từ

- Tách logic dùng chung để xác định `RECEIPT`, `PAYMENT` hoặc `WALLET_SETTLEMENT`.
- Không gọi API HTTP từ luồng import; dùng service nghiệp vụ chung trong server.
- Trả về lý do cụ thể khi không thể tự tạo phiếu.

### Bước 4: Tạo phiếu chờ duyệt

- Phiếu Thu/Chi được tạo với `status = PENDING_REVIEW`.
- Quyết toán ví được tạo với `status = PENDING_REVIEW`.
- Lưu `externalRef` bằng mã giao dịch sao kê và tạo liên kết đối soát.
- Chưa chạy side effect nguồn tiền hoặc kế toán tại bước này.

Lưu ý: luồng `CREATE_WALLET_SETTLEMENT` hiện tại đang tạo phiếu `APPROVED` ngay. Luồng import phải dùng service mới hỗ trợ `PENDING_REVIEW`, không được tự động dùng nguyên trạng hành vi duyệt ngay hiện tại.

### Bước 5: Duyệt, từ chối và hủy

- Khi duyệt: áp dụng biến động nguồn tiền, phí, kế toán và chuyển sao kê thành `MATCHED`.
- Khi từ chối/hủy: không tác động số dư, gỡ trạng thái chờ xử lý và đưa sao kê về `UNMATCHED`.
- Ghi audit log cho các thao tác tạo, duyệt, từ chối và hủy.

### Bước 6: Giao diện

- Preview import hiển thị loại phiếu dự kiến và lỗi nghiệp vụ từng dòng.
- Sau import hiển thị tổng số phiếu chờ duyệt và số dòng cần xử lý thủ công.
- Màn hình Đối soát có nhãn hoặc bộ lọc `Chờ duyệt`.
- Cho phép mở nhanh phiếu liên kết từ dòng sao kê.

## 8. Kế hoạch test

### 8.1. Unit test

- Mapping đúng 6 tiêu đề cột xanh (gồm 5 trường mới và `category_code` có sẵn).
- Tiền vào từ ví sang ngân hàng được phân loại là `WALLET_SETTLEMENT`.
- Tiền vào trực tiếp ngân hàng được phân loại là `RECEIPT`.
- Tiền ra ngân hàng được phân loại là `PAYMENT`.
- Khoản mục Thu/Chi sai chiều bị từ chối tự động.
- Nguồn sai nhóm hoặc sai cửa hàng bị từ chối tự động.
- Phí ví bằng tiền gốc ở ví trừ tiền thực nhận.

### 8.2. Integration test

- Import tạo đúng một phiếu `PENDING_REVIEW` và liên kết đúng dòng sao kê.
- Phiếu chờ duyệt chưa thay đổi số dư.
- Duyệt phiếu cập nhật đúng nguồn cộng, nguồn trừ, phí và trạng thái `MATCHED`.
- Từ chối hoặc hủy phiếu đưa sao kê về `UNMATCHED`.
- Import lại không tạo phiếu trùng.
- Lỗi trong quá trình tạo hoặc duyệt rollback toàn bộ transaction.

### 8.3. UAT theo file khách

- Dòng MoMo: cộng Vietinbank, trừ `MOMO_EDC`, gắn đúng ngày doanh thu và tạo quyết toán ví chờ duyệt.
- Dòng VNPAY: cộng Vietinbank, trừ nguồn quẹt thẻ VNPAY và tạo quyết toán ví chờ duyệt.
- Dòng Grab: cộng Vietinbank, trừ nguồn GrabFood và tạo quyết toán ví chờ duyệt.
- Dòng thu chuyển khoản trực tiếp: tạo phiếu Thu chờ duyệt, không tạo quyết toán ví.
- Dòng thanh toán nhà cung cấp: tạo phiếu Chi chờ duyệt.
- Dòng thiếu cột xanh: import sao kê thành công nhưng giữ `UNMATCHED`.

## 9. Tiêu chí nghiệm thu

- Người dùng không phải chọn lại thông tin đã có đầy đủ trong các cột xanh.
- Mọi chứng từ sinh tự động đều ở trạng thái chờ duyệt.
- Trước khi duyệt không phát sinh thay đổi số dư hoặc sổ kế toán.
- Sau khi duyệt, nguồn tiền và phí được ghi nhận đúng, dòng sao kê chuyển thành `MATCHED`.
- Dòng không đủ điều kiện tự động có lý do rõ ràng và vẫn xử lý được tại màn hình Đối soát.
- Không phát sinh phiếu trùng khi import lại hoặc thao tác đồng thời.

## 10. Kết quả triển khai và UAT file khách ngày 09/08/2026

- Preview chính file `Theo dõi nguồn tiền.xlsx`: `118/118` dòng hợp lệ, `0` lỗi.
- `14` dòng đã tồn tại được đánh dấu `SKIP_EXISTING`; commit bỏ qua các dòng này thay vì rollback cả batch.
- Mã MoMo `126B26803UQ3M6KA` được gộp thành một giao dịch Có `113.852.047 đ`, kèm ba dòng phân bổ:
  - `31/07/2026`: `24.201.420 đ`.
  - `01/08/2026`: `46.661.172 đ`.
  - `02/08/2026`: `42.989.455 đ`.
- Tám cặp giao dịch VPBank có Nợ/Có bằng nhau được lưu với trạng thái `NET_ZERO`, không tạo phiếu và không ảnh hưởng dòng tiền.
- Các dòng có Loại thu/chi ngược chiều Nợ/Có vẫn được import, giữ nguyên lựa chọn của khách và chuyển sang `MANUAL_REQUIRED` để kiểm tra; không tự tạo sai phiếu.
- Commit UAT tạo `94` giao dịch ngân hàng mới, `104` dòng phân bổ và `45` phiếu chờ duyệt. Hai batch UAT đã rollback thành công; không còn giao dịch, phiếu hay phân bổ UAT sống trong database.
- Đã sửa đọc ngày Excel theo serial để không bị lùi một ngày do timezone máy chủ.
