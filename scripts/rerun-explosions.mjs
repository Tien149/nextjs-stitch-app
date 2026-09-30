/**
 * Gỡ rồi rã lại các lần rã BOM đã chạy sai kho — làm trọn trên server, không cần giao diện.
 *
 * Dùng đúng logic của nút Rã / "rã lại khi sửa định lượng" (lib/inventory-explosion.ts):
 *   1. (tuỳ chọn) gán Phân nhóm "Món bếp" cho các món chưa suy được bộ phận (--set-kitchen);
 *   2. gỡ từng lần rã: hoàn kho từng phiếu, xoá mềm phiếu, trả dòng doanh thu về hàng chờ;
 *   3. rã lại ĐÚNG các dòng doanh thu đó, cùng ngày chứng từ, với kho bếp / bar của cửa hàng
 *      (kho mặc định và kho nhập BTP/TP = kho bếp) theo luật mới: BTP đi theo món bán, combo
 *      nhập kho bếp và từng thành phần trừ ở kho của nó.
 * Tất cả trong MỘT giao dịch: lỗi ở đâu là huỷ hết, không có cảnh đã gỡ mà chưa rã lại.
 *
 * Chạy thử (mặc định): làm hết trong giao dịch, in kết quả rồi HUỶ — không ghi gì.
 *   npm run rerun:explosions -- --runs RA-2026-0001,RA-2026-0002,RA-2026-0003 --set-kitchen EV0103,EV023,EV0104
 * Ghi thật: thêm --apply. Kỳ đã khoá sổ: thêm --allow-locked (khách đồng ý sửa kỳ đã khoá).
 * Tự tìm MỌI lần rã có phiếu nằm ở kho sai (vd kho văn phòng) thay vì kê mã: --from-warehouses FDS_KKVP
 * (gộp được với --runs). Phiếu KHÔNG do rã ở kho đó (nhập tay, import, điều chuyển) chỉ liệt kê.
 * Rã lại xong, dòng số dư của các kho này mà tồn = 0 và không còn phiếu nào thì xoá luôn, để màn
 * Tồn kho không còn dòng toàn số 0 của kho văn phòng.
 * Kho tự tìm theo nhóm kho BEP / BAR của cửa hàng; cửa hàng có nhiều kho bếp/bar thì chỉ định:
 *   --kitchen ASA=ASA_KBEP,NME=NME_KBEP --bar ASA=ASA_KBAR,NME=NME_KBAR
 * Mã món cho --set-kitchen: phân nhóm lấy tự động (nhóm Thành phẩm của kho BEP), đổi bằng --kitchen-group TP_BEP.
 * Rã lại cả THÁNG (vd sau khi đổi luật rã — lấy tồn trước, chế biến phần thiếu, 29/09/2026):
 *   npm run rerun:explosions -- --month 2026-09 [--branches HCM,HN]
 * Chạy thử in bảng số chế biến cũ → mới theo mã; --apply ghi thật rồi tự ghi sổ lại giá vốn theo
 * kho của các kỳ bị ảnh hưởng (như nút Rã trên màn hình).
 * --include-pending-transfers: đưa phiếu điều chuyển / huỷ / xuất khác có bán thành phẩm CHƯA vào
 * hàng chờ rã (lập trước luật rã điều chuyển 28/09/2026, huỷ 30/09/2026) vào hàng chờ, rồi gộp
 * mọi phiếu đang chờ rã của cửa hàng trong tháng vào lần rã đó (kho xuất chế biến phần xuất đi).
 * --keep-warehouses: giữ đúng kho mà lần rã gốc đã chọn (đọc nhật ký lần rã) thay vì ép về kho
 * bếp / bar duy nhất của cửa hàng — dùng khi rã lại vì đổi LUẬT rã, không phải vì sai kho.
 */
import { prisma } from "../lib/prisma.ts";
import { isPeriodLocked } from "../lib/phase3.ts";
import { explosionRunSettings, rerunExplosions } from "../lib/inventory-explosion.ts";
import { EXPLOSION_ISSUE_TYPES, EXPLOSION_PENDING, refreshTransferExplosionStatus } from "../lib/explosion-sources.ts";
import { repostInventoryCogs } from "../lib/accounting.ts";
import { departmentFromWarehouseGroup, REVENUE_DEPARTMENT_CODES } from "../lib/revenue-department.ts";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || "" : "";
};
const list = (name) => value(name).split(",").map((item) => item.trim()).filter(Boolean);
const mapArg = (name) => new Map(list(name).map((pair) => pair.split("=").map((part) => part.trim().toUpperCase())));

