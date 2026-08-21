/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Soát và đồng bộ số tiền cọc giữa 4 nơi đang lưu cùng một con số:
 *   phiếu cọc (Deposit) — lịch sử cọc (DepositHistory) — chứng từ thu/chi (FinancialVoucher)
 *   — bút toán sổ cái (JournalEntry/JournalLine).
 *
 * Sinh ra để dọn dữ liệu cũ từ thời form còn đặt sẵn số tiền mẫu 50.000.000: người lập
 * quên sửa nên phiếu lưu số mẫu; sửa lại sau đó thì chỉ một vài nơi được cập nhật, còn
 * các màn hình khác vẫn đọc con số cũ.
 *
 * Nguyên tắc chọn số đúng (chỉ đi theo chiều dẫn xuất, không bao giờ đoán):
 *   1. Lịch sử gắn chứng từ  -> lấy theo số tiền của chính chứng từ đó.
 *   2. Số tiền / số dư phiếu -> cộng lại từ lịch sử.
 *   3. Bút toán cọc          -> ghi lại theo số tiền của lịch sử.
 * Phiếu nào cả bốn nơi đều đang là 50.000.000 thì trong dữ liệu KHÔNG còn dấu vết của số
 * thật; script chỉ liệt kê kèm nhật ký thao tác để người lập xác nhận, rồi nhận số đã xác
 * nhận qua --set-amounts. Tự đặt một con số cho những phiếu đó là bịa số liệu kế toán.
 *
 * Dùng:
 *   node scripts/audit-deposit-amount-sync.cjs                        # chỉ soát, không ghi
 *   node scripts/audit-deposit-amount-sync.cjs --apply --confirm-apply # sửa phần suy ra được
 *   node scripts/audit-deposit-amount-sync.cjs --review-csv review.csv # xuất danh sách cần xác nhận
 *   node scripts/audit-deposit-amount-sync.cjs --set-amounts review.csv --confirm-apply
 *   node scripts/audit-deposit-amount-sync.cjs --rollback backup-....json --confirm-apply
 *
 * Mọi lần ghi đều chụp ảnh trước-khi-sửa ra file JSON để hoàn tác được bằng --rollback.
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
const reviewCsvPath = valueOf("--review-csv");
const setAmountsPath = valueOf("--set-amounts");
const rollbackPath = valueOf("--rollback");
const backupDir = valueOf("--backup-dir") || process.cwd();

const SAMPLE_AMOUNT = 50000000;
const EPS = 0.5;

/** Lịch sử làm tăng số cọc đang giữ. OPENING là số dư cọc mang sang đầu kỳ. */
const INCREASE = ["CREATE", "COLLECT", "SUPPLEMENT", "OPENING"];
/** Lịch sử làm giảm số cọc đang giữ. */
const DECREASE = ["OFFSET", "REFUND", "TRANSFER_REVENUE", "CANCEL"];

const money = (value) => Number(value || 0).toLocaleString("vi-VN");
const findings = [];
const record = (finding) => { findings.push(finding); return finding; };

