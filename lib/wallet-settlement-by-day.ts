import { prisma } from "@/lib/prisma";
import { moneySourceMatchesBranch, normalizeMoneySourceGroup } from "@/lib/money-sources";
import { createMoneySourceMatcher } from "@/lib/reports";
import { vietnamBusinessDayBounds, vietnamBusinessDayKey } from "@/lib/revenue-date";
import { selectWalletDeclaredRevenue, walletRevenueBucket } from "@/lib/wallet-revenue-reconciliation";

/**
 * Gross ví và phí của MỘT lần tiền về gộp nhiều ngày doanh thu, tính riêng cho từng ngày.
 *
 * Ca thật (khách hỏi 23/09/2026): sao kê 126B2680FCCJ1ACG ngày 10/08 trả gộp doanh thu Momo
 * 07, 08, 09/08 — doanh thu 71.921.955 đ, tiền về 70.735.243 đ, phí thật 1.186.712 đ. Phiếu
 * QTVI-2608-NME-00057 lại chỉ ghi phí 307.359 đ (đúng phí riêng ngày 09/08): gross chốt từ lúc
 * import, màn Tách dòng tiền về giữ nguyên tổng, còn nút "Chạy lại theo doanh thu hiện tại" đòi
 * phiếu có đúng một Ngày doanh thu. 879.353 đ phí treo lại trên ví, không lên chi phí.
 *
 * Luật tính giống hệt lúc import tự điền gross (lib/import-validation.ts:
 * fillWalletGrossFromPosRevenue): gross của ngày = doanh thu POS của ví ngày đó − phần gross
 * đã quyết toán ở các dòng sao kê KHÁC; phí = gross − tiền về của ngày đó.
 */

export type WalletDayLine = {
  revenueDate: Date;
  /** Tiền thực về của dòng. */
  netAmount: number;
};

export type WalletDayResult = {
  day: string;
  netAmount: number;
  /** Doanh thu của ví trong ngày theo dữ liệu hiện tại. */
  revenue: number;
  /** Gross ngày đó đã được các dòng sao kê khác nhận. */
  claimedElsewhere: number;
  grossAmount: number;
  feeAmount: number;
};

export type WalletGrossByDayPlan = {
  days: WalletDayResult[];
  /** Gross từng dòng, cùng thứ tự `lines` truyền vào. */
  lineGross: number[];
  totalNet: number;
  totalGross: number;
  totalFee: number;
};

export type WalletGrossByDayResult =
  | { ok: true; plan: WalletGrossByDayPlan }
  | { ok: false; reason: string };

const money = (value: number) => Math.round(value).toLocaleString("vi-VN");
const dayText = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("vi-VN", { timeZone: "UTC" });

