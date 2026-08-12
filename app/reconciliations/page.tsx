"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { appMenuItems, canAccessMenu, canPerformAction, canPerformMenuAction, type DemoSession, SESSION_KEY } from "@/lib/auth-demo";
import { filterMoneySources, moneySourceDebugLabel, moneySourceDisplayName, type MoneySourceOption } from "@/lib/money-sources";
import StickyFilterBar from "@/components/StickyFilterBar";
import { visibleStoreOptions } from "@/lib/branch-labels";
import { normalizeCashflowCategoryType } from "@/lib/voucher-rules";

type Candidate = {
  targetType: string;
  targetId: string;
  targetCode: string;
  targetDate: string;
  targetAmount: number;
  label: string;
  score: number;
  canMatch: boolean;
  dateSource: string;
};

type BankRow = {
  id: string;
  transactionDate: string;
  bankAccount: string;
  transactionCode: string;
  description: string;
  debitAmount: number;
  creditAmount: number;
  partnerHint: string | null;
  categoryCode: string | null;
  autoProcessType: string | null;
  autoProcessNote: string | null;
  branchCode: string | null;
  reconcileStatus: string;
  revenueDates: string[];
  suggestedRevenueDate: string | null;
  revenueDateSource: "COLUMN" | "DESCRIPTION" | "MISSING";
  isWalletSettlement: boolean;
  walletSourceCodes: string[];
  walletGrossAmount: number | null;
  currentMatch: MatchRow | null;
  candidates: Candidate[];
};

type SettlementForm = {
  bankRow: BankRow;
  branchCode: string;
  fromMoneySourceCode: string;
  grossAmount: string;
  feeCategoryCode: string;
  sourceReportDate: string;
  revenueDateInferred: boolean;
};

type MatchRow = {
  id: string;
  targetType: string;
  targetCode: string;
  matchedAmount: number;
  matchedBy: string | null;
  createdAt: string;
  targetHref?: string;
};