/** Ảnh chụp trước-khi-sửa của từng dòng sắp bị ghi đè, đủ để --rollback dựng lại. */
const backup = { createdAt: new Date().toISOString(), deposits: [], histories: [], journalLines: [] };
async function snapshotDeposit(id) {
  if (backup.deposits.some((row) => row.id === id)) return;
  const row = await prisma.deposit.findUnique({ where: { id }, select: { id: true, code: true, amount: true, remainingAmount: true, status: true } });
  if (row) backup.deposits.push(row);
}
async function snapshotHistory(id) {
  if (backup.histories.some((row) => row.id === id)) return;
  const row = await prisma.depositHistory.findUnique({ where: { id }, select: { id: true, depositId: true, action: true, amount: true } });
  if (row) backup.histories.push(row);
}
async function snapshotJournalLines(entryId) {
  if (backup.journalLines.some((row) => row.entryId === entryId)) return;
  const rows = await prisma.journalLine.findMany({ where: { entryId }, select: { id: true, entryId: true, debit: true, credit: true } });
  backup.journalLines.push(...rows);
}
function writeBackup(label) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(backupDir, `deposit-amount-backup-${label}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(backup, null, 2), "utf8");
  return file;
}

async function main() {
  if (rollbackPath) return rollback();
  if (setAmountsPath) return setAmounts();
  if ((apply) && !confirmed) {
    throw new Error("Chế độ --apply bắt buộc kèm --confirm-apply để tránh chạy nhầm trên dữ liệu thật.");
  }
  await audit();
}

async function audit() {
  const deposits = await prisma.deposit.findMany({
    where: { deletedAt: null },
    include: {
      histories: {
        orderBy: { createdAt: "asc" },
        include: { voucher: { select: { id: true, code: true, amount: true, status: true, voucherDate: true } } },
      },
    },
    orderBy: { code: "asc" },
  });

  const historyIds = deposits.flatMap((deposit) => deposit.histories.map((row) => row.id));
  const entries = historyIds.length
    ? await prisma.journalEntry.findMany({
        where: { sourceType: "DEPOSIT_HISTORY", sourceId: { in: historyIds }, deletedAt: null },
        include: { lines: true },
      })
    : [];
  const entryByHistory = new Map(entries.map((entry) => [entry.sourceId, entry]));

  // 1. Lịch sử gắn chứng từ phải mang đúng số tiền của chứng từ đó.
  for (const deposit of deposits) {
    for (const history of deposit.histories) {
      if (!history.voucher || history.voucher.status === "CANCELLED") continue;
      const gap = Number(history.amount || 0) - history.voucher.amount;
      if (Math.abs(gap) > EPS) {
        record({
          type: "HISTORY_VS_VOUCHER", fixable: true, depositCode: deposit.code,
          historyId: history.id, action: history.action, voucherCode: history.voucher.code,
          current: Number(history.amount || 0), expected: history.voucher.amount,
        });
      }
    }
  }

  /** Số đúng của lịch sử sau bước 1, dùng cho các bước cộng dồn phía sau. */
  const resolvedHistoryAmount = (history) => (
    history.voucher && history.voucher.status !== "CANCELLED"
      ? history.voucher.amount
      : Number(history.amount || 0)
  );

  const skipRecompute = new Set();
  for (const deposit of deposits) {
    // Lịch sử UPDATE mang số tiền là vết chỉnh sửa kiểu cũ: nó tự sinh thêm một bút toán
    // thu/hoàn ảo. Không gộp vào số dư ở đây, chỉ báo để chạy repair:deposit-correction.
    const legacyCorrections = deposit.histories.filter(
      (row) => row.action === "UPDATE" && row.amount !== null && Math.abs(Number(row.amount)) > 0,
    );
    if (legacyCorrections.length > 0) {
      skipRecompute.add(deposit.id);
      record({
        type: "LEGACY_UPDATE_CORRECTION", fixable: false, depositCode: deposit.code,
        note: `chạy: npm run repair:deposit-correction -- --code ${deposit.code}`,
        current: deposit.amount,
      });
      continue;
    }

    // 2. Số tiền và số dư của phiếu phải cộng đúng từ lịch sử.
    const increase = deposit.histories
      .filter((row) => INCREASE.includes(row.action))
      .reduce((sum, row) => sum + Math.abs(resolvedHistoryAmount(row)), 0);
    const decrease = deposit.histories
      .filter((row) => DECREASE.includes(row.action))
      .reduce((sum, row) => sum + Math.abs(resolvedHistoryAmount(row)), 0);
    if (increase <= 0) {
      skipRecompute.add(deposit.id);
      record({
        type: "NO_INTAKE_HISTORY", fixable: false, depositCode: deposit.code,
        note: "Không có lịch sử nhận cọc mang số tiền, không suy ra được số đúng",
        current: deposit.amount,
      });
      continue;
    }
    if (Math.abs(deposit.amount - increase) > EPS) {
      record({
        type: "DEPOSIT_VS_HISTORY", fixable: true, depositCode: deposit.code, depositId: deposit.id,
        field: "amount", current: deposit.amount, expected: increase,
      });
    }
    const expectedRemaining = increase - decrease;
    if (Math.abs(deposit.remainingAmount - expectedRemaining) > EPS) {
      record({
        type: "DEPOSIT_VS_HISTORY", fixable: true, depositCode: deposit.code, depositId: deposit.id,
        field: "remainingAmount", current: deposit.remainingAmount, expected: expectedRemaining,
      });
    }
  }

  // 3. Bút toán cọc (chỉ loại không gắn chứng từ; loại gắn chứng từ do chính chứng từ đó
  //    định khoản nên soát ở luồng chứng từ bên dưới).
  for (const deposit of deposits) {
    if (skipRecompute.has(deposit.id)) continue;
    for (const history of deposit.histories) {
      if (history.voucherId) continue;
      const entry = entryByHistory.get(history.id);
      if (!entry) continue;
      const entryAmount = entry.lines.reduce((sum, line) => sum + line.debit, 0);
      const expected = Math.abs(resolvedHistoryAmount(history));
      if (expected > 0 && Math.abs(entryAmount - expected) > EPS) {
        record({
          type: "JOURNAL_VS_HISTORY", fixable: true, depositCode: deposit.code, historyId: history.id,
          entryId: entry.id, entryCode: entry.code, action: history.action,
          current: entryAmount, expected,
        });
      }
    }
  }

  // 4. Bút toán của chứng từ thu/chi phải bằng số tiền chứng từ.
  const vouchers = await prisma.financialVoucher.findMany({
    where: { status: { not: "CANCELLED" } },
    select: { id: true, code: true, amount: true, voucherDate: true, depositCode: true, depositAction: true, description: true, status: true, branchCode: true, partnerName: true },
  });
  const voucherEntries = vouchers.length
    ? await prisma.journalEntry.findMany({
        where: { sourceType: "VOUCHER", sourceId: { in: vouchers.map((row) => row.id) }, deletedAt: null },
        include: { lines: true },
      })
    : [];
  const voucherEntryById = new Map(voucherEntries.map((entry) => [entry.sourceId, entry]));
  for (const voucher of vouchers) {
    const entry = voucherEntryById.get(voucher.id);
    if (!entry) continue;
    const entryAmount = entry.lines.reduce((sum, line) => sum + line.debit, 0);
    if (Math.abs(entryAmount - voucher.amount) > EPS) {
      record({
        type: "JOURNAL_VS_VOUCHER", fixable: false, voucherCode: voucher.code, entryCode: entry.code,
        current: entryAmount, expected: voucher.amount,
        note: "Mở phiếu trên màn Phiếu thu/chi, bấm lưu lại để hệ thống định khoản lại",
      });
    }
  }

  // 5. Các bản ghi còn mang đúng số tiền mẫu 50.000.000. Kèm nhật ký thao tác để người
  //    lập nhớ ra số thật; trong dữ liệu không còn nguồn nào suy ra được số này.
  // Phiếu nào đã có sai lệch suy ra được số đúng thì để bước tự sửa lo, không bắt người
  // lập xác nhận lại con số mà hệ thống tự biết.
  const autoFixedCodes = new Set(findings.filter((row) => row.fixable).map((row) => row.depositCode).filter(Boolean));
  const sampleDeposits = deposits.filter((row) => Math.abs(row.amount - SAMPLE_AMOUNT) <= EPS && !autoFixedCodes.has(row.code));
  const sampleVouchers = vouchers.filter((row) => Math.abs(row.amount - SAMPLE_AMOUNT) <= EPS);
  const auditTrail = await auditTrailFor(
    [...sampleDeposits.map((row) => row.id), ...sampleVouchers.map((row) => row.id)],
  );
  for (const deposit of sampleDeposits) {
    record({
      type: "SAMPLE_AMOUNT_DEPOSIT", fixable: false, depositCode: deposit.code, depositId: deposit.id,
      partnerName: deposit.partnerName, branchCode: deposit.branchCode,
      docDate: deposit.receivedDate.toISOString().slice(0, 10), current: deposit.amount,
      status: deposit.status, note: auditTrail.get(deposit.id) || "Chưa từng được sửa số tiền",
    });
  }
  for (const voucher of sampleVouchers) {
    record({
      type: "SAMPLE_AMOUNT_VOUCHER", fixable: false, voucherCode: voucher.code,
      partnerName: voucher.partnerName, branchCode: voucher.branchCode,
      docDate: voucher.voucherDate.toISOString().slice(0, 10), current: voucher.amount,
      description: voucher.description, note: auditTrail.get(voucher.id) || "Chưa từng được sửa số tiền",
    });
  }

  if (asJson) console.log(JSON.stringify(findings, null, 2));
  else report();

  if (reviewCsvPath) writeReviewCsv();

  const fixable = findings.filter((row) => row.fixable);
  if (!apply) {
    console.log(`\nDRY-RUN: chưa ghi database. ${fixable.length} sai lệch suy ra được số đúng và tự sửa được.`);
    console.log("Chạy lại với: --apply --confirm-apply");
    return;
  }
  await applyFixes(fixable);
}

/** Đọc nhật ký để biết số tiền của phiếu từng được sửa từ bao nhiêu sang bao nhiêu. */
async function auditTrailFor(entityIds) {
  const trail = new Map();
  if (entityIds.length === 0) return trail;
  const logs = await prisma.auditLog.findMany({
    where: { entityId: { in: entityIds }, action: { in: ["UPDATE", "CREATE"] } },
    orderBy: { occurredAt: "asc" },
    select: { entityId: true, occurredAt: true, actorName: true, metadataJson: true },
  });
  for (const log of logs) {
    if (!log.metadataJson) continue;
    let meta;
    try { meta = JSON.parse(log.metadataJson); } catch { continue; }
    const before = meta?.before?.amount;
    const after = meta?.after?.amount;
    if (before === undefined || after === undefined || before === after) continue;
    const line = `${log.occurredAt.toISOString().slice(0, 10)} ${log.actorName || "?"}: ${money(before)} -> ${money(after)}`;
    trail.set(log.entityId, [trail.get(log.entityId), line].filter(Boolean).join(" | "));
  }
  return trail;
}

function report() {
  const titles = {
    HISTORY_VS_VOUCHER: "Lịch sử cọc lệch với chứng từ đã gắn (tự sửa được)",
    DEPOSIT_VS_HISTORY: "Số tiền/số dư phiếu cọc lệch với lịch sử (tự sửa được)",
    JOURNAL_VS_HISTORY: "Bút toán cọc lệch với lịch sử (tự sửa được)",
    JOURNAL_VS_VOUCHER: "Bút toán chứng từ lệch với chứng từ (sửa trên giao diện)",
    LEGACY_UPDATE_CORRECTION: "Vết sửa kiểu cũ sinh bút toán thừa (dùng repair:deposit-correction)",
    NO_INTAKE_HISTORY: "Phiếu cọc không có lịch sử nhận cọc (kiểm tra tay)",
    SAMPLE_AMOUNT_DEPOSIT: "Phiếu cọc đang bằng đúng 50.000.000 (cần người lập xác nhận)",
    SAMPLE_AMOUNT_VOUCHER: "Chứng từ thu/chi đang bằng đúng 50.000.000 (cần người lập xác nhận)",
  };
  if (findings.length === 0) {
    console.log("Không phát hiện sai lệch số tiền cọc.");
    return;
  }
  const groups = new Map();
  for (const finding of findings) {
    if (!groups.has(finding.type)) groups.set(finding.type, []);
    groups.get(finding.type).push(finding);
  }
  for (const [type, rows] of groups) {
    console.log(`\n### ${titles[type] || type} — ${rows.length} bản ghi`);
    console.table(rows.map((row) => ({
      ma: row.depositCode || row.voucherCode || "",
      khach_hang: row.partnerName || "",
      ngay: row.docDate || "",
      chi_tiet: row.field || row.action || row.entryCode || "",
      dang_luu: row.current === undefined ? "" : money(row.current),
      so_dung: row.expected === undefined ? "" : money(row.expected),
      ghi_chu: row.note || "",
    })));
  }
}