/** Phần thuần: đã có doanh thu và phần đã nhận theo ngày, chia ra gross/phí từng dòng. */
export function planWalletGrossByDay(input: {
  lines: WalletDayLine[];
  revenueByDay: Map<string, number>;
  claimedByDay: Map<string, number>;
  /** Ngày có doanh thu không quy được về đúng một ví. */
  contestedDays?: Set<string>;
  walletLabel?: string;
}): WalletGrossByDayResult {
  const wallet = input.walletLabel || "ví này";
  if (input.lines.length === 0) return { ok: false, reason: "Không có dòng tiền về nào để tính phí." };

  const keys = input.lines.map((line) => vietnamBusinessDayKey(line.revenueDate));
  const days = [...new Set(keys)].sort();
  const lineGross = input.lines.map(() => 0);
  const results: WalletDayResult[] = [];

  for (const day of days) {
    if (input.contestedDays?.has(day)) {
      return { ok: false, reason: `Doanh thu ngày ${dayText(day)} không tách được riêng cho ${wallet} (trùng tên với ví khác), không tính phí tự động được.` };
    }
    const indexes = keys.flatMap((key, index) => (key === day ? [index] : []));
    const netAmount = indexes.reduce((sum, index) => sum + Math.round(input.lines[index].netAmount), 0);
    const revenue = Math.round(input.revenueByDay.get(day) || 0);
    const claimedElsewhere = Math.round(input.claimedByDay.get(day) || 0);
    const available = revenue - claimedElsewhere;
    if (revenue <= 0) {
      return { ok: false, reason: `Ngày ${dayText(day)} chưa có doanh thu POS của ${wallet}. Nạp file doanh thu ngày đó trước rồi mới tính được phí.` };
    }
    if (available < netAmount) {
      return {
        ok: false,
        reason: `Ngày ${dayText(day)}: doanh thu ${wallet} ${money(revenue)} đ`
          + (claimedElsewhere > 0 ? `, đã quyết toán ở sao kê khác ${money(claimedElsewhere)} đ` : "")
          + `, còn ${money(available)} đ — nhỏ hơn tiền về ${money(netAmount)} đ. Kiểm tra lại Ngày doanh thu của từng dòng.`,
      };
    }
    // Hai dòng cùng ngày (hiếm): chia gross theo tỷ trọng tiền về, phần dư dồn vào dòng cuối.
    let remaining = available;
    indexes.forEach((index, position) => {
      const gross = position === indexes.length - 1
        ? remaining
        : Math.round((available * Math.round(input.lines[index].netAmount)) / netAmount);
      remaining -= gross;
      lineGross[index] = gross;
    });
    results.push({ day, netAmount, revenue, claimedElsewhere, grossAmount: available, feeAmount: available - netAmount });
  }

  const totalNet = results.reduce((sum, row) => sum + row.netAmount, 0);
  const totalGross = results.reduce((sum, row) => sum + row.grossAmount, 0);
  return { ok: true, plan: { days: results, lineGross, totalNet, totalGross, totalFee: totalGross - totalNet } };
}

/**
 * Nạp doanh thu POS + phần đã quyết toán ở sao kê khác rồi gọi planWalletGrossByDay.
 * `excludeBankTransactionId` là chính dòng sao kê đang tính — gross cũ của nó không được tính
 * là "đã nhận", nếu không lần chạy lại nào cũng tự trừ chính mình.
 */
