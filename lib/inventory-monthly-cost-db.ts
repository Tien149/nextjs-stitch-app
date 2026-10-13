import { createHash } from "node:crypto";
import { Prisma } from "@prisma/custom-client";
import { prisma, type TxClient } from "@/lib/prisma";
import { closedPeriodMessage, findClosedPeriod } from "@/lib/phase3";
import { repostInventoryCogs } from "@/lib/accounting";
import { inventoryTransferDebtCodes, syncTransferInternalDebt } from "@/lib/inventory-transfer";
import { roundVnd } from "@/lib/round-vnd";
import {
  COGS_STOCK_TYPES,
  INVENTORY_COGS_PNL_ITEMS,
  INVENTORY_COGS_START_PERIOD,
  PACKAGING_EXPENSE_PNL_ITEM,
  UNIFORM_EXPENSE_PNL_ITEM,
  planInventoryCogsJournal,
} from "@/lib/inventory-cogs";
import {
  computeMonthlyCosts,
  nextPeriod,
  vnPeriodOf,
  type MonthlyCostDoc,
  type MonthlyCostItem,
  type MonthlyCostResult,
  type OpeningStock,
} from "@/lib/inventory-monthly-cost";
import type { CogsRepostResult } from "@/lib/inventory-cogs";

/**
 * Nút "Tính giá vốn tháng" — đọc chứng từ kho, chạy computeMonthlyCosts (lib/inventory-monthly-cost.ts)
 * rồi chạy thử (so sánh) hoặc ghi thật: đơn giá từng dòng phiếu, công nợ nội bộ điều chuyển liên
 * nhà hàng, giá tháng (InventoryMonthlyCost), giá bình quân tồn hiện tại, ghi sổ lại giá vốn.
 *
 * "Tháng cần tính lại": dấu vân tay mọi dòng phiếu kho của tháng (chỉ phần ĐẦU VÀO của bộ tính —
 * mã, kho, ngày, số lượng, giá nhập mua — không gồm giá ra do chính bộ tính ghi) so với lần tính
 * gần nhất. Bắt được mọi đường thêm / sửa / xoá / khôi phục / import phiếu mà không phải cài cờ
 * ở từng chỗ. Tháng trước đổi thì các tháng sau cũng phải tính lại (tồn đầu đổi theo).
 */

export class MonthlyCostError extends Error {}

const LOCK_KEY = "inventory-monthly-cost";
const PNL_LABELS = new Map<string, string>([
  [INVENTORY_COGS_PNL_ITEMS.KITCHEN.code, INVENTORY_COGS_PNL_ITEMS.KITCHEN.name],
  [INVENTORY_COGS_PNL_ITEMS.BAR.code, INVENTORY_COGS_PNL_ITEMS.BAR.name],
  [INVENTORY_COGS_PNL_ITEMS.OTHER.code, "COGS kho chung"],
  [PACKAGING_EXPENSE_PNL_ITEM.code, PACKAGING_EXPENSE_PNL_ITEM.name],
  [UNIFORM_EXPENSE_PNL_ITEM.code, UNIFORM_EXPENSE_PNL_ITEM.name],
]);

type Client = TxClient | typeof prisma;

export type MonthlyCostSource = {
  documents: Array<MonthlyCostDoc & { toBranchCode: string | null }>;
  items: Array<MonthlyCostItem & { name: string; unit: string }>;
  opening: OpeningStock[];
  openingPeriod: string;
  warehouses: Array<{ code: string; group: string | null; branch: string | null }>;
};

