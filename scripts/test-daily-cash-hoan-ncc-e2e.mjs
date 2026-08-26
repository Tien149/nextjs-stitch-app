/**
 * E2E case "chi trùng NCC" của chị Bình, chạy qua HTTP thật trên app đang chạy:
 * lập phiếu chi cho NCC ngày T, ngày T+1 NCC hoàn tiền mặt -> lập phiếu thu loại THU_HOAN_NCC,
 * rồi đọc báo cáo Thu chi ngày và kiểm khoản hoàn nằm ở dòng "Thu khác", không lẫn vào doanh thu,
 * nhưng vẫn cộng đủ vào tiền mặt cần nộp của quỹ thu ngân.
 *
 * Danh mục (quỹ thu ngân, NCC, khoản mục) được dò qua chính API của app, nên bài test chạy được
 * trên mọi bản dữ liệu mà không phụ thuộc mã cứng. Dữ liệu dựng trên ngày cố ý để trống
 * (15-17/09/2026) và dọn sạch sau khi chạy, nên an toàn cả trên bản sao PROD.
 *
 * Cần app đang chạy: npm run dev (mặc định http://localhost:3000).
 * Chạy: npm run test:hoan-ncc-e2e
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { buildDailyCashSummaryRows } from "../lib/daily-cash-receipts.ts";
import { isPartnerAllowedForVoucher } from "../lib/voucher-rules.ts";
import { filterCashierCashSources } from "../lib/money-sources.ts";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/custom-client");
const prisma = new PrismaClient();

const BASE_URL = process.env.E2E_BASE_URL || "http://localhost:3000";
const BRANCH = "NME";
const PERIOD = "2026-09";
/** Ngày chi trùng, ngày phát hiện, và một ngày riêng để kiểm khử trùng với POS. */
const PAY_DAY = "2026-09-15";
const FOUND_DAY = "2026-09-16";
const POS_DAY = "2026-09-17";
const AFTER_LAST_DAY = "2026-09-18";
const HOAN_CATEGORY = "THU_HOAN_NCC";
const POS_BATCH = "TEST_HOAN_NCC_POS";
const MARK = "[E2E-HOAN-NCC]";

const DOUBLE_PAID = 3_000_000;
const SALES_RECEIPT = 5_000_000;
const POS_CASH_REVENUE = 4_000_000;

const session = {
  id: "e2e-hoan-ncc",
  name: "E2E Hoan NCC",
  role: "Admin",
  branch: "ALL",
  email: "e2e@fin-erp.local",
  allowedBranches: ["ALL"],
  menuAccess: [],
  actions: [],
  loginAt: "2026-09-15T00:00:00.000Z",
};
const authHeaders = {
  "Content-Type": "application/json",
  "x-demo-session": encodeURIComponent(JSON.stringify(session)),
};

const createdVoucherIds = [];

async function apiGet(path) {
  const response = await fetch(`${BASE_URL}${path}`, { headers: authHeaders });
  const payload = await response.json();
  assert.equal(response.status, 200, `GET ${path} lỗi: ${JSON.stringify(payload)}`);
  return payload;
}

