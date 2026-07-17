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

## Demo Accounts

Mat khau chung: `123456`

- `admin@fin-erp.vn`
- `ktth@fin-erp.vn`
- `congno@fin-erp.vn`
- `quanly@fin-erp.vn`
- `viewer@fin-erp.vn`