const apply = flag("--apply");
const allowLocked = flag("--allow-locked");
const runCodes = list("--runs").map((code) => code.toUpperCase());
const fromWarehouses = list("--from-warehouses").map((code) => code.toUpperCase());
const month = value("--month");
const keepWarehouses = flag("--keep-warehouses");
const includePendingTransfers = flag("--include-pending-transfers");
const onlyBranches = list("--branches").map((code) => code.toUpperCase());
const kitchenItemCodes = list("--set-kitchen").map((code) => code.toUpperCase());
const kitchenOverride = mapArg("--kitchen");
const barOverride = mapArg("--bar");
const actor = "script rerun-explosions";
if (runCodes.length === 0 && fromWarehouses.length === 0 && !month) {
  console.log("Cách dùng: npm run rerun:explosions -- (--runs RA-2026-0001,RA-2026-0002 | --from-warehouses KHO_A | --month 2026-09 [--branches HCM,HN]) [--set-kitchen MA1,MA2] [--apply] [--allow-locked]");
  process.exit(0);
}
if (month && !/^\d{4}-\d{2}$/.test(month)) {
  console.log(`--month phải dạng YYYY-MM (vd 2026-09), nhận được "${month}"`);
  process.exit(1);
}
const day = (date) => new Date(date).toISOString().slice(0, 10);
/** Đầu tháng --month theo giờ Việt Nam; null khi không chạy theo tháng. */
const monthStart = month ? new Date(`${month}-01T00:00:00+07:00`) : null;
const ROLLBACK = new Error("DRY_RUN_ROLLBACK");

