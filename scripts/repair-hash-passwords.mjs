/**
 * BĂM MỘT LƯỢT mọi mật khẩu còn lưu chữ thường trong User.password (25/11/2026 — trước đó app lưu
 * mật khẩu dạng chữ thường). Không cần chạy cũng được: lần đăng nhập đúng đầu tiên của mỗi người
 * tự băm lại; script này để không còn mật khẩu chữ thường nào nằm trong database (kể cả tài khoản
 * ít đăng nhập / đã xoá mềm). Người dùng vẫn đăng nhập bằng mật khẩu cũ như bình thường.
 *
 * Không in mật khẩu ra màn hình — chỉ in số lượng và email.
 *
 * Chạy thử (không ghi):  npm run repair:hash-passwords
 * Ghi thật:             npm run repair:hash-passwords -- --apply
 */
import { prisma } from "../lib/prisma.ts";
import { hashPassword, isHashedPassword } from "../lib/password-hash.ts";

const apply = process.argv.includes("--apply");
// deletedAt: undefined -> lấy cả tài khoản đã xoá mềm (lib/prisma chỉ tự lọc khi lời gọi không nêu deletedAt).
const users = await prisma.user.findMany({ where: { deletedAt: undefined }, select: { id: true, email: true, password: true } });
const plain = users.filter((user) => !isHashedPassword(user.password));
console.log(`Tổng ${users.length} tài khoản, ${plain.length} tài khoản còn mật khẩu chữ thường.`);
for (const user of plain) console.log(`  - ${user.email}`);

if (!apply) {
  console.log("\nChạy thử — chưa ghi gì. Thêm --apply để băm.");
} else {
  for (const user of plain) {
    await prisma.user.update({ where: { id: user.id }, data: { password: await hashPassword(user.password.trim()) } });
  }
  console.log(`\nĐã băm ${plain.length} mật khẩu.`);
}
await prisma.$disconnect();
