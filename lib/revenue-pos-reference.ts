import { createHash } from "node:crypto";

// Only business dimensions belong in the generated identity. Amounts are excluded so
// a corrected re-import still resolves to the same reference and is detected as a duplicate.
const referenceFields = [
  "sale_date",
  "branch_code",
  "channel",
  "revenue_source",
  "payment_method",
  "product_code",
  "warehouse_code",
] as const;

function canonicalValue(value: unknown) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  return String(value ?? "").trim().toUpperCase();
}

function compactCode(value: unknown, fallback: string) {
  const compact = canonicalValue(value).replace(/[^A-Z0-9]+/g, "").slice(0, 12);
  return compact || fallback;
}

function saleDateCode(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) return "UNKNOWNDATE";
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function generatedRevenuePosReference(values: Record<string, unknown>) {
  const fingerprint = referenceFields
    .map((field) => `${field}=${canonicalValue(values[field])}`)
    .join("|");
  const digest = createHash("sha256").update(fingerprint).digest("hex").slice(0, 16).toUpperCase();
  return `AUTO-POS-${compactCode(values.branch_code, "UNKNOWN")}-${saleDateCode(values.sale_date)}-${digest}`;
}

export function ensureRevenuePosReference(values: Record<string, unknown>) {
  const suppliedReference = String(values.external_ref ?? "").trim();
  const reference = suppliedReference || generatedRevenuePosReference(values);
  values.external_ref = reference;
  return reference;
}

export function revenuePosReferenceKey(values: Record<string, unknown>) {
  const saleDate = values.sale_date instanceof Date
    ? values.sale_date.toISOString()
    : canonicalValue(values.sale_date);
  return [
    canonicalValue(values.branch_code),
    saleDate,
    canonicalValue(values.external_ref),
  ].join("|");
}