/** Bọc một ô CSV theo chuẩn RFC 4180: ngoặc kép bên trong được nhân đôi. */
function csvCell(value) {
  return `"${String(value || "").replace(/"/g, '""')}"`;
}

/** Xuất danh sách phiếu cần người lập điền số thật, rồi nạp lại bằng --set-amounts. */
function writeReviewCsv() {
  const rows = findings.filter((row) => row.type === "SAMPLE_AMOUNT_DEPOSIT" || row.type === "SAMPLE_AMOUNT_VOUCHER");
  const csv = [
    "loai,ma_phieu,khach_hang,cua_hang,ngay,so_dang_luu,so_tien_dung_dien_vao,ghi_chu",
    ...rows.map((row) => [
      row.type === "SAMPLE_AMOUNT_DEPOSIT" ? "COC" : "CHUNG_TU",
      row.depositCode || row.voucherCode,
      csvCell(row.partnerName),
      row.branchCode || "",
      row.docDate || "",
      row.current,
      "",
      csvCell(row.note),
    ].join(",")),
  ].join("\n");
  fs.writeFileSync(reviewCsvPath, csv, "utf8");
  console.log(`\nĐã xuất ${rows.length} phiếu cần xác nhận ra ${reviewCsvPath}`);
  console.log("Điền cột so_tien_dung_dien_vao rồi chạy: --set-amounts <file.csv> --confirm-apply");
}