export async function loadMonthlyCostSource(client: Client = prisma): Promise<MonthlyCostSource> {
  const [documents, items, openingRows, warehouses] = await Promise.all([
    client.inventoryTransaction.findMany({
      where: { deletedAt: null },
      select: {
        id: true, code: true, transactionType: true, transactionDate: true, branchCode: true, warehouseCode: true, toWarehouseCode: true, toBranchCode: true,
        lines: { select: { id: true, itemId: true, quantity: true, unitCost: true, totalCost: true, inputUnitCost: true } },
      },
    }),
    client.inventoryItem.findMany({ select: { id: true, code: true, name: true, itemType: true, unit: true } }),
    client.openingBalance.findMany({
      where: { balanceType: "INVENTORY", deletedAt: null, status: { in: ["CONFIRMED", "POSTED"] }, warehouseCode: { not: null } },
      select: { period: true, objectCode: true, warehouseCode: true, quantity: true, amount: true },
    }),
    client.masterDataItem.findMany({ where: { type: "WAREHOUSE" }, select: { code: true, group: true, branch: true } }),
  ]);
  const itemByCode = new Map(items.map((item) => [item.code.toUpperCase(), item]));
  const opening: OpeningStock[] = [];
  for (const row of openingRows) {
    const item = itemByCode.get(String(row.objectCode || "").toUpperCase());
    if (item && row.warehouseCode) opening.push({ itemId: item.id, warehouseCode: row.warehouseCode, quantity: Number(row.quantity) || 0, value: Number(row.amount) || 0 });
  }
  return {
    documents,
    items: items.map((item) => ({ ...item, unit: item.unit || "" })),
    opening,
    openingPeriod: openingRows.map((row) => row.period).sort()[0] || INVENTORY_COGS_START_PERIOD,
    warehouses,
  };
}

/** Dấu vân tay đầu vào bộ tính của từng tháng (giờ VN); tháng đầu kỳ gồm cả số dư đầu kỳ tồn kho. */
export async function periodFingerprints(client: Client = prisma) {
  const rows = await client.$queryRaw<Array<{ period: string; hash: string }>>(Prisma.sql`
    SELECT to_char(t."transactionDate" + interval '7 hours', 'YYYY-MM') AS period,
      md5(string_agg(concat_ws('|', l.id, t.code, t."transactionType", t."warehouseCode", COALESCE(t."toWarehouseCode", ''),
        (extract(epoch from t."transactionDate") * 1000)::bigint, l."itemId", l.quantity, COALESCE(l."inputUnitCost"::text, '-'),
        CASE WHEN t."transactionType" IN ('NHAP_MUA', 'NHAP_KHAC') THEN l."unitCost"::text ELSE '' END), ',' ORDER BY l.id)) AS hash
    FROM "InventoryTransactionLine" l JOIN "InventoryTransaction" t ON t.id = l."transactionId"
    WHERE t."deletedAt" IS NULL
    GROUP BY 1
  `);
  const opening = await client.$queryRaw<Array<{ period: string; hash: string }>>(Prisma.sql`
    SELECT period, md5(string_agg(concat_ws('|', id, "objectCode", "warehouseCode", quantity, amount, status), ',' ORDER BY id)) AS hash
    FROM "OpeningBalance"
    WHERE "balanceType" = 'INVENTORY' AND "deletedAt" IS NULL AND status IN ('CONFIRMED', 'POSTED')
    GROUP BY period
  `);
  const map = new Map(rows.map((row) => [row.period, row.hash]));
  for (const row of opening) map.set(row.period, createHash("md5").update(`${map.get(row.period) || ""}#${row.hash}`).digest("hex"));
  return map;
}

export const currentVnPeriod = () => vnPeriodOf(new Date());

function periodRange(from: string, to: string) {
  const periods: string[] = [];
  for (let period = from; period <= to; period = nextPeriod(period)) periods.push(period);
  return periods;
}

export type MonthlyCostPeriodStatus = {
  period: string;
  status: "OK" | "STALE" | "NEVER" | "STALE_EARLIER";
  computedAt: string | null;
  computedBy: string | null;
};

