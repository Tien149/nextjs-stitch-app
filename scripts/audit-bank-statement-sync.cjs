/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Soát các dòng sổ sao kê ngân hàng đang lệch với chứng từ đã đối soát với nó — số tiền,
 * khoản mục thu/chi và hạng mục P&L.
 *
 * Sinh ra để dọn dữ liệu cũ từ trước khi đường sửa phiếu biết đồng bộ ngược lại sao kê
 * (lib/reconciliation-links.ts > syncReconciledBankStatement): sửa trên màn Chứng từ ngân
 * hàng chỉ đổi FinancialVoucher, còn BankStatementTransaction giữ nguyên dữ liệu import.
 * Hệ quả: Sổ quỹ đọc theo phiếu ra số mới, còn màn Sổ sao kê ngân hàng và các báo cáo đọc
 * theo sao kê (vế chuyển khoản/ví của bảng thu chi theo danh mục, doanh thu chuyển khoản
 * trong ngày — xem lib/reports.ts và app/api/reports/route.ts) vẫn ra số cũ, khoản mục cũ.
 *
 * Chiều sửa: lấy CHỨNG TỪ làm chuẩn, kéo dòng sao kê theo — đúng chiều mà người dùng đã
 * thao tác. Nếu thực tế số của ngân hàng mới là số đúng thì đừng chạy --apply: vào màn
 * Chứng từ ngân hàng sửa phiếu về đúng số của sao kê, phiếu sẽ tự đồng bộ hai nơi.
 *
 * Chỉ đẩy xuống giá trị mà chứng từ thật sự mang: phiếu bỏ trống khoản mục, hoặc phiếu thu
 * (vốn không được khai P&L), thì giữ nguyên giá trị đã có trên sao kê.
 *
 * Không tự sửa và chỉ liệt kê:
 *   - số tiền của giao dịch có nhiều dòng phân bổ (không chia lại được mà không đoán mò);
 *   - khoản mục / P&L khi các dòng phân bổ đang khác nhau (đẩy xuống là xoá phân loại thật);
 *   - phiếu ngược chiều Nợ/Có với sao kê.
 * Những dòng này phải sửa file sao kê rồi import lại giao dịch.
 *
 * Dùng:
 *   node scripts/audit-bank-statement-sync.cjs                        # chỉ soát, không ghi
 *   node scripts/audit-bank-statement-sync.cjs --json
 *   node scripts/audit-bank-statement-sync.cjs --apply --confirm-apply
 *   node scripts/audit-bank-statement-sync.cjs --rollback backup-....json --confirm-apply
 */
const fs = require("node:fs");
const path = require("node:path");
const { PrismaClient } = require("@prisma/custom-client");

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const valueOf = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] || "") : "";
};
const apply = args.includes("--apply");
const confirmed = args.includes("--confirm-apply");
const asJson = args.includes("--json");
const rollbackPath = valueOf("--rollback");
const backupDir = valueOf("--backup-dir") || process.cwd();

const EPS = 0.5;
const money = (value) => `${Math.round(value).toLocaleString("vi-VN")} đ`;
const cleanCode = (value) => String(value || "").trim();
const distinctCodes = (allocations, field) => [...new Set(allocations.map((row) => cleanCode(row[field])).filter(Boolean))];

async function collectDivergences() {
  const matches = await prisma.reconciliationMatch.findMany({
    where: { targetType: "VOUCHER", status: { in: ["PENDING_REVIEW", "MATCHED"] }, deletedAt: null },
    include: { bankTransaction: { include: { allocations: { orderBy: { sourceRowNumber: "asc" } } } } },
  });
  const vouchers = await prisma.financialVoucher.findMany({
    where: { id: { in: matches.map((row) => row.targetId) } },
    select: { id: true, code: true, voucherType: true, amount: true, categoryCode: true, pnlItemCode: true, status: true, deletedAt: true },
  });
  const voucherById = new Map(vouchers.map((row) => [row.id, row]));

  const rows = [];
  for (const match of matches) {
    const bank = match.bankTransaction;
    const voucher = voucherById.get(match.targetId);
    if (!bank || bank.deletedAt || !voucher || voucher.deletedAt) continue;

    const isReceipt = voucher.voucherType === "RECEIPT";
    const bankAmount = bank.creditAmount || bank.debitAmount;
    const voucherAmount = Math.round(voucher.amount);
    const categoryCode = cleanCode(voucher.categoryCode);
    // Phiếu thu không được khai P&L nên ô trống của nó không phải là dữ liệu để đẩy xuống.
    const pnlItemCode = isReceipt ? "" : cleanCode(voucher.pnlItemCode);

    const diffs = [];
    const blockers = [];
    const appliedFields = [];
    const bankData = {};
    const allocationData = {};

    if (Math.abs(bankAmount - voucherAmount) >= EPS) {
      diffs.push({ field: "amount", label: "số tiền", from: money(bankAmount), to: money(voucherAmount) });
      if (bank.allocations.length > 1) {
        blockers.push(`${bank.allocations.length} dòng phân bổ — không chia lại số tiền được`);
      } else if ((isReceipt && bank.debitAmount > 0) || (!isReceipt && bank.creditAmount > 0)) {
        blockers.push("Phiếu ngược chiều với sao kê — kiểm tra lại loại thu/chi");
      } else {
        Object.assign(bankData, isReceipt
          ? { creditAmount: voucherAmount, debitAmount: 0 }
          : { creditAmount: 0, debitAmount: voucherAmount });
        Object.assign(allocationData, bankData);
        appliedFields.push("amount");
      }
    }

    for (const [field, value, label] of [["categoryCode", categoryCode, "khoản mục"], ["pnlItemCode", pnlItemCode, "hạng mục P&L"]]) {
      if (!value || value === cleanCode(bank[field])) continue;
      diffs.push({ field, label, from: cleanCode(bank[field]) || "—", to: value });
      if (distinctCodes(bank.allocations, field).length > 1) {
        blockers.push(`các dòng phân bổ khác ${label} nhau — đẩy xuống sẽ xoá phân loại từng dòng`);
      } else {
        bankData[field] = value;
        allocationData[field] = value;
        appliedFields.push(field);
      }
    }

    if (diffs.length === 0) continue;

    rows.push({
      matchId: match.id,
      bankTransactionId: bank.id,
      transactionCode: bank.transactionCode,
      bankAccount: bank.bankAccount,
      branchCode: bank.branchCode,
      transactionDate: bank.transactionDate,
      voucherCode: voucher.code,
      voucherType: voucher.voucherType,
      voucherStatus: voucher.status,
      voucherAmount,
      diffs,
      blockers,
      appliedFields,
      bankData,
      allocationData,
      allocationIds: bank.allocations.map((row) => row.id),
      before: {
        bank: {
          debitAmount: bank.debitAmount, creditAmount: bank.creditAmount,
          categoryCode: bank.categoryCode, pnlItemCode: bank.pnlItemCode,
          autoProcessNote: bank.autoProcessNote,
        },
        allocations: bank.allocations.map((row) => ({
          id: row.id, debitAmount: row.debitAmount, creditAmount: row.creditAmount,
          categoryCode: row.categoryCode, pnlItemCode: row.pnlItemCode,
        })),
        match: { targetAmount: match.targetAmount, matchedAmount: match.matchedAmount },
      },
    });
  }
  return rows.sort((a, b) => new Date(a.transactionDate) - new Date(b.transactionDate));
}

