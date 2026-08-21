# Dọn dữ liệu tiền cọc bị số mẫu 50.000.000

## Nguyên nhân

Form tạo phiếu thu/chi (`app/vouchers/page.tsx`) đặt sẵn `amount: "50000000"` trong
`emptyForm`. Người lập không gõ đè thì phiếu lưu đúng con số mẫu đó; và mỗi lần form bị
reset (đổi cửa hàng, đổi đối tác, huỷ sửa) hệ thống ghi lại 50.000.000 vào ô Số tiền mà
không báo gì. Mọi lớp kiểm tra đều cho qua vì 50.000.000 vẫn là một số hợp lệ.

Form phiếu cọc (`app/deposits/page.tsx`) từng có đúng lỗi này, đã bỏ ở commit `83de70c`.
Dữ liệu tạo trước đợt đó vẫn còn mang số mẫu.

Hệ quả trên dữ liệu: cùng một khoản tiền được lưu ở 4 nơi — phiếu cọc, lịch sử cọc, chứng
từ thu/chi, bút toán sổ cái. Sửa lại số tiền ở một màn hình mà các bản ghi dẫn xuất không
được cập nhật theo thì màn Tiền cọc hiện 1.000.000 trong khi sổ quỹ / báo cáo vẫn đọc
50.000.000.

## Đã sửa ở code

- `app/vouchers/page.tsx`: `emptyForm.amount` để trống, thêm placeholder "Nhập số tiền",
  `resetFormState` không đặt lại số mẫu, và chặn lưu khi Số tiền chưa lớn hơn 0.

Phải deploy bản này lên VPS trước, nếu không dọn xong dữ liệu cũ thì phiếu mới lại sai tiếp.

## Dọn dữ liệu trên VPS

Script: `scripts/audit-deposit-amount-sync.cjs` (`npm run audit:deposit-amounts`).

Nguyên tắc chọn số đúng — chỉ đi theo chiều dẫn xuất, không đoán:

1. Lịch sử cọc gắn chứng từ → lấy theo số tiền của chính chứng từ đó.
2. Số tiền / số dư phiếu cọc → cộng lại từ lịch sử.
3. Bút toán cọc → ghi lại theo số tiền của lịch sử.

Phiếu nào cả bốn nơi đều đang là 50.000.000 thì trong dữ liệu không còn dấu vết của số
thật. Script không tự đặt số cho những phiếu đó — nó xuất danh sách kèm nhật ký thao tác
để người lập xác nhận, rồi nạp lại số đã xác nhận qua `--set-amounts`.

### Các bước

```bash
# 0. Backup toàn bộ database trước khi làm gì
pg_dump "$DATABASE_URL" -Fc -f ~/backup-truoc-don-coc-$(date +%F-%H%M).dump

# 1. Soát, chưa ghi gì cả — đọc kỹ bảng kết quả
npm run audit:deposit-amounts

# 2. Sửa phần suy ra được số đúng (tự chụp ảnh trước-khi-sửa ra file JSON)
node scripts/audit-deposit-amount-sync.cjs --apply --confirm-apply

# 3. Soát lại, phải ra "Không phát hiện sai lệch" ở 3 nhóm tự sửa được
npm run audit:deposit-amounts

# 4. Xuất danh sách phiếu còn đúng 50.000.000 cho người lập xác nhận
node scripts/audit-deposit-amount-sync.cjs --review-csv ~/coc-can-xac-nhan.csv

# 5. Sau khi điền cột so_tien_dung_dien_vao, nạp số đã xác nhận vào
node scripts/audit-deposit-amount-sync.cjs --set-amounts ~/coc-can-xac-nhan.csv --confirm-apply
```

Hoàn tác một lần chạy (dùng file JSON script in ra ở bước 2 hoặc 5):

```bash
node scripts/audit-deposit-amount-sync.cjs --rollback deposit-amount-backup-....json --confirm-apply
```

### Những nhóm script không tự sửa

| Nhóm | Xử lý |
| --- | --- |
| Bút toán chứng từ lệch với chứng từ | Mở phiếu trên màn Phiếu thu/chi, bấm lưu lại để hệ thống định khoản lại |
| Vết sửa kiểu cũ sinh bút toán thừa | `npm run repair:deposit-correction -- --code PCOC-...` |
| Chứng từ thu/chi đang đúng 50.000.000 | Sửa số tiền trên màn Phiếu thu/chi (PATCH tự revert rồi apply lại side effect và định khoản) |
| Phiếu cọc đã cấn trừ/hoàn mà mang số mẫu | Sửa trên giao diện bằng nghiệp vụ bổ sung/cấn trừ, không sửa thẳng dưới DB |
