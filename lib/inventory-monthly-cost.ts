import { pickTransferUnitCost } from "@/lib/inventory-stock";

/**
 * TÍNH GIÁ VỐN BÌNH QUÂN CẢ THÁNG (khách chốt 13/10/2026) — phần thuần, không đụng DB.
 *
 * Hằng ngày kho vẫn chạy bình quân liên hoàn theo thứ tự nhập liệu (computeBalanceChange,
 * lib/inventory-stock.ts) làm giá TẠM TÍNH. Nút "Tính giá vốn tháng" chạy hàm này để ra giá
 * CHÍNH THỨC theo ngày chứng từ, nên bổ sung phiếu lùi ngày rồi tính lại là đúng tháng đó:
 *
 *   Giá tháng (mặt hàng × kho) = (Trị giá tồn đầu + Trị giá nhập) ÷ (SL tồn đầu + SL nhập)
 *
 * - Nhập TÍNH vào bình quân: nhập mua / nhập khác có đơn giá (giá phiếu), nhập chế biến (= Σ
 *   nguyên liệu của phiếu xuất chế biến cùng cặp, theo giá tháng), nhập điều chuyển (giá luật).
 * - Nhập ĐI THEO bình quân (không kéo giá): hàng tặng 0 đ, nhập kiểm kê thừa, nhập khác trống giá;
 *   kiểm kê thừa ở kho cả tháng không có giá thì lấy Đơn giá khai trên phiếu.
 * - Mọi phiếu xuất lấy giá tháng của kho; điều chuyển hai đầu cùng giá luật 27/09
 *   (pickTransferUnitCost) — phần chênh với giá tháng kho chuyển nằm lại trong tồn kho chuyển.
 * - Giá chế biến phụ thuộc giá nguyên liệu, điều chuyển kéo giá giữa các kho → giải lặp tới khi
 *   giá đứng yên (định lượng nhiều tầng, chuyển qua lại cùng tháng đều hội tụ sau vài vòng).
 * - Kho không tồn, không nhập (xuất âm): giá tháng trước của kho → giá tháng của kho khác cùng
 *   mã → giá nhập mua gần nhất → 0. Tồn đầu âm thì bỏ khỏi bình quân (như luật liên hoàn) và
 *   định giá lại theo giá tháng — phần chênh báo ở `revaluation`.
 *
 * Tháng tính theo giờ Việt Nam.
 */

export type MonthlyCostLine = {
  id: string;
  itemId: string;
  quantity: number;
  unitCost: number;
  totalCost: number;
  inputUnitCost: number | null;
  /** Số lượng khai (theo ĐVT nhập); trống = dòng cũ chưa lưu số khai. */
  inputQuantity?: number | null;
  /** Phần chi phí mua hàng phân bổ vào dòng (đã nằm trong unitCost) — lib/purchase-cost.ts. */
  purchaseCostShare?: number | null;
};

export type MonthlyCostDoc = {
  id: string;
  code: string;
  transactionType: string;
  transactionDate: Date;
  branchCode: string;
  warehouseCode: string;
  toWarehouseCode: string | null;
  /** Hạng mục P&L của phiếu Xuất khác (không vào giá vốn). */
  pnlItemCode?: string | null;
  lines: MonthlyCostLine[];
};

export type MonthlyCostItem = { id: string; code: string; itemType: string };
export type OpeningStock = { itemId: string; warehouseCode: string; quantity: number; value: number };

export type PriceSource = "AVERAGE" | "INBOUND" | "OPENING" | "PREVIOUS" | "OTHER_WAREHOUSE" | "LATEST_PURCHASE" | "NONE";

export type MonthlyCostKey = {
  period: string;
  itemId: string;
  warehouseCode: string;
  openingQty: number;
  openingValue: number;
  /** Nhập tính vào bình quân. */
  inQty: number;
  inValue: number;
  /** Nhập đi theo bình quân (hàng tặng, kiểm kê thừa, nhập khác trống giá). */
  followQty: number;
  followValue: number;
  outQty: number;
  outValue: number;
  closingQty: number;
  closingValue: number;
  averageCost: number;
  priceSource: PriceSource;
  /** Định giá lại tồn đầu âm theo giá tháng (= SL âm × giá tháng − trị giá mang sang). */
  revaluation: number;
  /** Tồn về 0 mà còn trị giá lẻ (chênh giá điều chuyển với giá tháng) — xoá khỏi tồn, không mang sang. */
  residual: number;
};