async function applyFixes(fixable) {
  if (fixable.length === 0) {
    console.log("\nKhông có sai lệch nào suy ra được số đúng để sửa.");
    return;
  }
  for (const finding of fixable) {
    if (finding.type === "HISTORY_VS_VOUCHER") await snapshotHistory(finding.historyId);
    else if (finding.type === "DEPOSIT_VS_HISTORY") await snapshotDeposit(finding.depositId);
    else if (finding.type === "JOURNAL_VS_HISTORY") await snapshotJournalLines(finding.entryId);
  }
  const file = writeBackup("autofix");
  console.log(`\nẢnh chụp trước khi sửa: ${file}`);

  let done = 0;
  for (const finding of fixable) {
    if (finding.type === "HISTORY_VS_VOUCHER") {
      await prisma.depositHistory.update({ where: { id: finding.historyId }, data: { amount: finding.expected } });
      done += 1;
    } else if (finding.type === "DEPOSIT_VS_HISTORY") {
      await prisma.deposit.update({ where: { id: finding.depositId }, data: { [finding.field]: finding.expected } });
      done += 1;
    } else if (finding.type === "JOURNAL_VS_HISTORY") {
      const entry = await prisma.journalEntry.findUnique({ where: { id: finding.entryId }, include: { lines: true } });
      if (!entry) continue;
      for (const line of entry.lines) {
        await prisma.journalLine.update({
          where: { id: line.id },
          data: { debit: line.debit > 0 ? finding.expected : 0, credit: line.credit > 0 ? finding.expected : 0 },
        });
      }
      done += 1;
    }
  }
  console.log(`Đã sửa ${done}/${fixable.length} sai lệch. Chạy lại script để soát lần hai.`);
}