export default function ReconciliationsPage() {
  const router = useRouter();
  const [user, setUser] = useState<DemoSession | null>(null);
  const [rows, setRows] = useState<BankRow[]>([]);
  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [status, setStatus] = useState("UNMATCHED");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [moneySources, setMoneySources] = useState<MoneySourceOption[]>([]);
  const [feeCategories, setFeeCategories] = useState<Array<{ code: string; name: string; group: string | null }>>([]);
  const [settlement, setSettlement] = useState<SettlementForm | null>(null);
  const [settlementSaving, setSettlementSaving] = useState(false);
  const [settlementError, setSettlementError] = useState("");

  useEffect(() => {
    const raw = localStorage.getItem(SESSION_KEY);
    const menu = appMenuItems.find((item) => item.href === "/reconciliations");
    if (!raw) {
      router.push("/login?next=/reconciliations");
      return;
    }
    const session = JSON.parse(raw) as DemoSession;
    if (!menu || !canAccessMenu(session.role, menu)) {
      router.push("/");
      return;
    }
    window.setTimeout(() => {
      setUser(session);
      setLoading(false);
    }, 0);
  }, [router]);

  const canMatch = user ? canPerformAction(user, "edit") : false;
  /** Lập phiếu quyết toán là nghiệp vụ của Sổ quỹ nên xét quyền theo module đó. */
  const canSettleWallet = user ? canPerformMenuAction(user, "/finance-operations", "create") : false;
  const money = (value: number) => new Intl.NumberFormat("vi-VN").format(value);
  const settlementFee = settlement
    ? Math.max(0, Number(settlement.grossAmount || 0)) - settlement.bankRow.creditAmount
    : 0;

  const loadRows = async () => {
    const response = await fetch(`/api/reconciliations?status=${status}`);
    if (response.ok) {
      const payload = await response.json();
      setRows(payload.rows as BankRow[]);
      setMatches(payload.matches as MatchRow[]);
    }
  };

  useEffect(() => {
    if (!loading) {
      window.setTimeout(() => {
        void loadRows();
      }, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, status]);

  // Danh mục cho form quyết toán ví; chỉ tải một lần khi vào trang.
  useEffect(() => {
    if (loading) return;
    void fetch("/api/master-data?type=MONEY_SOURCE&status=ACTIVE")
      .then((res) => (res.ok ? res.json() : []))
      .then((items: MoneySourceOption[]) => setMoneySources(items))
      .catch(() => setMoneySources([]));
    void fetch("/api/master-data?type=REVENUE_EXPENSE_CATEGORY&status=ACTIVE")
      .then((res) => (res.ok ? res.json() : []))
      .then((items: Array<{ code: string; name: string; group: string | null }>) =>
        setFeeCategories(items.filter((item) => normalizeCashflowCategoryType(item.group) === "PAYMENT")))
      .catch(() => setFeeCategories([]));
  }, [loading]);

  /**
   * Mở form quyết toán từ chính dòng sao kê: số thực nhận và tài khoản nhận lấy sẵn
   * từ dòng đó, kế toán chỉ còn chọn ví và nhập số gốc đang treo ở ví.
   */
  const openSettlement = (bankRow: BankRow) => {
    setSettlementError("");
    setSettlement({
      bankRow,
      branchCode: bankRow.branchCode || "",
      fromMoneySourceCode: bankRow.walletSourceCodes.length === 1 ? bankRow.walletSourceCodes[0] : "",
      grossAmount: String(Math.round(bankRow.walletGrossAmount || bankRow.creditAmount)),
      feeCategoryCode: "",
      sourceReportDate: bankRow.revenueDates.length === 1
        ? bankRow.revenueDates[0].slice(0, 10)
        : bankRow.suggestedRevenueDate?.slice(0, 10) || "",
      revenueDateInferred: bankRow.revenueDateSource === "DESCRIPTION",
    });
  };

  const submitSettlement = async () => {
    if (!settlement || settlementSaving) return;
    setSettlementSaving(true);
    setSettlementError("");
    try {
      if (!settlement.sourceReportDate) {
        setSettlementError("Vui lòng xác nhận Ngày doanh thu trước khi tạo quyết toán ví.");
        return;
      }
      const response = await fetch("/api/finance-operations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "CREATE_WALLET_SETTLEMENT",
          transferDate: settlement.bankRow.transactionDate,
          sourceReportDate: settlement.sourceReportDate,
          branchCode: settlement.branchCode,
          fromMoneySourceCode: settlement.fromMoneySourceCode,
          toMoneySourceCode: settlement.bankRow.bankAccount,
          grossAmount: Number(settlement.grossAmount || 0),
          amount: settlement.bankRow.creditAmount,
          feeCategoryCode: settlement.feeCategoryCode,
          externalRef: settlement.bankRow.transactionCode,
          description: `Quyết toán ví theo sao kê ${settlement.bankRow.transactionCode}`,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setSettlementError(payload.error || "Không tạo được phiếu quyết toán.");
        return;
      }
      // Đánh dấu luôn dòng sao kê là đã đối soát, nếu không ngày mai nó lại hiện ra như chưa xử lý.
      let matchNote = "";
      if (canMatch && settlement.bankRow.reconcileStatus !== "MATCHED") {
        const matchResponse = await fetch("/api/reconciliations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bankTransactionId: settlement.bankRow.id,
            targetType: "WALLET_SETTLEMENT",
            targetId: payload.id,
            targetCode: payload.code,
            targetDate: settlement.sourceReportDate,
            targetAmount: settlement.bankRow.creditAmount,
            note: `Quyết toán ví ${settlement.fromMoneySourceCode}`,
          }),
        });
        if (!matchResponse.ok) matchNote = " (chưa đánh dấu đối soát được, hãy match thủ công)";
      }
      setMessage(`Đã tạo phiếu quyết toán ${payload.code}: cộng ${money(settlement.bankRow.creditAmount)} đ vào ngân hàng, trừ ${money(Number(settlement.grossAmount || 0))} đ ở ví, phí ${money(settlementFee)} đ vào chi phí.${matchNote}`);
      setSettlement(null);
      await loadRows();
    } catch {
      setSettlementError("Lỗi kết nối máy chủ.");
    } finally {
      setSettlementSaving(false);
    }
  };

  const matchCandidate = async (bank: BankRow, candidate: Candidate) => {
    setMessage("");
    const response = await fetch("/api/reconciliations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bankTransactionId: bank.id,
        targetType: candidate.targetType,
        targetId: candidate.targetId,
        targetCode: candidate.targetCode,
        targetDate: candidate.targetDate,
        targetAmount: candidate.targetAmount,
        note: `Auto suggested score ${candidate.score}`,
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      setMessage(payload.error || "Không đối soát được giao dịch");
      return;
    }
    setMessage("Đã đối soát giao dịch.");
    await loadRows();
  };

  if (loading) return <div className="h-screen grid place-items-center bg-slate-100">Đang tải...</div>;

  return (
    <div className="min-h-screen bg-slate-100 text-slate-800">
      <header className="sticky top-0 z-20 bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-xl font-bold">Đối soát Sao kê</h1>
            <p className="text-xs text-slate-500">GĐ2: match sao kê với doanh thu POS, tiền cọc và phiếu thu/chi.</p>
          </div>
        </div>
        <p className="text-xs font-bold text-slate-500">{user?.role}</p>
      </header>

      <main className="max-w-7xl mx-auto p-6 space-y-6">
        <StickyFilterBar className="!-mx-6 !px-6 !mb-0">
        <section className="grid md:grid-cols-3 gap-4">
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
            <p className="text-xs text-slate-500">Giao dịch đang xem</p>
            <p className="text-2xl font-bold">{rows.length}</p>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
            <p className="text-xs text-slate-500">Match gần đây</p>
            <p className="text-2xl font-bold text-emerald-700">{matches.length}</p>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
            <p className="text-xs text-slate-500">Quyền thao tác</p>
            <p className="text-2xl font-bold">{canMatch ? "Có" : "Chỉ xem"}</p>
          </div>
        </section>
        </StickyFilterBar>

        <section className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          <div className="p-5 border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div>
              <h2 className="font-bold">Danh sách sao kê cần đối soát</h2>
              <p className="text-xs text-slate-500 mt-1">Gợi ý dựa trên số tiền, ngày giao dịch và mã đối tác nếu có.</p>
            </div>
            <div className="flex items-center gap-2">
              <select value={status} onChange={(event) => setStatus(event.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 outline-none">
                <option value="UNMATCHED">Chưa match</option>
                <option value="PENDING_REVIEW">Chờ duyệt</option>
                <option value="MATCHED">Đã match</option>
                <option value="ALL">Tất cả</option>
              </select>
              <button onClick={loadRows} className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-bold hover:bg-slate-50">Tải lại</button>
            </div>
          </div>
          {message && <div className="mx-5 mt-4 rounded-lg bg-blue-50 border border-blue-100 text-blue-700 px-3 py-2 text-sm">{message}</div>}
          
          <div className="overflow-x-auto">
            <Table
              headers={[
                { label: "Sao kê" },
                { label: "Loại thu/chi" },
                { label: "Số tiền", align: "right" },
                { label: "Gợi ý match" },
                { label: "Thao tác", align: "right" },
              ]}
            >
              {rows.length === 0 ? (
                <tr><td colSpan={5} className="px-4 py-10 text-center text-slate-400">Không có giao dịch.</td></tr>
              ) : rows.map((row) => {
                const first = row.candidates[0];
                return (
                  <tr key={row.id} className="hover:bg-slate-50 align-top border-t border-slate-100">
                    <td className="px-4 py-3">
                      <b>{row.transactionCode}</b>
                      <p className="text-xs text-slate-500">Ngày GD: {new Date(row.transactionDate).toLocaleDateString("vi-VN")} · {row.bankAccount}</p>
                      {row.revenueDates.length > 0 ? (
                        <p className="mt-0.5 text-xs font-semibold text-emerald-700">
                          Ngày DT: {row.revenueDates.map((value) => new Date(value).toLocaleDateString("vi-VN", { timeZone: "UTC" })).join(", ")}
                        </p>
                      ) : row.suggestedRevenueDate ? (
                        <p className="mt-0.5 text-xs font-semibold text-amber-700">
                          Ngày DT gợi ý từ diễn giải: {new Date(row.suggestedRevenueDate).toLocaleDateString("vi-VN", { timeZone: "UTC" })} · cần xác nhận
                        </p>
                      ) : (
                        <p className="mt-0.5 text-xs font-semibold text-rose-700">Thiếu Ngày doanh thu</p>
                      )}
                      <p className="text-xs text-slate-500 mt-1 max-w-md">{row.description}</p>
                      {row.autoProcessNote && <p className="mt-1 text-xs font-semibold text-indigo-700">{row.autoProcessNote}</p>}
                    </td>
                    <td className="px-4 py-3">
                      {row.categoryCode ? (
                        <span className={`inline-block rounded px-2 py-0.5 text-xs font-bold ${row.creditAmount > 0 ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}>
                          {row.categoryCode}
                        </span>
                      ) : (
                        <span className="text-xs text-slate-400">Chưa phân loại</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-bold text-slate-900">{money(row.creditAmount || row.debitAmount)} đ</td>
                    <td className="px-4 py-3">
                      {first ? (
                        <div>
                          <p className="font-bold">{first.targetCode} · {first.targetType}</p>
                          <p className="text-xs text-slate-500">{first.label}</p>
                          <p className="text-xs text-emerald-700 mt-1">Score {first.score} · {money(first.targetAmount)} đ</p>
                          {!first.canMatch && <p className="mt-1 text-xs font-semibold text-indigo-700">Tham chiếu POS để quyết toán gross/phí</p>}
                        </div>
                      ) : (
                        <span className="text-xs text-amber-700">Chưa có gợi ý đủ khớp</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex flex-col items-end gap-1.5">
                        {canMatch && first?.canMatch && row.reconcileStatus === "UNMATCHED" ? (
                          <button onClick={() => matchCandidate(row, first)} className="text-xs font-bold text-blue-700 hover:underline">Match</button>
                        ) : (
                          <span className="text-xs text-slate-400 font-semibold">{row.reconcileStatus}</span>
                        )}
                        {row.currentMatch && (
                          <a
                            href={row.currentMatch.targetHref || (row.currentMatch.targetType === "VOUCHER" ? "/vouchers" : "/finance-operations")}
                            className="text-xs font-bold text-indigo-700 hover:underline"
                          >
                            Mở phiếu {row.currentMatch.targetCode}
                          </a>
                        )}
                        {/* Tiền vào từ cổng thanh toán: lập luôn phiếu quyết toán ví với số đã điền sẵn. */}
                        {canSettleWallet && row.isWalletSettlement && row.creditAmount > 0 && row.reconcileStatus === "UNMATCHED" && row.revenueDates.length <= 1 && (
                          <button
                            type="button"
                            onClick={() => openSettlement(row)}
                            className="rounded-lg border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-xs font-bold text-indigo-700 hover:bg-indigo-100"
                          >
                            Quyết toán ví
                          </button>
                        )}
                        {row.revenueDates.length > 1 && row.reconcileStatus === "UNMATCHED" && (
                          <span className="max-w-32 text-xs font-semibold text-amber-700">Nhiều ngày DT: xử lý theo allocation</span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </Table>
          </div>
        </section>
      </main>

      {settlement && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/45 p-4">
          <div className="flex max-h-[88vh] w-full max-w-lg flex-col overflow-hidden rounded-lg bg-white shadow-2xl">
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-200 p-5">
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-indigo-600">Quyết toán ví về ngân hàng</p>
                <h2 className="mt-1 text-xl font-bold text-slate-900">{money(settlement.bankRow.creditAmount)} đ</h2>
                <p className="mt-1 text-xs text-slate-500">
                  {settlement.bankRow.transactionCode} · {new Date(settlement.bankRow.transactionDate).toLocaleDateString("vi-VN")} · về {settlement.bankRow.bankAccount}
                </p>
              </div>
              <button type="button" className="rounded-lg border border-slate-200 px-2 py-1 text-sm font-bold text-slate-500 hover:bg-slate-50" onClick={() => setSettlement(null)}>
                Đóng
              </button>
            </div>

            <div className="space-y-4 overflow-y-auto p-5">
              <p className="rounded-lg border border-indigo-100 bg-indigo-50 px-3 py-2 text-xs text-indigo-800">
                Số thực nhận và tài khoản nhận lấy sẵn từ dòng sao kê. Nhập số gốc đang treo ở ví, phần chênh lệch
                sẽ thành chi phí quẹt thẻ trên P&amp;L.
              </p>

              <label className="block text-xs font-bold text-slate-600">
                Ngày doanh thu
                <input
                  className="control"
                  type="date"
                  value={settlement.sourceReportDate}
                  onChange={(event) => setSettlement({ ...settlement, sourceReportDate: event.target.value, revenueDateInferred: false })}
                />
                <span className={`mt-1 block text-[11px] font-medium ${settlement.revenueDateInferred ? "text-amber-700" : "text-slate-500"}`}>
                  {settlement.revenueDateInferred
                    ? "Ngày này được gợi ý từ diễn giải. Hãy kiểm tra trước khi tạo phiếu."
                    : "Dùng để liên kết quyết toán với ngày bán hàng POS; không thay đổi Ngày giao dịch ngân hàng."}
                </span>
              </label>

              <label className="block text-xs font-bold text-slate-600">
                Cửa hàng
                <select
                  className="control"
                  value={settlement.branchCode}
                  onChange={(event) => setSettlement({ ...settlement, branchCode: event.target.value, fromMoneySourceCode: "" })}
                >
                  <option value="">-- Chọn cửa hàng --</option>
                  {visibleStoreOptions(user).map((option) => (
                    <option key={option.code} value={option.code}>{option.label}</option>
                  ))}
                </select>
              </label>

              <label className="block text-xs font-bold text-slate-600">
                Nguồn ví / POS
                <select
                  className="control"
                  value={settlement.fromMoneySourceCode}
                  onChange={(event) => setSettlement({ ...settlement, fromMoneySourceCode: event.target.value })}
                >
                  <option value="">-- Chọn ví --</option>
                  {filterMoneySources(moneySources, settlement.branchCode, ["WALLET"]).map((source) => (
                    <option key={source.code} value={source.code} title={moneySourceDebugLabel(source)}>{moneySourceDisplayName(source)}</option>
                  ))}
                </select>
              </label>

              <label className="block text-xs font-bold text-slate-600">
                Số gốc đang treo ở ví
                <input
                  className="control text-right"
                  inputMode="numeric"
                  value={settlement.grossAmount}
                  onChange={(event) => setSettlement({ ...settlement, grossAmount: event.target.value.replace(/\D/g, "") })}
                />
                <span className="mt-1 block text-[11px] font-medium text-slate-500">
                  Bằng số thực nhận nghĩa là không có phí.
                </span>
              </label>

              <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
                <span className="text-sm font-bold text-slate-700">Phí quẹt thẻ</span>
                <span className={`text-lg font-bold ${settlementFee < 0 ? "text-rose-600" : "text-slate-900"}`}>{money(settlementFee)} đ</span>
              </div>

              {settlementFee > 0 && (
                <label className="block text-xs font-bold text-slate-600">
                  Khoản mục phí (lên P&amp;L)
                  <select
                    className="control"
                    value={settlement.feeCategoryCode}
                    onChange={(event) => setSettlement({ ...settlement, feeCategoryCode: event.target.value })}
                  >
                    <option value="">{feeCategories.length === 0 ? "-- Chưa khai báo khoản mục chi phí --" : "-- Chọn khoản mục phí --"}</option>
                    {feeCategories.map((category) => (
                      <option key={category.code} value={category.code}>{category.name}</option>
                    ))}
                  </select>
                </label>
              )}

              {settlementFee < 0 && (
                <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
                  Số gốc ở ví không được nhỏ hơn số thực nhận về ngân hàng.
                </p>
              )}
              {settlementError && (
                <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">{settlementError}</p>
              )}
            </div>

            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-200 p-5">
              <button type="button" className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50" onClick={() => setSettlement(null)}>
                Huỷ bỏ
              </button>
              <button
                type="button"
                onClick={() => void submitSettlement()}
                disabled={settlementSaving || settlementFee < 0 || !settlement.branchCode || !settlement.fromMoneySourceCode || (settlementFee > 0 && !settlement.feeCategoryCode)}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {settlementSaving ? "Đang ghi..." : "Ghi nhận quyết toán"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Table({ headers, children }: { headers: { label: string; align?: "left" | "right" }[]; children: React.ReactNode }) {
  return (
    <table className="w-full text-left text-sm">
      <thead className="bg-slate-50 text-slate-500 text-xs uppercase border-b border-slate-200">
        <tr>
          {headers.map((header, i) => (
            <th
              key={i}
              className={`px-4 py-3 font-bold ${header.align === "right" ? "text-right" : "text-left"}`}
            >
              {header.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}