/** Trạng thái từng tháng từ kỳ đầu kỳ tới tháng hiện tại; `earliestPending` = tháng sớm nhất phải tính (lại). */
export async function monthlyCostStatus(client: Client = prisma) {
  const [fingerprints, runs, openingPeriods] = await Promise.all([
    periodFingerprints(client),
    client.inventoryCostingRun.findMany({ orderBy: { createdAt: "desc" }, select: { fromPeriod: true, toPeriod: true, fingerprintsJson: true, createdAt: true, createdBy: true } }),
    client.openingBalance.findMany({ where: { balanceType: "INVENTORY", deletedAt: null }, select: { period: true }, distinct: ["period"] }),
  ]);
  const first = [...openingPeriods.map((row) => row.period), ...fingerprints.keys()].sort()[0] || INVENTORY_COGS_START_PERIOD;
  const last = [currentVnPeriod(), ...fingerprints.keys()].sort().at(-1) || currentVnPeriod();
  const periods: MonthlyCostPeriodStatus[] = [];
  let broken = false;
  for (const period of periodRange(first, last)) {
    const run = runs.find((row) => row.fromPeriod <= period && row.toPeriod >= period);
    const stored = run ? (JSON.parse(run.fingerprintsJson) as Record<string, string>)[period] || "" : null;
    let status: MonthlyCostPeriodStatus["status"];
    if (!run) status = "NEVER";
    else if (stored !== (fingerprints.get(period) || "")) status = "STALE";
    else status = broken ? "STALE_EARLIER" : "OK";
    if (status !== "OK") broken = true;
    periods.push({ period, status, computedAt: run ? run.createdAt.toISOString() : null, computedBy: run?.createdBy || null });
  }
  return { periods, earliestPending: periods.find((row) => row.status !== "OK")?.period || null, fingerprints };
}

export type MonthlyCostReport = {
  fromPeriod: string;
  toPeriod: string;
  cogs: Array<{ period: string; branchCode: string; label: string; before: number; after: number; fromZero: number }>;
  zeroLines: Array<{ period: string; total: number; before: number; after: number }>;
  unpriced: Array<{ itemCode: string; itemName: string; itemType: string; unit: string; warehouseCode: string; periods: string[]; outQty: number }>;
  changedLines: number;
  changedTransfers: Array<{ code: string; fromBranch: string; toBranch: string; before: number; after: number; settledDebt: string | null }>;
  locked: string | null;
  revaluation: number;
  residual: number;
};

type ChangedLine = { id: string; unitCost: number; totalCost: number };