export async function computeWalletGrossByDay(input: {
  branchCode: string;
  walletCode: string;
  lines: WalletDayLine[];
  excludeBankTransactionId: string;
}): Promise<WalletGrossByDayResult & { walletLabel: string; isGrab: boolean; posFeeDeclared: number }> {
  const walletSources = await prisma.masterDataItem.findMany({
    where: { type: "MONEY_SOURCE", deletedAt: null },
    select: { code: true, name: true, group: true, branch: true },
  });
  const wallet = walletSources.find((item) => item.code === input.walletCode);
  const walletLabel = wallet?.name || input.walletCode;
  if (!wallet || normalizeMoneySourceGroup(wallet.group) !== "WALLET") {
    return { ok: false, reason: `Nguồn tiền [${input.walletCode}] không phải ví/cổng POS.`, walletLabel, isGrab: false, posFeeDeclared: 0 };
  }
  const bucket = walletRevenueBucket({ code: wallet.code, name: wallet.name });
  // Số thu ngân khai chỉ có tổng theo nhóm: ví cùng nhóm CỦA CÙNG CỬA HÀNG là đối thủ. Trước đây
  // lấy ví của mọi cửa hàng, nên GrabFood Nam Mê "tranh" với GrabFood ASA và gần như phiếu nào
  // cũng báo "trùng tên với ví khác" (chẩn đoán 24/09/2026: 30/31 phiếu NME kỳ 09 không tính được).
  const rivals = walletSources
    .filter((item) => item.code !== wallet.code
      && normalizeMoneySourceGroup(item.group) === "WALLET"
      && moneySourceMatchesBranch(item, input.branchCode)
      && walletRevenueBucket({ code: item.code, name: item.name }) === bucket)
    .map((item) => ({ code: item.code, name: item.name }));
  // Ngày có POS: nối từng dòng về nguồn tiền bằng ĐÚNG bộ nối của bảng Tiền về đủ chưa (theo cửa
  // hàng, nhãn chính xác trước, mã rút gọn chỉ khi một ứng viên). Dò từ khoá kiểu cũ làm dòng
  // "KCF - Quẹt Thẻ Momo" cũng khớp lỏng với "ASA - Quẹt Thẻ Momo" và cả phiếu bị bỏ qua.
  const matchPosSource = createMoneySourceMatcher(walletSources, input.branchCode);

  const ranges = input.lines.map((line) => vietnamBusinessDayBounds(line.revenueDate));
  const rangeStart = new Date(Math.min(...ranges.map((range) => range.start.getTime())));
  const rangeEnd = new Date(Math.max(...ranges.map((range) => range.end.getTime())));

  const [posRows, manualRows, claimed] = await Promise.all([
    prisma.revenueImportRow.findMany({
      where: { branchCode: input.branchCode, saleDate: { gte: rangeStart, lt: rangeEnd }, deletedAt: null },
      select: { saleDate: true, paymentMethod: true, revenueSource: true, channel: true, netAmount: true, cardFeeAmount: true, appFeeAmount: true },
    }),
    prisma.manualRevenueEntry.findMany({
      where: { branchCode: input.branchCode, reportDate: { gte: rangeStart, lt: rangeEnd }, deletedAt: null },
      select: { reportDate: true, cardAmount: true, grabAmount: true },
    }),
    prisma.bankStatementAllocation.findMany({
      where: {
        revenueDate: { gte: rangeStart, lt: rangeEnd },
        decreaseMoneySourceCode: input.walletCode,
        grossAmount: { not: null },
        // Phần đã tách sang loại thu hộ không phải doanh thu ví, không "nhận" gross nào.
        // (so sánh "khác" trong SQL bỏ luôn dòng NULL, nên phải OR thêm nhánh null).
        OR: [{ operationType: null }, { operationType: { not: "OTHER_RECEIPT" } }],
        bankTransactionId: { not: input.excludeBankTransactionId },
        bankTransaction: { deletedAt: null, branchCode: input.branchCode },
      },
      select: { revenueDate: true, grossAmount: true },
    }),
  ]);

  const days = new Set(input.lines.map((line) => vietnamBusinessDayKey(line.revenueDate)));
  const revenueByDay = new Map<string, number>();
  const contestedDays = new Set<string>();
  let posFeeDeclared = 0;
  for (const day of days) {
    const dayPos = posRows.filter((row) => vietnamBusinessDayKey(row.saleDate) === day);
    if (dayPos.length > 0) {
      const amount = dayPos
        .filter((row) => matchPosSource(row.paymentMethod, row.revenueSource, row.channel)?.code === wallet.code)
        .reduce((sum, row) => sum + row.netAmount, 0);
      revenueByDay.set(day, Math.round(amount));
    } else {
      // Không có POS thì mới dùng số thu ngân khai (cùng luật selectWalletDeclaredRevenue).
      const declared = selectWalletDeclaredRevenue({
        posRows: [],
        manualRows: manualRows.filter((row) => vietnamBusinessDayKey(row.reportDate) === day),
        bucketSources: [{ code: wallet.code, name: wallet.name }],
        bucket,
        rivalSources: rivals,
      });
      if (declared.contested) contestedDays.add(day);
      revenueByDay.set(day, declared.amount);
    }
    posFeeDeclared += dayPos.reduce((sum, row) => sum + (row.cardFeeAmount || 0) + (row.appFeeAmount || 0), 0);
  }
  const claimedByDay = new Map<string, number>();
  for (const row of claimed) {
    if (!row.revenueDate) continue;
    const day = vietnamBusinessDayKey(row.revenueDate);
    claimedByDay.set(day, (claimedByDay.get(day) || 0) + (row.grossAmount || 0));
  }

  const result = planWalletGrossByDay({ lines: input.lines, revenueByDay, claimedByDay, contestedDays, walletLabel });
  // Phí đã khai bên file POS thì đã vào chi phí từ bút toán doanh thu — cùng chốt chặn với import.
  if (result.ok && result.plan.totalFee > 0 && posFeeDeclared > 0) {
    return {
      ok: false,
      reason: `Các ngày doanh thu này đã khai phí ${money(posFeeDeclared)} đ trên file doanh thu POS và phí đó đã vào chi phí; tính thêm phí ví là chi phí hai lần.`,
      walletLabel,
      isGrab: bucket === "GRAB",
      posFeeDeclared,
    };
  }
  return { ...result, walletLabel, isGrab: bucket === "GRAB", posFeeDeclared };
}
