import { prisma } from "@/lib/prisma";

export function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function toNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function toDate(value: unknown, fallback = new Date()) {
  if (!value) return fallback;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

export function periodFromDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function normalizePeriod(value: unknown) {
  const period = cleanText(value);
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(period) ? period : "";
}

export function addPeriod(startPeriod: string, offset: number) {
  const [year, month] = startPeriod.split("-").map(Number);
  const date = new Date(year, month - 1 + offset, 1);
  return periodFromDate(date);
}

export async function isPeriodLocked(date: Date, branchCode: string) {
  const period = periodFromDate(date);
  const [branchPeriod, allBranchPeriod] = await Promise.all([
    prisma.accountingPeriod.findUnique({
      where: { period_branchCode: { period, branchCode } },
    }),
    prisma.accountingPeriod.findUnique({
      where: { period_branchCode: { period, branchCode: "ALL" } },
    }),
  ]);
  return branchPeriod?.status === "CLOSED" || allBranchPeriod?.status === "CLOSED";
}

export function apiError(error: unknown, fallback = "Internal Server Error") {
  console.error(error);
  const message = error instanceof Error && error.message.startsWith("BUSINESS:")
    ? error.message.slice("BUSINESS:".length)
    : fallback;
  return { message, status: message === fallback ? 500 : 400 };
}

export function businessError(message: string): never {
  throw new Error(`BUSINESS:${message}`);
}
