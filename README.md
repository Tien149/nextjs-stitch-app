# FIN ERP App

NextJS app cho he thong FIN ERP/ke toan noi bo cua doanh nghiep F&B.

## Project Context

Doc trung tam:

- `../documents/reference/PROJECT_CONTEXT.md`

Boi canh domain:

- Doanh nghiep co mot hoac nhieu chi nhanh.
- Doanh thu den tu POS/iPOS, dine-in, takeaway va delivery.
- Thanh toan gom tien mat, ngan hang, POS/card, vi dien tu.
- Can theo doi danh muc, tien coc, so du dau ky, import sao ke, import doanh thu, cong no va phieu thu/chi.

## Current Scope

Giai doan 1:

- Login demo va phan quyen.
- Danh muc nen.
- Tien coc.
- So du dau ky.
- API permission hardening.

Giai doan 2 dang lam:

- Import sao ke ngan hang.
- Import doanh thu POS.
- Mapping Excel flexible qua `lib/import-templates.ts`.
- File mau trong `public/templates`.

## Run Local

```bash
npm.cmd run dev
```

## Build / Check

```bash
npm.cmd run lint
npm.cmd run build
```

## Prisma

```bash
npx.cmd prisma generate
npx.cmd prisma db push
```

Luu y: khi deploy VPS, stop app truoc khi generate/migrate neu Prisma engine bi lock.

## Xoá mềm (soft delete)

Hệ thống **không xoá vĩnh viễn** dữ liệu người dùng nhập. Mọi model gốc có cột
`deletedAt` / `deletedBy`; bản ghi bị xoá chỉ được đánh dấu và chuyển vào Thùng rác
(`/trash`), có thể khôi phục lại.

Quy ước khi viết code mới:

- Dùng `prisma` từ `@/lib/prisma` cho mọi nghiệp vụ. Client này tự động:
  - chuyển `delete`/`deleteMany` thành đánh dấu `deletedAt`,
  - loại bản ghi đã xoá khỏi `findMany` / `findFirst` / `count` / `aggregate` / `groupBy`,
  - lọc kết quả `findUnique`.
- Trong route API, xoá bằng `softDeleteRecord()` (`@/lib/soft-delete`) thay vì gọi
  `prisma.x.delete()` trực tiếp — helper này ghi thêm người xoá, lý do, nhật ký hệ
  thống và xoá mềm các bản ghi con theo khai báo `cascade`.
- Muốn thêm một loại dữ liệu vào Thùng rác: thêm `deletedAt`/`deletedBy` vào model
  trong `prisma/schema.prisma`, rồi khai báo một mục trong `TRASH_ENTITIES`
  (`lib/soft-delete.ts`). Không cần sửa `lib/prisma.ts`.
- **Quan hệ lồng nhau không được lọc tự động.** Khi dùng `include`/`select` tới một
  model có xoá mềm, phải tự thêm `where: { deletedAt: null }`.
- Cần nhìn thấy hoặc xoá cứng thật sự (rollback import, script dọn dữ liệu): dùng
  `prismaRaw` / `prismaRaw.$transaction`. Rollback phải xoá cứng để giải phóng các
  mã unique, nếu không import lại cùng file sẽ báo trùng mã.

## Tài khoản

Tài khoản được quản lý trong màn hình **Phân quyền & Người dùng**. Hệ thống không có
cơ chế đăng nhập dự phòng: chỉ tài khoản đang hoạt động trong database mới đăng nhập
được, tài khoản bị xoá mất quyền truy cập ngay.

Tài khoản khởi tạo bởi `npx prisma db seed` (đổi mật khẩu ngay sau khi cài đặt):

- `admin@fin-erp.vn`
- `ktth@fin-erp.vn`
- `congno@fin-erp.vn`
- `quanly@fin-erp.vn`
- `viewer@fin-erp.vn`