function analyse(source: MonthlyCostSource, result: MonthlyCostResult, fromPeriod: string, toPeriod: string) {
  const inRange = (period: string) => period >= fromPeriod && period <= toPeriod;
  const itemById = new Map(source.items.map((item) => [item.id, item]));
  const groupOf = new Map(source.warehouses.map((warehouse) => [warehouse.code, warehouse.group]));
  const after = new Map(result.lines.map((row) => [row.lineId, row]));
  const cogs = new Map<string, MonthlyCostReport["cogs"][number]>();
  const zero = new Map<string, MonthlyCostReport["zeroLines"][number]>();
  const changed: ChangedLine[] = [];
  const changedDocs = new Set<string>();

  const cogsOf = (doc: MonthlyCostDoc, totals: (line: MonthlyCostDoc["lines"][number]) => number) => {
    const out = new Map<string, number>();
    for (const line of planInventoryCogsJournal({
      transactionType: doc.transactionType,
      warehouseGroup: groupOf.get(doc.warehouseCode),
      lines: doc.lines.map((row) => ({ totalCost: totals(row), itemType: itemById.get(row.itemId)?.itemType })),
    })) {
      if (line.accountCode === "152") continue;
      const label = PNL_LABELS.get(line.pnlItemCode || "") || line.pnlItemCode || line.accountCode;
      out.set(label, (out.get(label) || 0) + (line.debit || 0) - (line.credit || 0));
    }
    return out;
  };

  for (const doc of source.documents) {
    const period = vnPeriodOf(doc.transactionDate);
    if (!inRange(period)) continue;
    for (const line of doc.lines) {
      const next = after.get(line.id);
      if (!next) continue;
      const total = roundVnd(next.totalCost);
      if (Math.abs(total - line.totalCost) >= 1 || Math.abs(next.unitCost - line.unitCost) > 0.0001) {
        changed.push({ id: line.id, unitCost: next.unitCost, totalCost: total });
        changedDocs.add(doc.id);
      }
    }
    if (doc.transactionType.startsWith("XUAT_")) {
      const stat = zero.get(period) || { period, total: 0, before: 0, after: 0 };
      for (const line of doc.lines) {
        stat.total += 1;
        if (!(line.totalCost > 0)) stat.before += 1;
        if (!((after.get(line.id)?.totalCost || 0) > 0)) stat.after += 1;
      }
      zero.set(period, stat);
    }
    if (!COGS_STOCK_TYPES.includes(doc.transactionType)) continue;
    const before = cogsOf(doc, (line) => line.totalCost);
    const next = cogsOf(doc, (line) => after.get(line.id)?.totalCost || 0);
    const fromZero = cogsOf(doc, (line) => (line.totalCost > 0 ? 0 : after.get(line.id)?.totalCost || 0));
    for (const label of new Set([...before.keys(), ...next.keys()])) {
      const key = `${period}|${doc.branchCode}|${label}`;
      const row = cogs.get(key) || { period, branchCode: doc.branchCode, label, before: 0, after: 0, fromZero: 0 };
      row.before += before.get(label) || 0;
      row.after += next.get(label) || 0;
      row.fromZero += fromZero.get(label) || 0;
      cogs.set(key, row);
    }
  }

  const unpriced = new Map<string, MonthlyCostReport["unpriced"][number]>();
  for (const key of result.keys) {
    if (!inRange(key.period) || key.priceSource !== "NONE" || key.outQty <= 0) continue;
    const item = itemById.get(key.itemId);
    const id = `${key.itemId}|${key.warehouseCode}`;
    const row = unpriced.get(id) || { itemCode: item?.code || key.itemId, itemName: item?.name || "", itemType: item?.itemType || "", unit: item?.unit || "", warehouseCode: key.warehouseCode, periods: [], outQty: 0 };
    row.periods.push(key.period);
    row.outQty += key.outQty;
    unpriced.set(id, row);
  }

  const transfers = source.documents.filter((doc) => changedDocs.has(doc.id) && doc.transactionType === "DIEU_CHUYEN" && doc.toBranchCode && doc.toBranchCode.toUpperCase() !== doc.branchCode.toUpperCase());
  return {
    changed,
    changedDocs,
    transfers,
    report: {
      fromPeriod,
      toPeriod,
      cogs: [...cogs.values()].sort((a, b) => a.period.localeCompare(b.period) || a.branchCode.localeCompare(b.branchCode) || a.label.localeCompare(b.label)),
      zeroLines: [...zero.values()].sort((a, b) => a.period.localeCompare(b.period)),
      unpriced: [...unpriced.values()].sort((a, b) => a.itemCode.localeCompare(b.itemCode) || a.warehouseCode.localeCompare(b.warehouseCode)),
      changedLines: changed.length,
      changedTransfers: transfers.map((doc) => ({
        code: doc.code,
        fromBranch: doc.branchCode,
        toBranch: doc.toBranchCode || "",
        before: doc.lines.reduce((sum, line) => sum + line.totalCost, 0),
        after: doc.lines.reduce((sum, line) => sum + roundVnd(after.get(line.id)?.totalCost || 0), 0),
        settledDebt: null as string | null,
      })),
      locked: null as string | null,
      revaluation: result.keys.filter((key) => inRange(key.period)).reduce((sum, key) => sum + key.revaluation, 0),
      residual: result.keys.filter((key) => inRange(key.period)).reduce((sum, key) => sum + key.residual, 0),
    } satisfies MonthlyCostReport,
  };
}