async function applyFixes(rows) {
  if (!confirmed) throw new Error("--apply bắt buộc kèm --confirm-apply.");
  const fixable = rows.filter((row) => row.appliedFields.length > 0);
  if (fixable.length === 0) {
    console.log("Không có dòng nào tự sửa được.");
    return;
  }
  const backupFile = path.join(backupDir, `backup-bank-statement-sync-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(backupFile, JSON.stringify({ createdAt: new Date().toISOString(), rows: fixable }, null, 2));
  console.log(`Đã chụp ảnh trước khi sửa: ${backupFile}`);

  for (const row of fixable) {
    const applied = row.diffs.filter((diff) => row.appliedFields.includes(diff.field));
    const note = applied.map((diff) => `${diff.label} ${diff.from} → ${diff.to}`).join("; ");
    await prisma.$transaction(async (tx) => {
      await tx.bankStatementTransaction.update({
        where: { id: row.bankTransactionId },
        data: { ...row.bankData, autoProcessNote: `Đồng bộ theo chứng từ ${row.voucherCode}: ${note} (audit)` },
      });
      if (row.allocationIds.length > 0) {
        await tx.bankStatementAllocation.updateMany({ where: { bankTransactionId: row.bankTransactionId }, data: row.allocationData });
      }
      await tx.reconciliationMatch.update({
        where: { id: row.matchId },
        data: { targetAmount: row.voucherAmount, matchedAmount: row.voucherAmount },
      });
    });
    console.log(`✔ ${row.transactionCode} ← ${row.voucherCode}: ${note}`);
  }
  console.log(`Đã đồng bộ ${fixable.length} giao dịch sao kê.`);
}

async function rollback() {
  if (!confirmed) throw new Error("--rollback bắt buộc kèm --confirm-apply.");
  const snapshot = JSON.parse(fs.readFileSync(rollbackPath, "utf8"));
  for (const row of snapshot.rows || []) {
    await prisma.bankStatementTransaction.update({ where: { id: row.bankTransactionId }, data: row.before.bank });
    for (const allocation of row.before.allocations || []) {
      const { id, ...data } = allocation;
      await prisma.bankStatementAllocation.update({ where: { id }, data });
    }
    await prisma.reconciliationMatch.update({ where: { id: row.matchId }, data: row.before.match });
  }
  console.log(`Đã hoàn tác về ảnh chụp ${snapshot.createdAt}: ${(snapshot.rows || []).length} giao dịch.`);
}

async function main() {
  if (rollbackPath) return rollback();

  const rows = await collectDivergences();
  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
  } else if (rows.length === 0) {
    console.log("Không có dòng sao kê nào lệch với chứng từ đã đối soát.");
  } else {
    console.log(`Có ${rows.length} giao dịch sao kê lệch với chứng từ:\n`);
    for (const row of rows) {
      const date = new Date(row.transactionDate).toLocaleDateString("vi-VN", { timeZone: "UTC" });
      console.log(`${date} · ${row.branchCode || "—"} · ${row.transactionCode} ↔ ${row.voucherCode}`);
      for (const diff of row.diffs) console.log(`   ${diff.label}: ${diff.from} → ${diff.to}`);
      for (const blocker of row.blockers) console.log(`   ⚠ không tự sửa: ${blocker}`);
    }
    const fixable = rows.filter((row) => row.appliedFields.length > 0).length;
    console.log(`\nTự sửa được ${fixable}/${rows.length}. Chạy lại với --apply --confirm-apply để đồng bộ sao kê theo chứng từ.`);
  }

  if (apply) await applyFixes(rows);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
