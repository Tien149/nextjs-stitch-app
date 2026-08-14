import type { RawTxClient, TxClient } from "@/lib/prisma";

const ASSET_CODE_PATTERN = /^[A-Z0-9_-]+$/;
const DEFAULT_FIXED_ASSET_PREFIX = "TSCD";
const DEFAULT_TOOL_PREFIX = "CCDC";
const MAX_SEQUENCE = 9999;

export class AssetCodeError extends Error {}

export function normalizeAssetCode(value: unknown) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

export function validateManualAssetCode(value: unknown) {
  const code = normalizeAssetCode(value);
  if (!code) throw new AssetCodeError("Mã tài sản/CCDC không được để trống.");
  if (code.length > 50) throw new AssetCodeError("Mã tài sản/CCDC không được vượt quá 50 ký tự.");
  if (!ASSET_CODE_PATTERN.test(code)) {
    throw new AssetCodeError("Mã tài sản/CCDC chỉ được gồm chữ, số, dấu gạch ngang (-) và gạch dưới (_).");
  }
  return code;
}

function compactPrefix(value: string | null | undefined) {
  return normalizeAssetCode(value).replace(/[-_]/g, "");
}

function requirePrefix(value: string | null | undefined, length: number, label: string) {
  const prefix = compactPrefix(value);
  if (!new RegExp(`^[A-Z0-9]{${length}}$`).test(prefix)) {
    throw new AssetCodeError(`${label} phải được cấu hình đúng ${length} ký tự chữ/số.`);
  }
  return prefix;
}

type AssetCodeTx = RawTxClient | TxClient;

export async function resolveAssetCodePrefix(tx: AssetCodeTx, assetGroupCode: string) {
  const client = tx as RawTxClient;
  const group = await client.masterDataItem.findFirst({
    where: { type: "ASSET_GROUP", code: assetGroupCode, status: "ACTIVE", deletedAt: null },
    select: { group: true, codePrefix: true },
  });
  const isTool = ["CCDC", "TOOL"].includes((group?.group || "").toUpperCase())
    || ["CCDC", "TOOL"].includes(assetGroupCode.toUpperCase());
  return requirePrefix(group?.codePrefix || (isTool ? DEFAULT_TOOL_PREFIX : DEFAULT_FIXED_ASSET_PREFIX), 4, "Tiền tố Nhóm tài sản/CCDC");
}

export async function resolveDepartmentCodePrefix(tx: AssetCodeTx, departmentCode: string) {
  const client = tx as RawTxClient;
  const department = await client.masterDataItem.findFirst({
    where: { type: "DEPARTMENT", code: departmentCode, status: "ACTIVE", deletedAt: null },
    select: { code: true, codePrefix: true },
  });
  if (!department) throw new AssetCodeError(`Phòng ban ${departmentCode || "(trống)"} không tồn tại hoặc đã ngưng hoạt động.`);
  return requirePrefix(department.codePrefix || department.code, 3, `Tiền tố Phòng ban ${department.code}`);
}

/**
 * Cấp mã theo prefix trong transaction. Advisory lock tuần tự hóa các request cùng prefix;
 * truy vấn raw bao gồm cả hồ sơ đã xóa mềm để mã lịch sử không bị tái sử dụng.
 */
export async function nextAssetCode(tx: AssetCodeTx, assetGroupCode: string, departmentCode: string) {
  const client = tx as RawTxClient;
  const [groupPrefix, departmentPrefix] = await Promise.all([
    resolveAssetCodePrefix(tx, assetGroupCode),
    resolveDepartmentCodePrefix(tx, departmentCode),
  ]);
  const prefix = `${groupPrefix}${departmentPrefix}`;
  const lockKey = `asset-code:${prefix}`;
  await client.$queryRaw<Array<{ locked: number }>>`
    SELECT 1::integer AS "locked"
    FROM (SELECT pg_advisory_xact_lock(hashtext(${lockKey}))) AS advisory_lock
  `;

  const existingCodes = await client.assetRecord.findMany({
    where: { code: { startsWith: prefix }, deletedAt: undefined },
    select: { code: true },
  });
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escapedPrefix}(\\d{4})$`);
  const currentMax = existingCodes.reduce((max, row) => {
    const match = pattern.exec(row.code.toUpperCase());
    const sequence = match ? Number(match[1]) : 0;
    return Number.isSafeInteger(sequence) ? Math.max(max, sequence) : max;
  }, 0);

  if (currentMax >= MAX_SEQUENCE) {
    throw new AssetCodeError(`Dải mã ${prefix}0001-${prefix}${MAX_SEQUENCE} đã hết.`);
  }
  return `${prefix}${String(currentMax + 1).padStart(4, "0")}`;
}

export async function assertAssetCodeAvailable(tx: AssetCodeTx, value: unknown, excludeId?: string) {
  const client = tx as RawTxClient;
  const code = validateManualAssetCode(value);
  const existing = await client.assetRecord.findFirst({
    where: { code, ...(excludeId ? { id: { not: excludeId } } : {}), deletedAt: undefined },
    select: { deletedAt: true },
  });
  if (existing) {
    throw new AssetCodeError(existing.deletedAt
      ? `Mã tài sản ${code} đang nằm trong Thùng rác. Hãy khôi phục hồ sơ cũ hoặc dùng mã khác.`
      : `Mã tài sản ${code} đã tồn tại.`);
  }
  return code;
}