/** Kỳ khoá sổ + công nợ nội bộ đã gạch của phiếu điều chuyển sẽ đổi trị giá — hai thứ chặn ghi. */
async function blockers(client: Client, source: MonthlyCostSource, fromPeriod: string, toPeriod: string, analysis: ReturnType<typeof analyse>) {
  const targets: Array<{ period: string; branchCode: string }> = [];
  for (const doc of source.documents) {
    const period = vnPeriodOf(doc.transactionDate);
    if (period >= fromPeriod && period <= toPeriod) targets.push({ period, branchCode: doc.branchCode });
  }
  const closed = targets.length ? await findClosedPeriod(targets, client) : null;
  analysis.report.locked = closed ? closedPeriodMessage(closed, "tính lại giá vốn") : null;

  const codes = analysis.transfers.flatMap((doc) => Object.values(inventoryTransferDebtCodes(doc.code)));
  if (codes.length) {
    const settled = await client.debtRecord.findMany({
      where: { code: { in: codes }, deletedAt: null, settlements: { some: {} } },
      select: { code: true },
    });
    const settledCodes = new Set(settled.map((row) => row.code));
    for (const row of analysis.report.changedTransfers) {
      const { receivableCode, payableCode } = inventoryTransferDebtCodes(row.code);
      row.settledDebt = settledCodes.has(receivableCode) ? receivableCode : settledCodes.has(payableCode) ? payableCode : null;
    }
  }
}

function resolveRange(source: MonthlyCostSource, requested: string | null | undefined, earliestPending: string | null) {
  const lastDoc = source.documents.map((doc) => vnPeriodOf(doc.transactionDate)).sort().at(-1) || source.openingPeriod;
  const toPeriod = [currentVnPeriod(), lastDoc].sort().at(-1) || currentVnPeriod();
  const fromPeriod = String(requested || earliestPending || toPeriod).slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(fromPeriod)) throw new MonthlyCostError("Tháng bắt đầu không hợp lệ (YYYY-MM)");
  if (fromPeriod < source.openingPeriod) throw new MonthlyCostError(`Chỉ tính được từ kỳ đầu kỳ tồn kho ${source.openingPeriod}`);
  if (fromPeriod > toPeriod) throw new MonthlyCostError(`Tháng bắt đầu sau tháng hiện tại ${toPeriod}`);
  return { fromPeriod, toPeriod };
}

/** CHẠY THỬ: tính + so sánh, không ghi gì. */
export async function previewMonthlyCost(requestedFrom?: string | null) {
  const status = await monthlyCostStatus();
  const source = await loadMonthlyCostSource();
  const { fromPeriod, toPeriod } = resolveRange(source, requestedFrom, status.earliestPending);
  const result = computeMonthlyCosts({ items: source.items, opening: source.opening, openingPeriod: source.openingPeriod, documents: source.documents, toPeriod });
  const analysis = analyse(source, result, fromPeriod, toPeriod);
  await blockers(prisma, source, fromPeriod, toPeriod, analysis);
  return { report: analysis.report, status: status.periods, result, source };
}

const chunk = <T,>(rows: T[], size: number) => Array.from({ length: Math.ceil(rows.length / size) }, (_, index) => rows.slice(index * size, (index + 1) * size));

