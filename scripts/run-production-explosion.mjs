/**
 * Chạy "Rã nguyên liệu" từ dòng lệnh, thay cho việc bấm nút trên tab Chế biến.
 *
 * Script KHÔNG chép lại logic rã: nó đăng nhập rồi gọi đúng API EXPLODE_PRODUCTION mà màn
 * hình gọi, nên mọi chốt chặn (quyền, khóa kỳ, tồn kho, audit log, hoàn tác bằng nút Hoàn
 * tác lần rã) giữ nguyên. Lý do có script: bốn ô kho trên form không được lưu, mỗi lần rã
 * phải chọn lại bằng tay và rất dễ bấm nhầm kho.
 *
 * GHI THẬT vào database — phải có --confirm mới chạy, không có thì chỉ in ra cấu hình.
 *
 *   APP_EMAIL=... APP_PASSWORD=... \
 *   node scripts/run-production-explosion.mjs ASA 2026-08-01 2026-08-01 ASA_KBEP ASA_KBEP ASA_KBEP ASA_KBAR --confirm
 *   (cửa hàng, từ ngày, đến ngày, kho xuất NVL, kho nhập BTP/TP, kho ĐỒ ĂN, kho ĐỒ UỐNG)
 *
 * Dùng "-" cho hai kho bộ phận cuối để không tách Bếp/Bar.
 * APP_URL đổi được nếu app không chạy ở http://localhost:3000.
 */
const args = process.argv.slice(2);
const confirm = args.includes("--confirm");
const [branchCode, dateFrom, dateTo, warehouseCode, toWarehouseArg, kitchenArg, barArg] = args.filter((arg) => !arg.startsWith("--"));

if (!branchCode || !dateFrom || !warehouseCode) {
  console.error("Thiếu tham số: <cửa hàng> <từ ngày> <đến ngày> <kho xuất NVL> [kho nhập] [kho bếp] [kho bar] [--confirm]");
  process.exit(1);
}

const baseUrl = (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
const email = process.env.APP_EMAIL;
const password = process.env.APP_PASSWORD;
if (!email || !password) {
  console.error("Thiếu APP_EMAIL / APP_PASSWORD. Truyền qua biến môi trường, đừng đặt trên dòng lệnh (ps xem được).");
  process.exit(1);
}

const dash = (value) => (!value || value === "-" ? "" : value);
const payload = {
  action: "EXPLODE_PRODUCTION",
  branchCode,
  dateFrom,
  dateTo: dateTo || dateFrom,
  warehouseCode,
  toWarehouseCode: dash(toWarehouseArg) || warehouseCode,
  kitchenWarehouseCode: dash(kitchenArg),
  barWarehouseCode: dash(barArg),
  note: "ra tu dong lenh",
};

console.log("Sẽ rã với cấu hình:");
console.log(`  Cửa hàng          : ${payload.branchCode}`);
console.log(`  Khoảng ngày bán   : ${payload.dateFrom} → ${payload.dateTo}`);
console.log(`  Kho xuất NVL      : ${payload.warehouseCode}`);
console.log(`  Kho nhập BTP/TP   : ${payload.toWarehouseCode}`);
console.log(`  Kho ĐỒ ĂN (bếp)   : ${payload.kitchenWarehouseCode || "— không tách —"}`);
console.log(`  Kho ĐỒ UỐNG (bar) : ${payload.barWarehouseCode || "— không tách —"}`);
console.log(`  Máy chủ           : ${baseUrl}`);
if (!confirm) {
  console.log("\nChưa có --confirm nên KHÔNG ghi gì. Soát lại cấu hình rồi chạy lại kèm --confirm.");
  process.exit(0);
}

const login = await fetch(`${baseUrl}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password, rememberMe: false }),
});
if (!login.ok) {
  const body = await login.json().catch(() => ({}));
  console.error(`Đăng nhập thất bại (${login.status}): ${body.error || "không rõ nguyên nhân"}`);
  process.exit(1);
}
// Cookie phiên do /api/auth/login phát hành (httpOnly) — lấy nguyên để gửi kèm lời gọi sau.
const cookie = (login.headers.getSetCookie?.() || [])
  .map((entry) => entry.split(";")[0])
  .join("; ");
if (!cookie) {
  console.error("Đăng nhập được nhưng máy chủ không phát cookie phiên — không gọi tiếp được.");
  process.exit(1);
}

const response = await fetch(`${baseUrl}/api/inventory`, {
  method: "POST",
  headers: { "Content-Type": "application/json", cookie },
  body: JSON.stringify(payload),
});
const result = await response.json().catch(() => ({}));

if (!response.ok) {
  console.error(`\n✘ Rã thất bại (${response.status}): ${result.error || JSON.stringify(result)}`);
  console.error("Không có phiếu nào được ghi — cả lần rã chạy trong một transaction, lỗi là hoàn nguyên sạch.");
  process.exit(1);
}

console.log(`\n✔ Đã rã xong. Mã lần rã: ${result.runCode}`);
console.log(`  Phiếu kho sinh ra        : ${result.documentCount}`);
console.log(`  Dòng doanh thu đã xử lý  : ${result.revenueRows}`);
console.log(`  Dòng bỏ qua (không theo kho): ${result.skippedRows}`);
console.log(`  Bước chế biến            : ${(result.productions || []).length}`);
console.log(`  Món bán thẳng            : ${(result.directSales || []).length}`);
if (result.undecidedCount > 0) {
  console.log(`\n  ${result.undecidedCount} món không suy được bếp/bar nên đi kho mặc định — nên gán Nhóm doanh thu cho chúng:`);
  console.log(`    ${(result.undecidedProducts || []).join(", ")}${result.undecidedCount > (result.undecidedProducts || []).length ? " …" : ""}`);
}
console.log(`\nSai thì hoàn tác cả cụm bằng nút "Hoàn tác lần rã" với mã ${result.runCode}.`);