export type MonthlyCostLineResult = {
  period: string;
  docId: string;
  lineId: string;
  unitCost: number;
  totalCost: number;
};

export type MonthlyCostResult = {
  periods: string[];
  keys: MonthlyCostKey[];
  lines: MonthlyCostLineResult[];
  iterations: Record<string, number>;
  /** Mã × kho còn đổi giá ở vòng cuối khi chạm trần số vòng (để soi vòng lặp không hội tụ). */
  unconverged: Array<{ period: string; itemId: string; warehouseCode: string; change: number; averageCost: number }>;
};

const EPS = 0.000001;
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const PURCHASED_TYPES = new Set(["RAW_MATERIAL", "PACKAGING", "GOODS", "UNIFORM"]);
const MAX_ITERATIONS = 100;
/** Giá đứng yên khi mọi mã × kho đổi dưới 0,01 đ giữa hai vòng. */
const CONVERGED_VND = 0.01;

/** "YYYY-MM" theo giờ Việt Nam. */
export function vnPeriodOf(date: Date) {
  return new Date(date.getTime() + VN_OFFSET_MS).toISOString().slice(0, 7);
}

/** Ngày giờ VN đặt lên trục UTC — để luật giá điều chuyển (tháng UTC) cắt tháng theo giờ VN. */
const vnClock = (date: Date) => new Date(date.getTime() + VN_OFFSET_MS);

export function nextPeriod(period: string) {
  const [year, month] = period.split("-").map(Number);
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
}

const keyOf = (itemId: string, warehouseCode: string) => `${itemId}|${warehouseCode}`;
const typeOf = (doc: MonthlyCostDoc) => doc.transactionType.toUpperCase();
const isTransfer = (doc: MonthlyCostDoc) => typeOf(doc) === "DIEU_CHUYEN" && Boolean(doc.toWarehouseCode);
const isInbound = (doc: MonthlyCostDoc) => typeOf(doc).startsWith("NHAP_");

/**
 * Nhập mua / nhập khác: có giá thì là giá phiếu (gồm chi phí mua hàng phân bổ — tính vào bình quân),
 * khai 0 đ / trống (hàng tặng: lưu đơn giá khai trống, unitCost là bình quân lúc nhập) thì đi theo
 * bình quân. Dòng cũ không lưu số khai thì tin unitCost.
 */
function fixedInboundUnitCost(doc: MonthlyCostDoc, line: MonthlyCostLine) {
  const type = typeOf(doc);
  if (type === "NHAP_KIEM_KE" || type === "NHAP_CHE_BIEN") return null;
  if ((line.purchaseCostShare || 0) > 0 || (line.inputUnitCost || 0) > 0) return line.unitCost > 0 ? line.unitCost : null;
  if (line.inputQuantity !== null && line.inputQuantity !== undefined) return null;
  return line.unitCost > 0 ? line.unitCost : null;
}

/** Cặp phiếu chế biến: RA-…-3N ↔ RA-…-3X, RA-…-3X2…; CB-…-N ↔ CB-…-X. */
const productionPrefixOfReceipt = (code: string) => code.replace(/N$/, "");
const productionPrefixOfIssue = (code: string) => code.replace(/X\d*$/, "");