/**
 * Nạp số tiền đã được người lập xác nhận cho các phiếu cọc còn mang số mẫu.
 * Chỉ nhận phiếu chưa phát sinh cấn trừ/hoàn: phiếu đã xử lý thì số tiền do các nghiệp vụ
 * đó quyết định, sửa thẳng ở đây sẽ làm lệch tiếp sổ sách.
 */
/** Tách một dòng CSV, giữ nguyên dấu phẩy nằm trong ô đã bọc ngoặc kép. */
function splitCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { cells.push(cell); cell = ""; }
    else cell += char;
  }
  cells.push(cell);
  return cells;
}

async function setAmounts() {
  if (!confirmed) throw new Error("--set-amounts bắt buộc kèm --confirm-apply.");
  const lines = fs.readFileSync(setAmountsPath, "utf8").split(/\r?\n/).filter(Boolean).slice(1);
  const wanted = [];
  for (const line of lines) {
    const cells = splitCsvLine(line);
    const [kind, code, , , , , newAmount] = cells;
    const amount = Number(String(newAmount || "").replace(/["'.\s]/g, ""));
    if (!code || !Number.isFinite(amount) || amount <= 0) continue;
    wanted.push({ kind: kind.trim(), code: code.trim(), amount });
  }
  if (wanted.length === 0) throw new Error("Không đọc được dòng nào có số tiền hợp lệ ở cột so_tien_dung_dien_vao.");

  const skipped = [];
  const planned = [];
  for (const row of wanted) {
    if (row.kind !== "COC") {
      skipped.push({ ...row, reason: "Chứng từ thu/chi phải sửa trên giao diện để hệ thống định khoản lại" });
      continue;
    }
    const deposit = await prisma.deposit.findFirst({
      where: { code: row.code, deletedAt: null },
      include: { histories: true },
    });
    if (!deposit) { skipped.push({ ...row, reason: "Không tìm thấy phiếu cọc" }); continue; }
    const processed = deposit.histories.some((h) => !["CREATE", "COLLECT", "UPDATE", "OPENING"].includes(h.action))
      || deposit.histories.some((h) => h.voucherId)
      || Math.abs(deposit.remainingAmount - deposit.amount) > EPS;
    if (processed) { skipped.push({ ...row, reason: "Đã phát sinh cấn trừ/hoàn hoặc gắn chứng từ — sửa trên giao diện" }); continue; }
    const intake = deposit.histories.find((h) => INCREASE.includes(h.action) && !h.voucherId);
    if (!intake) { skipped.push({ ...row, reason: "Không có lịch sử nhận cọc để sửa" }); continue; }
    const entry = await prisma.journalEntry.findUnique({
      where: { sourceType_sourceId: { sourceType: "DEPOSIT_HISTORY", sourceId: intake.id } },
      include: { lines: true },
    });
    planned.push({ deposit, intake, entry, amount: row.amount });
  }

  console.table(planned.map((row) => ({
    ma: row.deposit.code, khach_hang: row.deposit.partnerName,
    dang_luu: money(row.deposit.amount), so_moi: money(row.amount),
    but_toan: row.entry ? row.entry.code : "-",
  })));
  if (skipped.length > 0) {
    console.log("\nBỏ qua:");
    console.table(skipped.map((row) => ({ ma: row.code, so_moi: money(row.amount), ly_do: row.reason })));
  }
  if (planned.length === 0) return;

  for (const row of planned) {
    await snapshotDeposit(row.deposit.id);
    await snapshotHistory(row.intake.id);
    if (row.entry) await snapshotJournalLines(row.entry.id);
  }
  const file = writeBackup("set-amounts");
  console.log(`\nẢnh chụp trước khi sửa: ${file}`);

  for (const row of planned) {
    await prisma.$transaction(async (tx) => {
      await tx.depositHistory.update({ where: { id: row.intake.id }, data: { amount: row.amount } });
      await tx.deposit.update({ where: { id: row.deposit.id }, data: { amount: row.amount, remainingAmount: row.amount } });
      if (row.entry) {
        for (const line of row.entry.lines) {
          await tx.journalLine.update({
            where: { id: line.id },
            data: { debit: line.debit > 0 ? row.amount : 0, credit: line.credit > 0 ? row.amount : 0 },
          });
        }
      }
    });
  }
  console.log(`Đã đặt lại số tiền cho ${planned.length} phiếu cọc.`);
}

/** Trả dữ liệu về đúng ảnh chụp trong file backup. */
async function rollback() {
  if (!confirmed) throw new Error("--rollback bắt buộc kèm --confirm-apply.");
  const snapshot = JSON.parse(fs.readFileSync(rollbackPath, "utf8"));
  for (const row of snapshot.deposits || []) {
    await prisma.deposit.update({ where: { id: row.id }, data: { amount: row.amount, remainingAmount: row.remainingAmount, status: row.status } });
  }
  for (const row of snapshot.histories || []) {
    await prisma.depositHistory.update({ where: { id: row.id }, data: { amount: row.amount } });
  }
  for (const row of snapshot.journalLines || []) {
    await prisma.journalLine.update({ where: { id: row.id }, data: { debit: row.debit, credit: row.credit } });
  }
  console.log(`Đã hoàn tác về ảnh chụp ${snapshot.createdAt}: ${(snapshot.deposits || []).length} phiếu cọc, ${(snapshot.histories || []).length} lịch sử, ${(snapshot.journalLines || []).length} dòng bút toán.`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