async function createVoucher(body) {
  const response = await fetch(`${BASE_URL}/api/vouchers`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(response.status, 201, `tạo phiếu thất bại: ${JSON.stringify(payload)}`);
  createdVoucherIds.push(payload.id);
  return payload;
}

const dailyCashReport = (reportDate, branchCode = BRANCH) => apiGet(
  `/api/reports?${new URLSearchParams({ type: "daily-cash", period: PERIOD, branchCode, reportDate, shift: "FULL" })}`,
);

const cashToDepositOf = (report, code) =>
  Math.round(report.cashToDepositSources.find((row) => row.code === code)?.amount || 0);
const rowByLabel = (rows, label) => rows.find((row) => row.label === label);

test("E2E: NCC hoàn tiền chi trùng vào ngày phát hiện", async (t) => {
  /** Quỹ tiền mặt của thu ngân, NCC và khoản mục — lấy từ chính danh mục app đang dùng. */
  let cashierSource;
  let supplier;
  let paymentCategory;
  let createdCategory = false;

  t.after(async () => {
    if (createdVoucherIds.length > 0) {
      await prisma.auditLog.deleteMany({ where: { entityId: { in: createdVoucherIds } } });
      await prisma.financialVoucher.deleteMany({ where: { id: { in: createdVoucherIds } } });
    }
    await prisma.revenueImportRow.deleteMany({ where: { importBatchId: POS_BATCH } });
    await prisma.importBatch.deleteMany({ where: { id: POS_BATCH } });
    // Chỉ xoá khoản mục nếu chính bài test tạo ra; DB đã có sẵn thì giữ nguyên.
    if (createdCategory) {
      await prisma.masterDataItem.deleteMany({ where: { type: "REVENUE_EXPENSE_CATEGORY", code: HOAN_CATEGORY } });
    }
    await prisma.$disconnect();
  });

  await t.test("chuẩn bị: dò danh mục từ app, ngày test còn trống", async () => {
    const existing = await prisma.financialVoucher.count({
      where: {
        deletedAt: null,
        voucherDate: { gte: new Date(`${PAY_DAY}T00:00:00`), lt: new Date(`${AFTER_LAST_DAY}T00:00:00`) },
      },
    });
    assert.equal(existing, 0, "ngày test phải trống trước khi dựng dữ liệu");

    const sources = await apiGet(`/api/master-data?type=MONEY_SOURCE&branchCode=${BRANCH}`);
    cashierSource = filterCashierCashSources(sources, BRANCH)[0];
    assert.ok(cashierSource, `cửa hàng ${BRANCH} phải có quỹ tiền mặt thu ngân đang hoạt động`);

    const partners = await apiGet("/api/master-data?type=PARTNER&status=ACTIVE");
    supplier = partners.find((row) => (row.partnerType || row.group || "").toUpperCase() === "SUPPLIER");
    assert.ok(supplier, "cần ít nhất một NCC đang hoạt động");
    // Điểm mấu chốt: NCC giữ nguyên loại SUPPLIER, không đổi sang BOTH như cách làm tạm.
    assert.equal((supplier.partnerType || supplier.group).toUpperCase(), "SUPPLIER");

    const categories = await apiGet("/api/master-data?type=REVENUE_EXPENSE_CATEGORY&status=ACTIVE");
    assert.ok(categories.some((row) => row.code === "THU_BAN_HANG"), "danh mục phải có THU_BAN_HANG");
    paymentCategory = categories.find((row) => row.code === "CHI_NCC_THANG_NAY")
      || categories.find((row) => (row.group || "").toUpperCase() === "PAYMENT");
    assert.ok(paymentCategory, "cần một khoản mục chi để lập phiếu chi NCC");

    // Khoản mục thu riêng cho khoản hoàn — bước chị Bình làm một lần trên màn Danh mục.
    if (!categories.some((row) => row.code === HOAN_CATEGORY)) {
      const response = await fetch(`${BASE_URL}/api/master-data`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          type: "REVENUE_EXPENSE_CATEGORY",
          code: HOAN_CATEGORY,
          name: "Hoàn Tiền Chi Trùng Từ NCC",
          group: "RECEIPT",
        }),
      });
      const payload = await response.json();
      assert.ok(response.ok, `tạo khoản mục thất bại: ${JSON.stringify(payload)}`);
      createdCategory = true;
    }
  });

  await t.test("form phiếu thu tiền mặt cho chọn NCC khi loại thu không phải bán hàng", () => {
    const asSupplier = { voucherType: "RECEIPT", partnerType: "SUPPLIER", isBankChannel: false };
    // Lỗi chị Bình gặp: loại thu bán hàng thì NCC bị chặn (đúng), nhưng khoản hoàn cũng bị chặn theo.
    assert.equal(isPartnerAllowedForVoucher({ ...asSupplier, categoryCode: HOAN_CATEGORY }), true);
    assert.equal(isPartnerAllowedForVoucher({ ...asSupplier, categoryCode: "THU_BAN_HANG" }), false);
    // Thu bán hàng vẫn phải chọn được khách hàng như cũ.
    assert.equal(isPartnerAllowedForVoucher({ voucherType: "RECEIPT", partnerType: "CUSTOMER", categoryCode: "THU_BAN_HANG" }), true);
    // Nhân viên hoàn tạm ứng cũng chọn được trên phiếu thu tiền mặt.
    assert.equal(isPartnerAllowedForVoucher({ voucherType: "RECEIPT", partnerType: "EMPLOYEE", categoryCode: HOAN_CATEGORY }), true);
    // Phiếu chi và kênh ngân hàng giữ nguyên hành vi cũ.
    assert.equal(isPartnerAllowedForVoucher({ voucherType: "PAYMENT", partnerType: "SUPPLIER" }), true);
    assert.equal(isPartnerAllowedForVoucher({ ...asSupplier, categoryCode: "THU_BAN_HANG", isBankChannel: true }), true);
  });

  await t.test("ngày 15/09: thu ngân chi tiền cho NCC (khoản sau này phát hiện bị trùng)", async () => {
    const voucher = await createVoucher({
      voucherType: "PAYMENT",
      documentChannel: "CASH",
      voucherDate: `${PAY_DAY}T10:00:00`,
      branchCode: BRANCH,
      moneySourceCode: cashierSource.code,
      categoryCode: paymentCategory.code,
      partnerCode: supplier.code,
      partnerName: supplier.name,
      amount: DOUBLE_PAID,
      description: `${MARK} Chi tiền NCC (bản trùng)`,
    });
    assert.equal(voucher.status, "APPROVED");

    const report = await dailyCashReport(PAY_DAY);
    assert.equal(Math.round(report.summary.cashExpenseTotal), DOUBLE_PAID, "phiếu chi phải nằm ở tiền ra ngày 15/09");
    assert.equal(cashToDepositOf(report, cashierSource.code), -DOUBLE_PAID, "quỹ thu ngân giảm đúng số đã chi");
  });

  await t.test("ngày 16/09: lập phiếu thu hoàn tiền cho chính NCC đó — API nhận đối tác NCC", async () => {
    const voucher = await createVoucher({
      voucherType: "RECEIPT",
      documentChannel: "CASH",
      voucherDate: `${FOUND_DAY}T09:00:00`,
      branchCode: BRANCH,
      moneySourceCode: cashierSource.code,
      categoryCode: HOAN_CATEGORY,
      partnerCode: supplier.code,
      partnerName: supplier.name,
      amount: DOUBLE_PAID,
      description: `${MARK} Hoàn tiền chi trùng của phiếu chi ngày ${PAY_DAY}`,
    });
    assert.equal(voucher.partnerCode, supplier.code, "phiếu thu phải giữ đúng mã NCC");
    assert.equal(voucher.categoryCode, HOAN_CATEGORY);
    assert.equal(voucher.depositAction, null, "khoản hoàn không được hiểu nhầm thành thu cọc");
  });

  await t.test("ngày 16/09: khoản hoàn nằm ở Thu khác, không lẫn vào doanh thu bán hàng", async () => {
    // Thêm một phiếu thu bán hàng cùng ngày để chắc chắn hai loại không lẫn vào nhau.
    await createVoucher({
      voucherType: "RECEIPT",
      documentChannel: "CASH",
      voucherDate: `${FOUND_DAY}T20:00:00`,
      branchCode: BRANCH,
      moneySourceCode: cashierSource.code,
      categoryCode: "THU_BAN_HANG",
      partnerName: "Khách hàng mua lẻ",
      amount: SALES_RECEIPT,
      description: `${MARK} Thu bán hàng tiền mặt`,
    });

    const report = await dailyCashReport(FOUND_DAY);
    const summary = report.summary;
    assert.ok(summary.receiptSalesRevenue, "API phải trả trường tách mới (app đang chạy code mới)");

    assert.equal(Math.round(summary.receipt.total), SALES_RECEIPT + DOUBLE_PAID, "bảng chi tiết vẫn gồm đủ hai phiếu");
    assert.equal(Math.round(summary.receiptSalesRevenue.total), SALES_RECEIPT, "phần doanh thu chỉ có phiếu bán hàng");
    assert.equal(Math.round(summary.receiptOther.total), DOUBLE_PAID, "khoản hoàn NCC nằm ở Thu khác");
    assert.equal(Math.round(summary.receiptOther.cash), DOUBLE_PAID);

    // Đúng các dòng mà màn Thu chi ngày sẽ vẽ ra.
    const rows = buildDailyCashSummaryRows(summary);
    const salesRow = rowByLabel(rows, "Doanh thu bán hàng");
    const otherRow = rowByLabel(rows, "Thu khác (ngoài bán hàng)");
    assert.ok(otherRow, "phải có dòng Thu khác");
    assert.equal(Math.round(salesRow.bucket.total), SALES_RECEIPT, "dòng doanh thu KHÔNG được cộng khoản hoàn");
    assert.equal(Math.round(otherRow.bucket.total), DOUBLE_PAID);

    // Tiền có thật trong két nên vẫn phải nộp đủ cả hai khoản.
    assert.equal(Math.round(summary.cashToDeposit), SALES_RECEIPT + DOUBLE_PAID, "tiền mặt cần nộp gồm cả khoản hoàn");
    assert.equal(cashToDepositOf(report, cashierSource.code), SALES_RECEIPT + DOUBLE_PAID, "cộng đúng vào quỹ thu ngân");
    assert.equal(
      Math.round(salesRow.cashToDeposit + otherRow.cashToDeposit),
      Math.round(summary.cashToDeposit),
      "số nộp từng dòng cộng lại phải bằng tổng",
    );
    assert.equal(Math.round(summary.total.total), SALES_RECEIPT + DOUBLE_PAID, "tổng thu trong ngày không đổi");

    // Phiếu hoàn vẫn phải hiện ở bảng chứng từ chi tiết, kèm đúng tên NCC.
    const detail = report.receipts.find((row) => row.description.includes("Hoàn tiền chi trùng"));
    assert.ok(detail, "phiếu hoàn phải có trong bảng Các khoản thu chi tiết");
    assert.equal(detail.partnerName, supplier.name);
    assert.equal(detail.isCash, true);
  });

  await t.test("ngày 17/09: có POS tiền mặt thì chỉ khử phiếu thu bán hàng, khoản hoàn giữ nguyên", async () => {
    await prisma.importBatch.create({
      data: { id: POS_BATCH, importType: "REVENUE_POS", templateCode: "TEST", fileName: "e2e", uploadedBy: "e2e", status: "COMMITTED" },
    });
    await prisma.revenueImportRow.create({
      data: {
        importBatchId: POS_BATCH,
        saleDate: new Date(`${POS_DAY}T00:00:00`),
        branchCode: BRANCH,
        // Tên phương thức thanh toán trên file POS chính là tên quỹ tiền mặt của thu ngân.
        revenueSource: cashierSource.name,
        paymentMethod: cashierSource.name,
        channel: "TAI CHO",
        grossAmount: POS_CASH_REVENUE,
        netAmount: POS_CASH_REVENUE,
        externalRef: "E2E-HOAN-NCC-POS-1",
      },
    });
    // Phiếu thu bán hàng chính là chứng từ của doanh thu POS trên -> phải bị khử, không đếm đôi.
    await createVoucher({
      voucherType: "RECEIPT",
      documentChannel: "CASH",
      voucherDate: `${POS_DAY}T20:00:00`,
      branchCode: BRANCH,
      moneySourceCode: cashierSource.code,
      categoryCode: "THU_BAN_HANG",
      partnerName: "Khách hàng mua lẻ",
      amount: POS_CASH_REVENUE,
      description: `${MARK} Thu bán hàng tiền mặt khớp POS`,
    });
    await createVoucher({
      voucherType: "RECEIPT",
      documentChannel: "CASH",
      voucherDate: `${POS_DAY}T21:00:00`,
      branchCode: BRANCH,
      moneySourceCode: cashierSource.code,
      categoryCode: HOAN_CATEGORY,
      partnerCode: supplier.code,
      partnerName: supplier.name,
      amount: DOUBLE_PAID,
      description: `${MARK} Hoàn tiền NCC ngày có POS`,
    });

    const report = await dailyCashReport(POS_DAY);
    const summary = report.summary;
    assert.equal(Math.round(summary.revenue.cash), POS_CASH_REVENUE, "doanh thu POS tiền mặt vào đúng cột tiền mặt");
    assert.equal(Math.round(summary.receiptSalesRevenue.total), 0, "phiếu thu bán hàng bị khử trùng với POS");
    assert.equal(Math.round(summary.receiptOther.total), DOUBLE_PAID, "khoản hoàn không bị khử theo");

    const rows = buildDailyCashSummaryRows(summary);
    assert.equal(Math.round(rowByLabel(rows, "Doanh thu bán hàng").bucket.total), POS_CASH_REVENUE, "doanh thu không đếm đôi");
    assert.equal(Math.round(rowByLabel(rows, "Thu khác (ngoài bán hàng)").bucket.total), DOUBLE_PAID);

    // Két giữ tiền bán hàng (POS) + tiền NCC hoàn, không gấp đôi phần bán hàng.
    assert.equal(Math.round(summary.cashToDeposit), POS_CASH_REVENUE + DOUBLE_PAID, "tiền mặt cần nộp không bị gấp đôi");
    assert.equal(cashToDepositOf(report, cashierSource.code), POS_CASH_REVENUE + DOUBLE_PAID);
  });

  await t.test("xem Tất cả cửa hàng vẫn cộng đúng, không khử nhầm chéo cửa hàng", async () => {
    const report = await dailyCashReport(POS_DAY, "ALL");
    assert.equal(Math.round(report.summary.receiptOther.total), DOUBLE_PAID);
    assert.equal(Math.round(report.summary.receiptSalesRevenue.total), 0);
    assert.equal(Math.round(report.summary.cashToDeposit), POS_CASH_REVENUE + DOUBLE_PAID);
  });

  await t.test("ngày không có khoản thu ngoài bán hàng thì không hiện dòng Thu khác", async () => {
    const report = await dailyCashReport(PAY_DAY);
    const rows = buildDailyCashSummaryRows(report.summary);
    assert.equal(rowByLabel(rows, "Thu khác (ngoài bán hàng)"), undefined);
    assert.deepEqual(rows.map((row) => row.label), ["Doanh thu bán hàng", "Đặt cọc"]);
  });
});
