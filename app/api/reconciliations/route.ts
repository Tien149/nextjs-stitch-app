import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { assertBranchAccess, branchFilterForSession } from "@/lib/accounting";
import { normalizeMoneySourceGroup } from "@/lib/money-sources";
import { dateKey, suggestRevenueDateFromDescription, vietnamBusinessDayBounds } from "@/lib/revenue-date";
import {
  remainingWalletGross,
  selectWalletDeclaredRevenue,
  walletRevenueBucket,
} from "@/lib/wallet-revenue-reconciliation";
import {
  allocateWalletSettlementGroup,
  WALLET_CARD_FEE_CATEGORY_CODE,
  WALLET_GRAB_EXPENSE_CATEGORY_CODE,
} from "@/lib/wallet-settlement-allocation";
import { generateFormattedVoucherCode } from "@/lib/voucher-code-generator";

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function toAmount(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function sameDay(a: Date, b: Date) {
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}

function scoreCandidate(
  amount: number,
  referenceDates: Date[],
  candidate: { date: Date; amount: number; partnerCode?: string | null },
  partnerHint: string | null,
) {
  let score = 0;
  if (Math.abs(amount - candidate.amount) < 1) score += 70;
  if (referenceDates.some((date) => sameDay(date, candidate.date))) score += 20;
  if (partnerHint && candidate.partnerCode && partnerHint === candidate.partnerCode) score += 10;
  return score;
}

async function buildWalletGroupPreview(bankTransactionId: string) {
  const target = await prisma.bankStatementTransaction.findUnique({
    where: { id: bankTransactionId },
    include: { allocations: { orderBy: { sourceRowNumber: "asc" } } },
  });
  if (!target || !target.branchCode) throw new Error("Không tìm thấy giao dịch Ví hoặc thiếu cửa hàng.");
  if (target.reconcileStatus !== "UNMATCHED") throw new Error("Giao dịch đã được quyết toán hoặc đối soát.");

  const revenueDates = [...new Map(target.allocations
    .filter((row) => row.revenueDate)
    .map((row) => [dateKey(row.revenueDate!), row.revenueDate!])).values()];
  if (revenueDates.length !== 1) throw new Error("Nhóm quyết toán phải có đúng một Ngày doanh thu.");
  const revenueDate = revenueDates[0];
  const { start, end } = vietnamBusinessDayBounds(revenueDate);

  const walletSources = (await prisma.masterDataItem.findMany({
    where: { type: "MONEY_SOURCE", status: "ACTIVE", deletedAt: null },
    select: { code: true, name: true, group: true },
  })).filter((source) => normalizeMoneySourceGroup(source.group) === "WALLET");
  const walletCodes = walletSources.map((source) => source.code);
  const candidates = await prisma.bankStatementTransaction.findMany({
    where: {
      branchCode: target.branchCode,
      reconcileStatus: "UNMATCHED",
      creditAmount: { gt: 0 },
      deletedAt: null,
      allocations: { some: { revenueDate: { gte: start, lt: end }, decreaseMoneySourceCode: { in: walletCodes } } },
    },
    include: { allocations: { orderBy: { sourceRowNumber: "asc" } } },
    orderBy: [{ transactionDate: "asc" }, { transactionCode: "asc" }],
  });
  const eligible = candidates.filter((bank) => {
    const dated = bank.allocations.filter((row) => row.creditAmount > 0 && row.revenueDate);
    return dated.length > 0
      && dated.every((row) => dateKey(row.revenueDate!) === dateKey(revenueDate))
      && dated.every((row) => walletCodes.includes(row.decreaseMoneySourceCode || ""));
  });
  if (!eligible.some((bank) => bank.id === target.id)) throw new Error("Giao dịch không còn thuộc nhóm Ví có thể quyết toán.");

  const [posRows, manualRows, allocatedRows, legacySettlementMatches, grabSettlements] = await Promise.all([
    prisma.revenueImportRow.findMany({
      where: { branchCode: target.branchCode, saleDate: { gte: start, lt: end }, deletedAt: null },
      select: { paymentMethod: true, revenueSource: true, channel: true, netAmount: true },
    }),
    prisma.manualRevenueEntry.findMany({
      where: { branchCode: target.branchCode, reportDate: { gte: start, lt: end }, deletedAt: null },
      select: { cardAmount: true, grabAmount: true },
    }),
    prisma.bankStatementAllocation.findMany({
      where: {
        revenueDate: { gte: start, lt: end },
        decreaseMoneySourceCode: { in: walletCodes },
        grossAmount: { not: null },
        bankTransaction: { branchCode: target.branchCode, reconcileStatus: { in: ["PENDING_REVIEW", "MATCHED"] }, deletedAt: null },
      },
      select: { grossAmount: true },
    }),
    prisma.reconciliationMatch.findMany({
      where: {
        targetType: "WALLET_SETTLEMENT",
        deletedAt: null,
        bankTransaction: {
          branchCode: target.branchCode,
          deletedAt: null,
          allocations: {
            some: { revenueDate: { gte: start, lt: end }, decreaseMoneySourceCode: { in: walletCodes }, grossAmount: null },
          },
        },
      },
      select: { targetId: true },
    }),
    prisma.moneyTransfer.findMany({
      where: {
        branchCode: target.branchCode,
        transferPurpose: "WALLET_SETTLEMENT",
        sourceReportDate: { gte: start, lt: end },
        status: { in: ["PENDING_REVIEW", "APPROVED"] },
        deletedAt: null,
      },
      select: { grabExpenseAmount: true },
    }),
  ]);
  const legacySettlements = legacySettlementMatches.length > 0
    ? await prisma.moneyTransfer.findMany({
        where: { id: { in: legacySettlementMatches.map((row) => row.targetId) }, status: { in: ["PENDING_REVIEW", "APPROVED"] }, deletedAt: null },
        select: { amount: true, feeAmount: true },
      })
    : [];
  const cardSources = walletSources.filter((source) => walletRevenueBucket(source) === "CARD_WALLET");
  const grabSources = walletSources.filter((source) => walletRevenueBucket(source) === "GRAB");
  const cardDeclared = selectWalletDeclaredRevenue({ posRows, manualRows, bucketSources: cardSources, bucket: "CARD_WALLET" });
  const grabDeclared = selectWalletDeclaredRevenue({ posRows, manualRows, bucketSources: grabSources, bucket: "GRAB" });
  const allocatedGross = allocatedRows.reduce((sum, row) => sum + (row.grossAmount || 0), 0)
    + legacySettlements.reduce((sum, row) => sum + row.amount + row.feeAmount, 0);
  const remainingGross = remainingWalletGross(cardDeclared.amount + grabDeclared.amount, allocatedGross);
  const remainingGrab = remainingWalletGross(
    grabDeclared.amount,
    grabSettlements.reduce((sum, row) => sum + row.grabExpenseAmount, 0),
  );
  const allocations = allocateWalletSettlementGroup({
    grossAmount: remainingGross,
    grabRevenueAmount: remainingGrab,
    transactions: eligible.map((bank) => ({ id: bank.id, netAmount: bank.creditAmount })),
  });
  const allocationById = new Map(allocations.map((row) => [row.id, row]));

  return {
    branchCode: target.branchCode,
    revenueDate,
    declaredGross: remainingGross,
    declaredGrab: remainingGrab,
    transactions: eligible.map((bank) => ({
      ...allocationById.get(bank.id)!,
      transactionCode: bank.transactionCode,
      transactionDate: bank.transactionDate,
      bankAccount: bank.bankAccount,
      allocations: bank.allocations,
    })),
  };
}

export async function GET(request: Request) {
  try {
    const auth = requireMenuAccess(request, "/reconciliations");
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const walletGroupFor = cleanText(searchParams.get("walletGroupFor"));
    if (walletGroupFor) {
      const preview = await buildWalletGroupPreview(walletGroupFor);
      assertBranchAccess(auth.session, preview.branchCode);
      return NextResponse.json(preview);
    }
    const status = searchParams.get("status") || "UNMATCHED";
    const batchId = cleanText(searchParams.get("batchId"));
    const search = cleanText(searchParams.get("q")).slice(0, 100);
    const page = Math.max(1, Number.parseInt(searchParams.get("page") || "1", 10) || 1);
    const pageSize = 50;
    const branchFilter = branchFilterForSession(auth.session, searchParams.get("branchCode") || "ALL");
    const bankWhere = {
      ...branchFilter,
      ...(batchId ? { importBatchId: batchId } : {}),
      ...(status === "ALL" ? {} : { reconcileStatus: status }),
      ...(search ? {
        OR: [
          { transactionCode: { contains: search, mode: "insensitive" as const } },
          { bankAccount: { contains: search, mode: "insensitive" as const } },
          { description: { contains: search, mode: "insensitive" as const } },
          { partnerHint: { contains: search, mode: "insensitive" as const } },
          { categoryCode: { contains: search, mode: "insensitive" as const } },
          { matches: { some: { targetCode: { contains: search, mode: "insensitive" as const }, deletedAt: null } } },
        ],
      } : {}),
    };

    const [bankRows, total, revenueRows, manualRevenueRows, deposits, vouchers, matches, moneySources] = await Promise.all([
      prisma.bankStatementTransaction.findMany({
        where: bankWhere,
        include: {
          matches: { where: { deletedAt: null }, orderBy: { createdAt: "desc" }, take: 1 },
          allocations: { orderBy: { sourceRowNumber: "asc" } },
        },
        orderBy: { transactionDate: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.bankStatementTransaction.count({ where: bankWhere }),
      prisma.revenueImportRow.findMany({ where: { ...branchFilter }, orderBy: { saleDate: "desc" }, take: 5000 }),
      prisma.manualRevenueEntry.findMany({
        where: { ...branchFilter, deletedAt: null },
        orderBy: { reportDate: "desc" },
        take: 2000,
      }),
      prisma.deposit.findMany({ where: { ...branchFilter }, orderBy: { receivedDate: "desc" }, take: 300 }),
      prisma.financialVoucher.findMany({
        where: { ...branchFilter, status: { in: ["DRAFT", "PENDING_REVIEW", "APPROVED", "POSTED"] }, deletedAt: null },
        orderBy: { voucherDate: "desc" },
        take: 500,
      }),
      prisma.reconciliationMatch.findMany({ orderBy: { createdAt: "desc" }, take: 100 }),
      prisma.masterDataItem.findMany({
        where: { type: "MONEY_SOURCE" },
        select: { code: true, name: true, group: true },
      }),
    ]);

    const moneySourceByCode = new Map(moneySources.map((source) => [source.code, source]));

    const rows = bankRows.map((bank) => {
      const bankAmount = bank.creditAmount || bank.debitAmount;
      const explicitRevenueDates = [...new Map(
        (bank.allocations.length > 0
          ? bank.allocations.map((allocation) => allocation.revenueDate)
          : [bank.revenueDate])
          .filter((value): value is Date => Boolean(value))
          .map((value) => [dateKey(value), value]),
      ).values()];
      const descriptions = bank.allocations.length > 0
        ? bank.allocations.map((allocation) => allocation.description)
        : [bank.description];
      const descriptionSuggestions = explicitRevenueDates.length > 0
        ? []
        : descriptions
            .map(suggestRevenueDateFromDescription)
            .filter((value): value is NonNullable<typeof value> => Boolean(value));
      const uniqueSuggestedDates = [...new Map(descriptionSuggestions.map((item) => [dateKey(item.date), item.date])).values()];
      const suggestedRevenueDate = uniqueSuggestedDates.length === 1 ? uniqueSuggestedDates[0] : null;
      const posReferenceDates = explicitRevenueDates.length > 0
        ? explicitRevenueDates
        : suggestedRevenueDate ? [suggestedRevenueDate] : [];
      const decreaseCodes = bank.allocations.length > 0
        ? bank.allocations.map((allocation) => allocation.decreaseMoneySourceCode)
        : [bank.decreaseMoneySourceCode];
      const walletSources = [...new Map(decreaseCodes.flatMap((code) => {
        const source = moneySourceByCode.get(code || "");
        return source && normalizeMoneySourceGroup(source.group) === "WALLET" ? [[source.code, source] as const] : [];
      })).values()];
      const isWalletSettlement = walletSources.length > 0;
      const hasCompleteWalletGross = bank.allocations.length > 0
        && bank.allocations.every((allocation) => allocation.grossAmount !== null);
      const walletGrossAmount = hasCompleteWalletGross
        ? bank.allocations.reduce((sum, allocation) => sum + (allocation.grossAmount || 0), 0)
        : 0;
      const expectedPosAmount = isWalletSettlement && walletGrossAmount > 0 ? walletGrossAmount : bankAmount;
      const posCandidates = revenueRows.map((row) => {
        const dateMatches = posReferenceDates.some((date) => sameDay(date, row.saleDate));
        const branchMatches = Boolean(bank.branchCode) && row.branchCode === bank.branchCode;
        const sourceMatches = !isWalletSettlement || walletSources.some((source) => {
          const declared = selectWalletDeclaredRevenue({
            posRows: [row],
            manualRows: [],
            bucketSources: [source],
            bucket: walletRevenueBucket(source),
          });
          return declared.amount > 0;
        });
        return {
          targetType: "REVENUE_POS",
          targetId: row.id,
          targetCode: row.externalRef,
          targetDate: row.saleDate,
          targetAmount: row.netAmount,
          label: `${row.branchCode} - ${row.channel || "POS"} - ${row.paymentMethod}`,
          score: scoreCandidate(expectedPosAmount, posReferenceDates, { date: row.saleDate, amount: row.netAmount }, bank.partnerHint)
            + (isWalletSettlement && sourceMatches ? 10 : 0),
          canMatch: !isWalletSettlement,
          dateSource: explicitRevenueDates.length > 0 ? "REVENUE_DATE" : suggestedRevenueDate ? "DESCRIPTION_SUGGESTION" : "MISSING",
          eligible: branchMatches && dateMatches && sourceMatches && (isWalletSettlement || Math.abs(row.netAmount - bankAmount) < 1),
        };
      });
      const manualCandidates = isWalletSettlement
        ? [...new Set(walletSources.map(walletRevenueBucket))].flatMap((bucket) => posReferenceDates.flatMap((referenceDate) => {
            const posRowsForDay = revenueRows.filter((row) => Boolean(bank.branchCode)
              && row.branchCode === bank.branchCode
              && sameDay(referenceDate, row.saleDate));
            const manualRowsForDay = manualRevenueRows.filter((row) => Boolean(bank.branchCode)
              && row.branchCode === bank.branchCode
              && sameDay(referenceDate, row.reportDate));
            const bucketSources = walletSources.filter((source) => walletRevenueBucket(source) === bucket);
            const declared = selectWalletDeclaredRevenue({
              posRows: posRowsForDay,
              manualRows: manualRowsForDay,
              bucketSources,
              bucket,
            });
            if (declared.source !== "MANUAL" || declared.amount <= 0) return [];
            return [{
              targetType: "MANUAL_REVENUE",
              targetId: manualRowsForDay.map((row) => row.id).join(","),
              targetCode: `NHAP_TAY_${dateKey(referenceDate)}_${bucket}`,
              targetDate: referenceDate,
              targetAmount: declared.amount,
              label: `${bank.branchCode} - Doanh thu nhập tay - ${bucket === "GRAB" ? "Grab" : "Quẹt thẻ/Ví"}`,
              score: 30 + (Math.abs(expectedPosAmount - declared.amount) < 1 ? 70 : 0),
              canMatch: false,
              dateSource: "MANUAL_REVENUE",
              eligible: true,
            }];
          }))
        : [];
      const candidates = [
        ...posCandidates,
        ...manualCandidates,
        ...deposits.map((row) => ({
          targetType: "DEPOSIT",
          targetId: row.id,
          targetCode: row.code,
          targetDate: row.receivedDate,
          targetAmount: row.amount,
          label: `${row.partnerName} - ${row.purpose}`,
          score: scoreCandidate(bankAmount, [bank.transactionDate], { date: row.receivedDate, amount: row.amount, partnerCode: row.partnerCode }, bank.partnerHint),
          canMatch: true,
          dateSource: "TRANSACTION_DATE",
          eligible: Math.abs(row.amount - bankAmount) < 1,
        })),
        ...vouchers.filter((row) => ["APPROVED", "POSTED"].includes(row.status)).map((row) => ({
          targetType: "VOUCHER",
          targetId: row.id,
          targetCode: row.code,
          targetDate: row.voucherDate,
          targetAmount: row.amount,
          label: `${row.partnerName} - ${row.description}`,
          score: scoreCandidate(bankAmount, [bank.transactionDate], { date: row.voucherDate, amount: row.amount, partnerCode: row.partnerCode }, bank.partnerHint),
          canMatch: true,
          dateSource: "TRANSACTION_DATE",
          eligible: Math.abs(row.amount - bankAmount) < 1,
        })),
      ]
        .filter((candidate) => candidate.eligible && candidate.score >= (["REVENUE_POS", "MANUAL_REVENUE"].includes(candidate.targetType) && isWalletSettlement ? 30 : 70))
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      const { matches: bankMatches, ...bankData } = bank;
      const currentMatch = bankMatches[0] || null;
      const matchedVoucher = currentMatch?.targetType === "VOUCHER"
        ? vouchers.find((voucher) => voucher.id === currentMatch.targetId)
        : null;
      const transferPeriod = bank.transactionDate.toISOString().slice(0, 7);
      const transferHref = `/finance-operations?period=${encodeURIComponent(transferPeriod)}&branchCode=${encodeURIComponent(bank.branchCode || "ALL")}&transfer=${encodeURIComponent(currentMatch?.targetCode || "")}`;
      return {
        ...bankData,
        revenueDates: explicitRevenueDates.map((value) => value.toISOString()),
        suggestedRevenueDate: suggestedRevenueDate?.toISOString() || null,
        revenueDateSource: explicitRevenueDates.length > 0 ? "COLUMN" : suggestedRevenueDate ? "DESCRIPTION" : "MISSING",
        isWalletSettlement,
        walletSourceCodes: walletSources.map((source) => source.code),
        walletGrossAmount: walletGrossAmount || null,
        currentMatch: currentMatch
          ? {
              ...currentMatch,
              targetHref: currentMatch.targetType === "VOUCHER"
                ? (matchedVoucher?.documentChannel === "BANK" ? "/bank-vouchers" : "/vouchers")
                : currentMatch.targetType === "REVENUE_POS"
                  ? "/imports?tab=revenue-pos"
                  : transferHref,
            }
          : null,
        candidates,
      };
    });

    return NextResponse.json({
      rows,
      matches,
      pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    });
  } catch (error) {
    console.error("Error fetching reconciliation data:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const auth = requireMenuAction(request, "/reconciliations", "edit");
    if (!auth.ok) return auth.response;

    const body = await request.json();
    if (cleanText(body.action) === "SETTLE_WALLET_GROUP") {
      const financeAuth = requireMenuAction(request, "/finance-operations", "create");
      if (!financeAuth.ok) return financeAuth.response;
      const preview = await buildWalletGroupPreview(cleanText(body.bankTransactionId));
      assertBranchAccess(auth.session, preview.branchCode);
      const categories = await prisma.masterDataItem.findMany({
        where: {
          type: "REVENUE_EXPENSE_CATEGORY",
          code: { in: [WALLET_CARD_FEE_CATEGORY_CODE, WALLET_GRAB_EXPENSE_CATEGORY_CODE] },
          group: "PAYMENT",
          status: "ACTIVE",
          deletedAt: null,
        },
        select: { code: true },
      });
      if (preview.transactions.some((row) => row.cardFeeAmount > 0) && !categories.some((row) => row.code === WALLET_CARD_FEE_CATEGORY_CODE)) {
        return NextResponse.json({ error: `Thiếu khoản mục ${WALLET_CARD_FEE_CATEGORY_CODE}` }, { status: 400 });
      }
      if (preview.transactions.some((row) => row.grabExpenseAmount > 0) && !categories.some((row) => row.code === WALLET_GRAB_EXPENSE_CATEGORY_CODE)) {
        return NextResponse.json({ error: `Thiếu khoản mục ${WALLET_GRAB_EXPENSE_CATEGORY_CODE}` }, { status: 400 });
      }

      const created = await prisma.$transaction(async (tx) => {
        const transferCount = await tx.moneyTransfer.count();
        const results = [];
        for (const [index, row] of preview.transactions.entries()) {
          const sourceCodes = [...new Set(row.allocations
            .filter((allocation) => allocation.creditAmount > 0)
            .map((allocation) => allocation.decreaseMoneySourceCode)
            .filter((value): value is string => Boolean(value)))];
          if (sourceCodes.length !== 1) throw new Error(`${row.transactionCode}: phải có đúng một nguồn Ví.`);
          const updated = await tx.bankStatementTransaction.updateMany({
            where: { id: row.id, reconcileStatus: "UNMATCHED", deletedAt: null },
            data: { reconcileStatus: "MATCHED", autoProcessType: "WALLET_SETTLEMENT", autoProcessNote: "Đã quyết toán theo nhóm Ngày doanh thu" },
          });
          if (updated.count !== 1) throw new Error(`${row.transactionCode}: trạng thái đã thay đổi, vui lòng tải lại.`);
          const transfer = await tx.moneyTransfer.create({
            data: {
              code: generateFormattedVoucherCode({ voucherType: "QTVI", voucherDate: row.transactionDate, branchCode: preview.branchCode, seqNumber: transferCount + index + 1 }),
              transferDate: row.transactionDate,
              branchCode: preview.branchCode,
              fromMoneySourceCode: sourceCodes[0],
              toMoneySourceCode: row.bankAccount,
              amount: row.netAmount,
              feeAmount: row.feeAmount,
              feeCategoryCode: row.cardFeeAmount > 0 ? WALLET_CARD_FEE_CATEGORY_CODE : null,
              grabExpenseAmount: row.grabExpenseAmount,
              grabExpenseCategoryCode: row.grabExpenseAmount > 0 ? WALLET_GRAB_EXPENSE_CATEGORY_CODE : null,
              externalRef: row.transactionCode,
              description: `Quyết toán nhóm Ví theo sao kê ${row.transactionCode}`,
              transferPurpose: "WALLET_SETTLEMENT",
              sourceReportDate: preview.revenueDate,
              status: "APPROVED",
              createdBy: auth.session.name,
              approvedBy: auth.session.name,
            },
          });
          const positiveAllocations = row.allocations.filter((allocation) => allocation.creditAmount > 0);
          const allocationPlan = allocateWalletSettlementGroup({
            grossAmount: row.grossAmount,
            grabRevenueAmount: 0,
            transactions: positiveAllocations.map((allocation) => ({ id: allocation.id, netAmount: allocation.creditAmount })),
          });
          for (const allocation of allocationPlan) {
            await tx.bankStatementAllocation.update({ where: { id: allocation.id }, data: { grossAmount: allocation.grossAmount } });
          }
          await tx.reconciliationMatch.create({
            data: {
              bankTransactionId: row.id,
              targetType: "WALLET_SETTLEMENT",
              targetId: transfer.id,
              targetCode: transfer.code,
              targetDate: preview.revenueDate,
              targetAmount: row.netAmount,
              matchedAmount: row.netAmount,
              note: "Quyết toán nhóm Ví, tự động tách chi phí Grab và phí cà thẻ",
              matchedBy: auth.session.name,
            },
          });
          results.push(transfer);
        }
        return results;
      }, { maxWait: 10_000, timeout: 120_000 });
      return NextResponse.json({
        transfers: created,
        grossAmount: preview.declaredGross,
        netAmount: preview.transactions.reduce((sum, row) => sum + row.netAmount, 0),
        grabExpenseAmount: preview.transactions.reduce((sum, row) => sum + row.grabExpenseAmount, 0),
        cardFeeAmount: preview.transactions.reduce((sum, row) => sum + row.cardFeeAmount, 0),
      }, { status: 201 });
    }
    const bankTransactionId = cleanText(body.bankTransactionId);
    const targetType = cleanText(body.targetType);
    const targetId = cleanText(body.targetId);
    const targetCode = cleanText(body.targetCode);
    const targetAmount = toAmount(body.targetAmount);

    if (!bankTransactionId || !targetType || !targetId || !targetCode || targetAmount <= 0) {
      return NextResponse.json({ error: "Thiếu thông tin đối soát" }, { status: 400 });
    }

    const bank = await prisma.bankStatementTransaction.findUnique({ where: { id: bankTransactionId } });
    if (!bank) return NextResponse.json({ error: "Không tìm thấy giao dịch sao kê" }, { status: 404 });
    if (bank.branchCode) {
      try {
        assertBranchAccess(auth.session, bank.branchCode);
      } catch (e) {
        return NextResponse.json({ error: e instanceof Error ? e.message : "Không có quyền chi nhánh" }, { status: 403 });
      }
    }
    if (bank.reconcileStatus === "MATCHED") {
      return NextResponse.json({ error: "Giao dịch này đã được đối soát" }, { status: 400 });
    }

    const matchedAmount = bank.creditAmount || bank.debitAmount;
    if (Math.abs(matchedAmount - targetAmount) >= 1) {
      return NextResponse.json({ error: "Số tiền sao kê và chứng từ không khớp" }, { status: 400 });
    }

    const match = await prisma.$transaction(async (tx) => {
      const created = await tx.reconciliationMatch.create({
        data: {
          bankTransactionId,
          targetType,
          targetId,
          targetCode,
          targetDate: body.targetDate ? new Date(String(body.targetDate)) : null,
          targetAmount,
          matchedAmount,
          note: cleanText(body.note) || null,
          matchedBy: auth.session.name,
        },
      });

      await tx.bankStatementTransaction.update({
        where: { id: bankTransactionId },
        data: { reconcileStatus: "MATCHED" },
      });

      return created;
    });

    return NextResponse.json(match, { status: 201 });
  } catch (error) {
    console.error("Error creating reconciliation match:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Internal Server Error" }, { status: 500 });
  }
}