try {
  if (fromWarehouses.length > 0) {
    const inWarehouse = { OR: [{ warehouseCode: { in: fromWarehouses } }, { toWarehouseCode: { in: fromWarehouses } }] };
    const found = await prisma.inventoryTransaction.findMany({
      where: { ...inWarehouse, deletedAt: null, referenceType: "PRODUCTION", referenceCode: { startsWith: "RA-" } },
      distinct: ["referenceCode"],
      select: { referenceCode: true },
    });
    const foundCodes = found.map((row) => (row.referenceCode || "").toUpperCase()).filter(Boolean);
    console.log(`Lần rã có phiếu ở ${fromWarehouses.join(", ")}: ${foundCodes.join(", ") || "không có"}`);
    for (const code of foundCodes) if (!runCodes.includes(code)) runCodes.push(code);
    const others = await prisma.inventoryTransaction.findMany({
      // Liệt kê tường minh cả ô trống: NOT(...) của SQL bỏ luôn dòng có referenceType / referenceCode NULL.
      where: {
        AND: [inWarehouse, { deletedAt: null }, {
          OR: [
            { referenceType: null },
            { referenceType: { not: "PRODUCTION" } },
            { referenceCode: null },
            { NOT: { referenceCode: { startsWith: "RA-" } } },
          ],
        }],
      },
      select: { code: true, transactionType: true, transactionDate: true, warehouseCode: true, toWarehouseCode: true, importBatchId: true },
      orderBy: { transactionDate: "asc" },
    });
    if (others.length > 0) {
      console.log(`!! ${others.length} phiếu KHÔNG do rã ở kho này — script không đụng, xử lý tay (xoá / điều chuyển sang kho bếp, bar):`);
      for (const doc of others.slice(0, 40)) {
        console.log(`    ${day(doc.transactionDate)} ${doc.code} ${doc.transactionType} ${doc.warehouseCode}${doc.toWarehouseCode ? ` -> ${doc.toWarehouseCode}` : ""}${doc.importBatchId ? " [import]" : ""}`);
      }
      if (others.length > 40) console.log(`    ... còn ${others.length - 40} phiếu`);
    }
    if (runCodes.length === 0) process.exit(0);
  }

  if (month) {
    // Ranh giới tháng theo giờ Việt Nam: phiếu rã mang giờ VN (23:59:59 ngày cuối / giờ chốt).
    const start = new Date(`${month}-01T00:00:00+07:00`);
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);
    const branchFilter = onlyBranches.length ? { branchCode: { in: onlyBranches } } : {};
    const found = await prisma.inventoryTransaction.findMany({
      where: { deletedAt: null, referenceType: "PRODUCTION", referenceCode: { startsWith: "RA-" }, transactionDate: { gte: start, lt: end }, ...branchFilter },
      distinct: ["referenceCode"],
      select: { referenceCode: true },
    });
    const foundCodes = found.map((row) => (row.referenceCode || "").toUpperCase()).filter(Boolean);
    console.log(`Lần rã có phiếu trong tháng ${month}${onlyBranches.length ? ` (${onlyBranches.join(", ")})` : ""}: ${foundCodes.length} lần`);
    for (const code of foundCodes) if (!runCodes.includes(code)) runCodes.push(code);
    // Lần rã SAU tháng này đã dùng tồn theo số cũ: rã lại tháng này đổi tồn đầu của chúng.
    const later = await prisma.inventoryTransaction.findMany({
      where: { deletedAt: null, referenceType: "PRODUCTION", referenceCode: { startsWith: "RA-" }, transactionDate: { gte: end }, ...branchFilter },
      distinct: ["referenceCode"],
      select: { referenceCode: true },
    });
    if (later.length > 0) {
      console.log(`!! Còn ${later.length} lần rã SAU tháng ${month} (${later.map((row) => row.referenceCode).slice(0, 10).join(", ")}) — nên rã lại luôn các tháng sau cho tồn nối tiếp đúng.`);
    }
    if (runCodes.length === 0) process.exit(0);
  }

  // Thông tin từng lần rã từ chính phiếu của nó (cửa hàng + ngày chứng từ).
  const runs = [];
  for (const runCode of runCodes) {
    const doc = await prisma.inventoryTransaction.findFirst({
      where: { referenceType: "PRODUCTION", referenceCode: runCode, deletedAt: null },
      select: { branchCode: true, transactionDate: true },
    });
    if (!doc) { console.log(`!! ${runCode}: không còn phiếu nào (đã gỡ hoặc sai mã) — bỏ qua.`); continue; }
    const rows = await prisma.revenueImportRow.count({ where: { inventoryStatus: `POSTED:${runCode}` } });
    const locked = await isPeriodLocked(doc.transactionDate, doc.branchCode);
    runs.push({ runCode, branchCode: doc.branchCode, date: doc.transactionDate, productCodes: [], rows, locked });
  }
  runs.sort((a, b) => a.date - b.date || a.runCode.localeCompare(b.runCode));
  if (runs.length === 0) process.exit(0);

  // Kho bếp / bar của từng cửa hàng.
  const warehouses = await prisma.masterDataItem.findMany({ where: { type: "WAREHOUSE", status: "ACTIVE" }, select: { code: true, name: true, branch: true, group: true } });
  const settingsByBranch = new Map();
  let blocked = false;
  if (keepWarehouses) {
    console.log("Giữ nguyên kho của từng lần rã gốc (theo nhật ký lần rã):");
    for (const run of runs) {
      const docs = await prisma.inventoryTransaction.findMany({ where: { referenceType: "PRODUCTION", referenceCode: run.runCode, deletedAt: null }, select: { warehouseCode: true } });
      const original = await explosionRunSettings(prisma, run, docs);
      console.log(`  ${run.runCode}: kho mặc định ${original.warehouseCode || "?"}, kho nhập ${original.toWarehouseCode || "?"}, kho bếp ${original.kitchenWarehouseCode || "(trống)"}, kho bar ${original.barWarehouseCode || "(trống)"}`);
    }
  }
  for (const branchCode of keepWarehouses ? [] : [...new Set(runs.map((run) => run.branchCode))]) {
    const own = warehouses.filter((row) => (row.branch || "").toUpperCase() === branchCode.toUpperCase());
    const pick = (department, override, label) => {
      if (override.get(branchCode.toUpperCase())) return override.get(branchCode.toUpperCase());
      const found = own.filter((row) => departmentFromWarehouseGroup(row.group) === department);
      if (found.length === 1) return found[0].code;
      console.log(`!! ${branchCode}: ${found.length === 0 ? "không có" : "có nhiều"} kho ${label} (${found.map((row) => row.code).join(", ") || "—"}) — chỉ định bằng --${label === "bếp" ? "kitchen" : "bar"} ${branchCode}=MÃ_KHO`);
      blocked = true;
      return "";
    };
    const kitchen = pick(REVENUE_DEPARTMENT_CODES.KITCHEN, kitchenOverride, "bếp");
    const bar = pick(REVENUE_DEPARTMENT_CODES.BAR, barOverride, "bar");
    settingsByBranch.set(branchCode, { kitchen, bar });
    console.log(`Cửa hàng ${branchCode}: kho bếp ${kitchen || "?"}, kho bar ${bar || "?"} (kho mặc định & kho nhập BTP/TP = kho bếp)`);
  }

  console.log("\nLần rã sẽ gỡ và rã lại:");
  for (const run of runs) {
    console.log(`  ${run.runCode} · ${run.branchCode} · ngày ${day(run.date)} · ${run.rows} dòng doanh thu${run.locked ? " · KỲ ĐÃ KHOÁ" : ""}`);
  }
  if (runs.some((run) => run.locked) && !allowLocked) {
    console.log("\n!! Có lần rã nằm trong kỳ đã khoá sổ. Thêm --allow-locked nếu khách đồng ý sửa kỳ đã khoá.");
    blocked = true;
  }

  // Phân nhóm "Món bếp" cho --set-kitchen.
  let kitchenGroup = value("--kitchen-group").toUpperCase();
  if (kitchenItemCodes.length > 0 && !kitchenGroup) {
    const groups = await prisma.masterDataItem.findMany({ where: { type: "INVENTORY_ITEM_GROUP", status: "ACTIVE" }, select: { code: true, name: true, group: true, subGroup: true } });
    const candidates = groups.filter((group) => (group.group || "").toUpperCase() === "FINISHED" && departmentFromWarehouseGroup(group.subGroup) === REVENUE_DEPARTMENT_CODES.KITCHEN);
    if (candidates.length === 1) kitchenGroup = candidates[0].code;
    else {
      console.log(`!! Không chọn được phân nhóm Món bếp tự động (${candidates.map((group) => `${group.code} ${group.name}`).join(", ") || "không có"}) — chỉ định bằng --kitchen-group MÃ`);
      blocked = true;
    }
  }
  const kitchenItems = kitchenItemCodes.length ? await prisma.inventoryItem.findMany({ where: { code: { in: kitchenItemCodes } }, select: { id: true, code: true, name: true, category: true } }) : [];
  if (kitchenItemCodes.length) {
    console.log(`\nGán phân nhóm ${kitchenGroup || "?"} (Món bếp):`);
    for (const code of kitchenItemCodes) {
      const item = kitchenItems.find((row) => row.code.toUpperCase() === code);
      console.log(item ? `  ${item.code} ${item.name}: ${item.category || "(trống)"} -> ${kitchenGroup}` : `  !! ${code}: không có mặt hàng này`);
      if (!item) blocked = true;
    }
  }
  if (blocked) {
    console.log("\nDừng — sửa các mục !! ở trên rồi chạy lại.");
    process.exit(1);
  }

  const results = [];
  /** Số chế biến (NHAP_CHE_BIEN) theo mã: trước và sau khi rã lại — để thấy luật mới đổi gì. */
  const producedBefore = new Map();
  const producedAfter = new Map();
  const sumProduced = async (tx, refCodes, target) => {
    if (refCodes.length === 0) return;
    const lines = await tx.inventoryTransactionLine.findMany({
      where: { transaction: { referenceType: "PRODUCTION", referenceCode: { in: refCodes }, transactionType: "NHAP_CHE_BIEN", deletedAt: null } },
      select: { quantity: true, item: { select: { code: true } } },
    });
    for (const line of lines) target.set(line.item.code, (target.get(line.item.code) || 0) + line.quantity);
  };
  let cleanedBalances = 0;
  let remainingBalances = 0;
  try {
    await prisma.$transaction(async (tx) => {
      for (const item of kitchenItems) {
        await tx.inventoryItem.update({ where: { id: item.id }, data: { category: kitchenGroup } });
      }
      await sumProduced(tx, runs.map((run) => run.runCode), producedBefore);
      const claimedTransfers = new Set();
      if (includePendingTransfers) {
        // Điều chuyển lập trước luật rã điều chuyển còn explosionStatus trống: xét lại từng phiếu.
        const unset = await tx.inventoryTransaction.findMany({
          where: { transactionType: { in: EXPLOSION_ISSUE_TYPES }, explosionStatus: null, deletedAt: null, branchCode: { in: [...new Set(runs.map((run) => run.branchCode))] } },
          select: { id: true },
        });
        let queued = 0;
        for (const transfer of unset) if ((await refreshTransferExplosionStatus(tx, transfer.id)) === EXPLOSION_PENDING) queued += 1;
        console.log(`\nĐiều chuyển / huỷ / xuất khác chưa xét rã: ${unset.length} phiếu, ${queued} phiếu có bán thành phẩm có định lượng → vào hàng chờ rã.`);
      }
      const reruns = await rerunExplosions(tx, runs, actor, {
        // Mỗi điều chuyển về lần rã SỚM NHẤT của cùng cửa hàng có ngày >= ngày phiếu (rã lại chạy
        // theo thứ tự thời gian nên lần sớm nhận trước). Chạy theo tháng thì lấy từ đầu tháng: nhật
        // ký lần rã cũ nhiều khi chỉ ghi ngày cuối nên khoảng ngày của nó không phủ cả tháng.
        extraSources: includePendingTransfers ? async (run, settings) => {
          const from = monthStart ? new Date(monthStart) : new Date(settings.dateFrom);
          if (!monthStart) from.setHours(0, 0, 0, 0);
          const to = new Date(run.date);
          to.setHours(23, 59, 59, 999);
          const pending = await tx.inventoryTransaction.findMany({
            where: { transactionType: { in: EXPLOSION_ISSUE_TYPES }, branchCode: run.branchCode, explosionStatus: EXPLOSION_PENDING, deletedAt: null, transactionDate: { gte: from, lte: to } },
            select: { id: true, code: true, transactionType: true, transactionDate: true, warehouseCode: true, toWarehouseCode: true },
            orderBy: { transactionDate: "asc" },
          });
          const mine = pending.filter((row) => !claimedTransfers.has(row.id));
          for (const row of mine) claimedTransfers.add(row.id);
          if (mine.length > 0) {
            const transfers = mine.filter((row) => row.transactionType === "DIEU_CHUYEN").length;
            console.log(`  ${run.runCode} gộp ${transfers} điều chuyển + ${mine.length - transfers} huỷ / xuất khác: ${mine.slice(0, 12).map((row) => `${row.code} ${day(row.transactionDate)} ${row.warehouseCode}${row.toWarehouseCode ? `→${row.toWarehouseCode}` : ` ${row.transactionType}`}`).join(", ")}${mine.length > 12 ? "..." : ""}`);
          }
          return { transferIds: mine.map((row) => row.id), stocktakeIds: [] };
        } : undefined,
        overrideSettings: keepWarehouses ? undefined : (run, original) => {
          const { kitchen, bar } = settingsByBranch.get(run.branchCode);
          return { ...original, warehouseCode: kitchen, toWarehouseCode: kitchen, kitchenWarehouseCode: kitchen, barWarehouseCode: bar };
        },
        note: (run) => (keepWarehouses
          ? `rã lại ${run.runCode}: lấy tồn trước, chế biến phần thiếu`
          : `rã lại ${run.runCode}: BTP theo kho món bán, combo theo thành phần`),
      });
      // Dọn dòng số dư rỗng ở kho sai: tồn = 0 và không còn phiếu sống nào của mặt hàng ở kho đó.
      if (fromWarehouses.length > 0) {
        const balances = await tx.inventoryBalance.findMany({ where: { warehouseCode: { in: fromWarehouses } }, select: { id: true, itemId: true, warehouseCode: true, quantity: true } });
        for (const balance of balances) {
          if (Math.abs(balance.quantity) > 0.000001) continue;
          const alive = await tx.inventoryTransactionLine.count({
            where: {
              itemId: balance.itemId,
              transaction: { deletedAt: null, OR: [{ warehouseCode: balance.warehouseCode }, { toWarehouseCode: balance.warehouseCode }] },
            },
          });
          if (alive > 0) continue;
          await tx.inventoryBalance.delete({ where: { id: balance.id } });
          cleanedBalances += 1;
        }
        const remaining = await tx.inventoryBalance.count({ where: { warehouseCode: { in: fromWarehouses } } });
        remainingBalances = remaining;
      }
      await sumProduced(tx, reruns.map((rerun) => rerun.newRunCode).filter(Boolean), producedAfter);
      if (includePendingTransfers) {
        const left = await tx.inventoryTransaction.findMany({
          where: { transactionType: { in: EXPLOSION_ISSUE_TYPES }, explosionStatus: EXPLOSION_PENDING, deletedAt: null, branchCode: { in: [...new Set(runs.map((run) => run.branchCode))] } },
          select: { code: true, transactionDate: true },
          orderBy: { transactionDate: "asc" },
        });
        if (left.length > 0) {
          console.log(`  Còn ${left.length} điều chuyển chờ rã NGOÀI khoảng ngày các lần rã này (rã ở tháng của chúng): ${left.slice(0, 10).map((row) => `${row.code} ${day(row.transactionDate)}`).join(", ")}${left.length > 10 ? "..." : ""}`);
        }
      }
      for (const rerun of reruns) {
        const docs = rerun.newRunCode
          ? await tx.inventoryTransaction.findMany({ where: { referenceCode: rerun.newRunCode, deletedAt: null }, select: { warehouseCode: true, transactionType: true } })
          : [];
        const byWarehouse = new Map();
        for (const doc of docs) byWarehouse.set(doc.warehouseCode, (byWarehouse.get(doc.warehouseCode) || 0) + 1);
        results.push({ ...rerun, byWarehouse });
      }
      if (!apply) throw ROLLBACK;
      // Nhật ký cho lần rã mới: lần sửa định lượng sau còn rã lại được nó với đúng kho.
      for (const rerun of reruns) {
        if (!rerun.newRunCode) continue;
        await tx.auditLog.create({
          data: {
            module: "/inventory",
            action: "EXPLODE_PRODUCTION",
            entityType: "InventoryTransaction",
            entityCode: rerun.newRunCode,
            branchCode: rerun.branchCode,
            actorName: actor,
            metadataJson: JSON.stringify({ ...rerun.settings, dateTo: rerun.date, rerunOf: rerun.oldRunCode, reason: keepWarehouses ? "Rã lại theo luật lấy tồn trước (script)" : "Rã lại theo kho bếp/bar (script)", documents: rerun.documents }),
          },
        });
      }
    }, { timeout: 15 * 60 * 1000, maxWait: 60 * 1000 });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }

  console.log(`\n${apply ? "ĐÃ GHI" : "CHẠY THỬ (đã huỷ, chưa ghi gì)"}:`);
  for (const result of results) {
    const perWarehouse = [...result.byWarehouse.entries()].map(([code, count]) => `${code} ${count} phiếu`).join(", ");
    console.log(`  ${result.oldRunCode} -> ${result.newRunCode || "(không còn dòng doanh thu, chỉ gỡ)"} · ${result.documents.length} phiếu · ${perWarehouse}`);
  }
  const changed = [...new Set([...producedBefore.keys(), ...producedAfter.keys()])]
    .map((code) => ({ code, before: producedBefore.get(code) || 0, after: producedAfter.get(code) || 0 }))
    .filter((row) => Math.abs(row.before - row.after) > 0.0005)
    .sort((a, b) => Math.abs(b.before - b.after) - Math.abs(a.before - a.after));
  const qty = (n) => n.toLocaleString("vi-VN", { maximumFractionDigits: 3 });
  console.log(`\nSố chế biến đổi (cũ → mới), ${changed.length} mã:`);
  for (const row of changed.slice(0, 40)) console.log(`  ${row.code}: ${qty(row.before)} → ${qty(row.after)}`);
  if (changed.length > 40) console.log(`  ... còn ${changed.length - 40} mã`);
  if (apply) {
    // Như nút Rã: rã lại xong tự ghi sổ lại giá vốn theo kho của các kỳ bị ảnh hưởng.
    const newCodes = results.map((result) => result.newRunCode).filter(Boolean);
    const docs = newCodes.length
      ? await prisma.inventoryTransaction.findMany({ where: { referenceCode: { in: newCodes }, deletedAt: null }, select: { transactionDate: true, branchCode: true } })
      : [];
    const cogs = await repostInventoryCogs([
      ...runs.map((run) => ({ date: run.date, branchCode: run.branchCode })),
      ...docs.map((doc) => ({ date: doc.transactionDate, branchCode: doc.branchCode })),
    ], actor);
    console.log("\nGhi sổ lại giá vốn theo kho:");
    for (const row of cogs) console.log(`  ${row.period} · ${row.branchCode}: ${row.status}${row.error ? ` — ${row.error}` : ""}`);
    if (cogs.some((row) => row.status === "NEEDS_SYNC")) console.log("  NEEDS_SYNC: kỳ còn bút toán mua Nợ 632 kiểu cũ — bấm Ghi sổ kỳ một lần trên màn hình.");
  }
  if (fromWarehouses.length > 0) {
    console.log(`  Dọn ${cleanedBalances} dòng số dư rỗng ở ${fromWarehouses.join(", ")}; còn lại ${remainingBalances} dòng (có tồn hoặc còn phiếu không do rã).`);
  }
  if (!apply) console.log("\nKiểm tra xong thì chạy lại với --apply để ghi thật.");
} finally {
  await prisma.$disconnect();
}