/** GHI THẬT từ `requestedFrom` (mặc định tháng sớm nhất cần tính) tới tháng hiện tại. */
export async function applyMonthlyCost(requestedFrom: string | null | undefined, actor: string) {
  const outcome = await prisma.$transaction(async (tx) => {
    // Hai người bấm cùng lúc thì người sau chờ người trước xong.
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${LOCK_KEY}))`);
    const status = await monthlyCostStatus(tx);
    const source = await loadMonthlyCostSource(tx);
    const { fromPeriod, toPeriod } = resolveRange(source, requestedFrom, status.earliestPending);
    const result = computeMonthlyCosts({ items: source.items, opening: source.opening, openingPeriod: source.openingPeriod, documents: source.documents, toPeriod });
    const analysis = analyse(source, result, fromPeriod, toPeriod);
    await blockers(tx, source, fromPeriod, toPeriod, analysis);
    if (analysis.report.locked) throw new MonthlyCostError(analysis.report.locked);
    const settled = analysis.report.changedTransfers.filter((row) => row.settledDebt);
    if (settled.length) {
      throw new MonthlyCostError(`Công nợ nội bộ đã gạch nợ nên không đổi được trị giá điều chuyển: ${settled.map((row) => `${row.code} (${row.settledDebt})`).join(", ")}. Hoàn tác phiếu thu/chi gạch nợ trước rồi tính lại.`);
    }

    for (const rows of chunk(analysis.changed, 500)) {
      await tx.$executeRaw(Prisma.sql`
        UPDATE "InventoryTransactionLine" AS l SET "unitCost" = v.u, "totalCost" = v.t
        FROM (VALUES ${Prisma.join(rows.map((row) => Prisma.sql`(${row.id}, ${row.unitCost}::float8, ${row.totalCost}::float8)`))}) AS v(id, u, t)
        WHERE l.id = v.id
      `);
    }
    for (const doc of analysis.transfers) await syncTransferInternalDebt(tx, doc.id);

    const periods = periodRange(fromPeriod, toPeriod);
    const run = await tx.inventoryCostingRun.create({
      data: {
        fromPeriod,
        toPeriod,
        fingerprintsJson: JSON.stringify(Object.fromEntries(periods.map((period) => [period, status.fingerprints.get(period) || ""]))),
        summaryJson: JSON.stringify({ cogs: analysis.report.cogs, zeroLines: analysis.report.zeroLines, unpriced: analysis.report.unpriced.length, revaluation: analysis.report.revaluation, residual: analysis.report.residual }),
        changedLines: analysis.changed.length,
        createdBy: actor,
      },
    });
    await tx.inventoryMonthlyCost.deleteMany({ where: { period: { in: periods } } });
    for (const rows of chunk(result.keys.filter((key) => key.period >= fromPeriod && key.period <= toPeriod), 2000)) {
      await tx.inventoryMonthlyCost.createMany({ data: rows.map((key) => ({ ...key, runId: run.id })) });
    }
    // Giá bình quân tồn hiện tại = giá tháng mới nhất: phiếu lập sau đó (giá tạm tính) bắt đầu từ giá đúng.
    const latest = result.keys.filter((key) => key.period === toPeriod && key.averageCost > 0);
    for (const rows of chunk(latest, 500)) {
      await tx.$executeRaw(Prisma.sql`
        UPDATE "InventoryBalance" AS b SET "averageCost" = v.a, "updatedAt" = NOW()
        FROM (VALUES ${Prisma.join(rows.map((key) => Prisma.sql`(${key.itemId}, ${key.warehouseCode}, ${key.averageCost}::float8)`))}) AS v(i, w, a)
        WHERE b."itemId" = v.i AND b."warehouseCode" = v.w
      `);
    }
    return { runId: run.id, report: analysis.report, periods, branches: [...new Set(source.documents.filter((doc) => periods.includes(vnPeriodOf(doc.transactionDate))).map((doc) => doc.branchCode))] };
  }, { timeout: 10 * 60 * 1000, maxWait: 60 * 1000 });

  // Ghi sổ lại giá vốn từng tháng × nhà hàng (đọc trị giá phiếu vừa ghi; lịch phân bổ đồng phục dựng lại theo).
  const targets = outcome.periods.flatMap((period) => outcome.branches.map((branchCode) => ({ date: new Date(`${period}-15T12:00:00+07:00`), branchCode })));
  const reposted: CogsRepostResult[] = await repostInventoryCogs(targets, actor);
  return { ...outcome, reposted };
}
