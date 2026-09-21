/**
 * Tròn tới đồng, đối xứng quanh 0: -1,5 ra -2 chứ không phải -1 như `Math.round`.
 * Tiền âm (giảm trừ, hoàn tiền) phải tròn cùng độ lớn với tiền dương, nếu không hai vế của
 * một cặp bút toán lệch nhau 1 đồng.
 *
 * Để RIÊNG một file không đụng gì tới Prisma: `lib/money-rounding.ts` phải đọc
 * `Prisma.dmmf.datamodel` ngay lúc nạp module, nên mọi màn hình client lỡ import hàm này từ
 * đó sẽ kéo cả Prisma client vào bundle trình duyệt và trắng trang với "Cannot read
 * properties of undefined (reading 'datamodel')". Component chạy ở trình duyệt import từ đây.
 */
export function roundVnd(value: number) {
  if (!Number.isFinite(value)) return value;
  return Math.sign(value) * Math.round(Math.abs(value));
}