export function computeMonthlyCosts(input: {
  items: MonthlyCostItem[];
  opening: OpeningStock[];
  openingPeriod: string;
  documents: MonthlyCostDoc[];
  /** Tính tới hết tháng này (mặc định: tháng của phiếu cuối cùng). */
  toPeriod?: string;
}): MonthlyCostResult {
  const itemById = new Map(input.items.map((item) => [item.id, item]));
  const docs = [...input.documents].sort((a, b) => a.transactionDate.getTime() - b.transactionDate.getTime() || a.code.localeCompare(b.code));
  const docPeriod = new Map(docs.map((doc) => [doc.id, vnPeriodOf(doc.transactionDate)]));

  const firstPeriod = [input.openingPeriod, ...docs.map((doc) => docPeriod.get(doc.id) || "")].filter(Boolean).sort()[0];
  const lastPeriod = input.toPeriod || [input.openingPeriod, ...docs.map((doc) => docPeriod.get(doc.id) || "")].sort().at(-1) || input.openingPeriod;
  const periods: string[] = [];
  for (let period = firstPeriod; period <= lastPeriod; period = nextPeriod(period)) periods.push(period);

  const docsByPeriod = new Map<string, MonthlyCostDoc[]>();
  for (const doc of docs) {
    const period = docPeriod.get(doc.id) || "";
    docsByPeriod.set(period, [...(docsByPeriod.get(period) || []), doc]);
  }

  // Phiếu xuất chế biến theo tiền tố cặp, để phiếu nhập chế biến cộng đúng nguyên liệu của nó.
  const issuesByPrefix = new Map<string, MonthlyCostDoc[]>();
  for (const doc of docs) {
    if (typeOf(doc) !== "XUAT_CHE_BIEN") continue;
    const prefix = productionPrefixOfIssue(doc.code);
    issuesByPrefix.set(prefix, [...(issuesByPrefix.get(prefix) || []), doc]);
  }

  // Phiếu mua có giá cho luật giá điều chuyển + giá nhập mua gần nhất khi kho không có giá.
  const purchaseLinesByItem = new Map<string, Array<{ transactionDate: Date; quantity: number; unitCost: number; totalCost: number }>>();
  for (const doc of docs) {
    if (typeOf(doc) !== "NHAP_MUA") continue;
    for (const line of doc.lines) {
      const unitCost = fixedInboundUnitCost(doc, line);
      if (!unitCost || unitCost <= 0) continue;
      const rows = purchaseLinesByItem.get(line.itemId) || [];
      rows.push({ transactionDate: vnClock(doc.transactionDate), quantity: line.quantity, unitCost, totalCost: line.quantity * unitCost });
      purchaseLinesByItem.set(line.itemId, rows);
    }
  }
  const latestPurchaseBefore = (itemId: string, periodEnd: string) => {
    const rows = (purchaseLinesByItem.get(itemId) || []).filter((row) => row.transactionDate.toISOString().slice(0, 7) <= periodEnd);
    return rows.length ? rows.reduce((best, row) => (row.transactionDate >= best.transactionDate ? row : best)).unitCost : 0;
  };

  // Giá chế biến đã chốt của các tháng trước (cho luật điều chuyển bán thành phẩm).
  const productionLinesByItem = new Map<string, Array<{ transactionDate: Date; quantity: number; unitCost: number; totalCost: number }>>();
  const finalLineCost = new Map<string, number>();

  const carried = new Map<string, { qty: number; value: number }>();
  const previousAverage = new Map<string, number>();
  const keysOut: MonthlyCostKey[] = [];
  const linesOut: MonthlyCostLineResult[] = [];
  const iterations: Record<string, number> = {};
  const unconverged: MonthlyCostResult["unconverged"] = [];

  for (const period of periods) {
    if (period === input.openingPeriod) {
      for (const row of input.opening) {
        const key = keyOf(row.itemId, row.warehouseCode);
        const current = carried.get(key) || { qty: 0, value: 0 };
        carried.set(key, { qty: current.qty + row.quantity, value: current.value + row.value });
      }
    }
    const periodDocs = docsByPeriod.get(period) || [];

    const keys = new Set<string>(carried.keys());
    for (const doc of periodDocs) {
      for (const line of doc.lines) {
        keys.add(keyOf(line.itemId, doc.warehouseCode));
        if (isTransfer(doc)) keys.add(keyOf(line.itemId, doc.toWarehouseCode || ""));
      }
    }

    const average = new Map<string, number>();
    const source = new Map<string, PriceSource>();
    for (const key of keys) average.set(key, previousAverage.get(key) || 0);

    const averageByItem = () => {
      const totals = new Map<string, { sum: number; count: number }>();
      for (const [key, value] of average) {
        if (!(value > 0)) continue;
        const itemId = key.slice(0, key.indexOf("|"));
        const total = totals.get(itemId) || { sum: 0, count: 0 };
        totals.set(itemId, { sum: total.sum + value, count: total.count + 1 });
      }
      return new Map([...totals].map(([itemId, total]) => [itemId, total.sum / total.count]));
    };
    const price = (itemId: string, warehouseCode: string) => average.get(keyOf(itemId, warehouseCode)) || 0;

    const productionValue = (doc: MonthlyCostDoc) => {
      const issues = issuesByPrefix.get(productionPrefixOfReceipt(doc.code)) || [];
      if (issues.length === 0) return null;
      let total = 0;
      for (const issue of issues) {
        const issuePeriod = docPeriod.get(issue.id) || "";
        for (const line of issue.lines) {
          if (issuePeriod === period) total += line.quantity * price(line.itemId, issue.warehouseCode);
          else total += finalLineCost.get(line.id) ?? line.totalCost;
        }
      }
      return total;
    };
    /** Trị giá từng dòng nhập chế biến: chia tổng nguyên liệu theo trị giá cũ (thường chỉ một dòng). */
    const productionLineValues = (doc: MonthlyCostDoc) => {
      const total = productionValue(doc);
      if (total === null) return new Map(doc.lines.map((line) => [line.id, line.totalCost]));
      const oldTotal = doc.lines.reduce((sum, line) => sum + line.totalCost, 0);
      const qtyTotal = doc.lines.reduce((sum, line) => sum + line.quantity, 0);
      return new Map(doc.lines.map((line) => [
        line.id,
        oldTotal > EPS ? total * (line.totalCost / oldTotal) : qtyTotal > EPS ? total * (line.quantity / qtyTotal) : 0,
      ]));
    };

    const transferPrice = (doc: MonthlyCostDoc, line: MonthlyCostLine, semiLines: Map<string, Array<{ transactionDate: Date; quantity: number; unitCost: number; totalCost: number }>>) => {
      const item = itemById.get(line.itemId);
      const itemType = String(item?.itemType || "").toUpperCase();
      let unit = 0;
      if (PURCHASED_TYPES.has(itemType)) {
        unit = pickTransferUnitCost({ itemType, transactionDate: vnClock(doc.transactionDate), lines: purchaseLinesByItem.get(line.itemId) || [] });
      } else if (itemType === "SEMI_FINISHED") {
        unit = pickTransferUnitCost({ itemType, transactionDate: vnClock(doc.transactionDate), lines: semiLines.get(line.itemId) || [] });
      }
      if (!(unit > 0)) unit = price(line.itemId, doc.warehouseCode);
      if (!(unit > 0)) unit = latestPurchaseBefore(line.itemId, period);
      return unit > 0 ? unit : 0;
    };

    let iteration = 0;
    let lineValues = new Map<string, number>();
    const lastChange = new Map<string, number>();
    for (iteration = 1; iteration <= MAX_ITERATIONS; iteration += 1) {
      // Giá chế biến trong tháng (vòng này) + các tháng trước, cho luật điều chuyển bán thành phẩm.
      const semiLines = new Map(productionLinesByItem);
      lineValues = new Map<string, number>();
      for (const doc of periodDocs) {
        if (typeOf(doc) !== "NHAP_CHE_BIEN") continue;
        const values = productionLineValues(doc);
        for (const line of doc.lines) {
          const value = values.get(line.id) || 0;
          lineValues.set(line.id, value);
          if (line.quantity > EPS && value > 0) {
            semiLines.set(line.itemId, [...(semiLines.get(line.itemId) || []), { transactionDate: vnClock(doc.transactionDate), quantity: line.quantity, unitCost: value / line.quantity, totalCost: value }]);
          }
        }
      }

      const inbound = new Map<string, { qty: number; value: number }>();
      const addIn = (key: string, qty: number, value: number) => {
        const current = inbound.get(key) || { qty: 0, value: 0 };
        inbound.set(key, { qty: current.qty + qty, value: current.value + value });
      };
      for (const doc of periodDocs) {
        if (isTransfer(doc)) {
          for (const line of doc.lines) {
            const unit = transferPrice(doc, line, semiLines);
            lineValues.set(line.id, unit * line.quantity);
            addIn(keyOf(line.itemId, doc.toWarehouseCode || ""), line.quantity, unit * line.quantity);
          }
          continue;
        }
        if (!isInbound(doc)) continue;
        for (const line of doc.lines) {
          if (typeOf(doc) === "NHAP_CHE_BIEN") {
            addIn(keyOf(line.itemId, doc.warehouseCode), line.quantity, lineValues.get(line.id) || 0);
            continue;
          }
          const unit = fixedInboundUnitCost(doc, line);
          if (unit !== null) addIn(keyOf(line.itemId, doc.warehouseCode), line.quantity, unit * line.quantity);
        }
      }

      const otherWarehouse = averageByItem();
      let maxChange = 0;
      for (const key of keys) {
        const itemId = key.slice(0, key.indexOf("|"));
        const open = carried.get(key) || { qty: 0, value: 0 };
        const added = inbound.get(key) || { qty: 0, value: 0 };
        let next = 0;
        let from: PriceSource = "NONE";
        if (open.qty > EPS && open.qty + added.qty > EPS && open.value + added.value > EPS) {
          next = (open.value + added.value) / (open.qty + added.qty);
          from = added.qty > EPS ? "AVERAGE" : "OPENING";
        } else if (added.qty > EPS && added.value > EPS) {
          next = added.value / added.qty;
          from = "INBOUND";
        } else if ((previousAverage.get(key) || 0) > 0) {
          next = previousAverage.get(key) || 0;
          from = "PREVIOUS";
        } else if ((otherWarehouse.get(itemId) || 0) > 0) {
          next = otherWarehouse.get(itemId) || 0;
          from = "OTHER_WAREHOUSE";
        } else {
          next = latestPurchaseBefore(itemId, period);
          from = next > 0 ? "LATEST_PURCHASE" : "NONE";
        }
        const change = Math.abs(next - (average.get(key) || 0));
        lastChange.set(key, change);
        maxChange = Math.max(maxChange, change);
        average.set(key, next);
        source.set(key, from);
      }
      if (maxChange < CONVERGED_VND && iteration > 1) break;
    }
    iterations[period] = Math.min(iteration, MAX_ITERATIONS);
    if (iteration > MAX_ITERATIONS) {
      for (const [key, change] of [...lastChange].filter(([, change]) => change >= CONVERGED_VND).sort((a, b) => b[1] - a[1]).slice(0, 20)) {
        unconverged.push({ period, itemId: key.slice(0, key.indexOf("|")), warehouseCode: key.slice(key.indexOf("|") + 1), change, averageCost: average.get(key) || 0 });
      }
    }

    // Ghi giá từng dòng + cộng dồn nhập/xuất từng mã × kho.
    const stats = new Map<string, { inQty: number; inValue: number; followQty: number; followValue: number; outQty: number; outValue: number }>();
    /**
     * Phiếu xuất ra khỏi kho (bán / hủy / test món / xuất khác / kiểm thiếu) cuối cùng của tháng theo
     * mã × kho: tồn về 0 mà còn trị giá lẻ thì dồn phần lẻ vào dòng này (khách 20/10/2026: chạy giá
     * vốn cuối kỳ thì SL 0 trị giá cũng về 0). Không dồn vào điều chuyển / xuất chế biến vì giá của
     * chúng đã chảy sang kho nhận / bán thành phẩm.
     */
    const lastOutLine = new Map<string, { index: number; at: number; quantity: number }>();
    const stat = (key: string) => {
      let row = stats.get(key);
      if (!row) {
        row = { inQty: 0, inValue: 0, followQty: 0, followValue: 0, outQty: 0, outValue: 0 };
        stats.set(key, row);
      }
      return row;
    };
    for (const doc of periodDocs) {
      for (const line of doc.lines) {
        const key = keyOf(line.itemId, doc.warehouseCode);
        let total: number;
        if (isTransfer(doc)) {
          total = lineValues.get(line.id) || 0;
          stat(key).outQty += line.quantity;
          stat(key).outValue += total;
          const toKey = keyOf(line.itemId, doc.toWarehouseCode || "");
          stat(toKey).inQty += line.quantity;
          stat(toKey).inValue += total;
        } else if (isInbound(doc)) {
          const fixed = typeOf(doc) === "NHAP_CHE_BIEN" ? null : fixedInboundUnitCost(doc, line);
          if (typeOf(doc) === "NHAP_CHE_BIEN") {
            total = lineValues.get(line.id) || 0;
            stat(key).inQty += line.quantity;
            stat(key).inValue += total;
          } else if (fixed !== null) {
            total = fixed * line.quantity;
            stat(key).inQty += line.quantity;
            stat(key).inValue += total;
          } else {
            // Kiểm kê thừa ở kho cả tháng không có giá: dùng Đơn giá nhà hàng khai trên phiếu.
            const unit = price(line.itemId, doc.warehouseCode) || (line.inputUnitCost && line.inputUnitCost > 0 ? line.inputUnitCost : 0);
            total = unit * line.quantity;
            stat(key).followQty += line.quantity;
            stat(key).followValue += total;
          }
        } else {
          total = price(line.itemId, doc.warehouseCode) * line.quantity;
          stat(key).outQty += line.quantity;
          stat(key).outValue += total;
        }
        finalLineCost.set(line.id, total);
        linesOut.push({
          period,
          docId: doc.id,
          lineId: line.id,
          unitCost: line.quantity > EPS ? total / line.quantity : 0,
          totalCost: total,
        });
        if (!isTransfer(doc) && !isInbound(doc) && typeOf(doc) !== "XUAT_CHE_BIEN" && line.quantity > EPS) {
          const at = doc.transactionDate.getTime();
          const previous = lastOutLine.get(key);
          if (!previous || at >= previous.at) lastOutLine.set(key, { index: linesOut.length - 1, at, quantity: line.quantity });
        }
        if (typeOf(doc) === "NHAP_CHE_BIEN" && line.quantity > EPS && total > 0) {
          productionLinesByItem.set(line.itemId, [...(productionLinesByItem.get(line.itemId) || []), { transactionDate: vnClock(doc.transactionDate), quantity: line.quantity, unitCost: total / line.quantity, totalCost: total }]);
        }
      }
    }

    for (const key of keys) {
      const [itemId, warehouseCode] = [key.slice(0, key.indexOf("|")), key.slice(key.indexOf("|") + 1)];
      const open = carried.get(key) || { qty: 0, value: 0 };
      const row = stats.get(key) || { inQty: 0, inValue: 0, followQty: 0, followValue: 0, outQty: 0, outValue: 0 };
      const averageCost = average.get(key) || 0;
      // Tồn đầu âm không vào bình quân (luật liên hoàn) → định giá lại theo giá tháng.
      const revaluation = open.qty < -EPS ? open.qty * averageCost - open.value : 0;
      const openingValue = open.value + revaluation;
      const closingQty = open.qty + row.inQty + row.followQty - row.outQty;
      const rawClosingValue = openingValue + row.inValue + row.followValue - row.outValue;
      const residual = Math.abs(closingQty) < EPS ? rawClosingValue : 0;
      const closingValue = rawClosingValue - residual;
      // Dồn phần lẻ vào phiếu xuất cuối tháng để chính các phiếu cộng ra tồn 0 đ (báo cáo NXT lấy trị
      // giá từ phiếu). Không có phiếu xuất nào để dồn thì giữ luật cũ: bỏ khỏi số mang sang.
      const absorb = Math.abs(residual) >= 0.5 ? lastOutLine.get(key) : undefined;
      if (absorb) {
        const target = linesOut[absorb.index];
        target.totalCost += residual;
        target.unitCost = target.totalCost / absorb.quantity;
        finalLineCost.set(target.lineId, target.totalCost);
        row.outValue += residual;
      }
      if (Math.abs(open.qty) < EPS && Math.abs(open.value) < EPS && row.inQty + row.followQty + row.outQty < EPS) continue;
      keysOut.push({
        period, itemId, warehouseCode,
        openingQty: open.qty, openingValue: open.value,
        inQty: row.inQty, inValue: row.inValue,
        followQty: row.followQty, followValue: row.followValue,
        outQty: row.outQty, outValue: row.outValue,
        closingQty, closingValue,
        averageCost,
        priceSource: source.get(key) || "NONE",
        revaluation,
        residual,
      });
      carried.set(key, { qty: closingQty, value: closingValue });
      if (averageCost > 0) previousAverage.set(key, averageCost);
    }
  }

  return { periods, keys: keysOut, lines: linesOut, iterations, unconverged };
}
