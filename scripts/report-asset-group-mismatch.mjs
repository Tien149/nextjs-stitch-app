/**
 * Rà hồ sơ Tài sản/CCDC đang mang Nhóm tài sản KHÔNG khớp danh mục, và mã lệch tiền tố nhóm.
 *
 * Hai nguồn sai đã vá ở mã nguồn nhưng dữ liệu cũ vẫn còn:
 *  - Nhận hàng từ PO trước đây gán cứng "CCDC"/"ASSET" làm mã nhóm — hai mã không có trong
 *    danh mục Nhóm tài sản, nên hồ sơ mang nhóm rác (lib/asset-group-rules.ts).
 *  - Luật tiền tố cũ so khớp nguyên văn nên nhóm đặt mã theo họ (CCDC_BAR) rơi về TSCD —
 *    dụng cụ khu vực bar bị cấp mã TSCDBAR0001 (lib/asset-code-generator.ts).
 *
 * Chỉ ĐỌC dữ liệu, không sửa gì. In ra màn hình và ghi file Excel trong outputs/.
 *
 * Chạy: npm run report:asset-groups
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { defaultAssetCodePrefix } from "../lib/asset-code-generator.ts";
import { assetGroupCandidates } from "../lib/asset-group-rules.ts";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");
const { PrismaClient } = require("@prisma/custom-client");
const prisma = new PrismaClient();

/** Mã do hệ thống cấp: 4 ký tự nhóm + 3 ký tự phòng ban + 4 số. Mã khai tay thì không xét lệch. */
const GENERATED_CODE = /^([A-Z0-9]{4})[A-Z0-9]{3}\d{4}$/;

/** Tiền tố mà nhóm này lẽ ra phải cấp — đúng luật đang chạy. */
function prefixOfGroup(group) {
  return (group.codePrefix || defaultAssetCodePrefix(group.code, group.group)).replace(/[-_]/g, "").toUpperCase();
}

/**
 * Nhóm nên gán cho hồ sơ đang mang nhóm rác: suy loại mặt hàng từ tiền tố mã đã cấp
 * (CCDC -> công cụ dụng cụ, còn lại -> tài sản cố định) rồi lấy các nhóm cùng phân loại.
 */
function suggestGroups(code, assetGroupCode, catalog) {
  const prefix = GENERATED_CODE.exec(code.toUpperCase())?.[1]
    || defaultAssetCodePrefix(assetGroupCode, "");
  const itemType = prefix === "CCDC" ? "TOOL" : "ASSET";
  return assetGroupCandidates(itemType, catalog);
}

async function main() {
  const [assets, groups] = await Promise.all([
    prisma.assetRecord.findMany({
      where: { deletedAt: null },
      select: {
        id: true, code: true, name: true, assetGroup: true, branchCode: true, departmentCode: true,
        status: true, purchaseDate: true, originalCost: true, sourcePurchaseOrderId: true, sourceReceiptId: true,
      },
      orderBy: { code: "asc" },
    }),
    prisma.masterDataItem.findMany({
      where: { type: "ASSET_GROUP", deletedAt: null },
      select: { code: true, name: true, group: true, codePrefix: true, status: true },
      orderBy: { code: "asc" },
    }),
  ]);
  const activeGroups = groups.filter((group) => group.status === "ACTIVE");
  const groupByCode = new Map(groups.map((group) => [group.code.trim().toUpperCase(), group]));

  // Mã đã phát sinh chứng từ thì KHOÁ không đổi được (app/api/assets PATCH), chỉ sửa được nhóm.
  const assetIds = assets.map((asset) => asset.id);
  const [depreciations, debts] = await Promise.all([
    prisma.assetDepreciation.groupBy({ by: ["assetId"], where: { assetId: { in: assetIds } }, _count: { _all: true } }),
    prisma.debtRecord.groupBy({ by: ["sourceId"], where: { sourceType: "ASSET", sourceId: { in: assetIds }, deletedAt: null }, _count: { _all: true } }),
  ]);
  const hasDepreciation = new Set(depreciations.map((row) => row.assetId));
  const hasDebt = new Set(debts.map((row) => row.sourceId));

  const findings = [];
  for (const asset of assets) {
    const code = asset.code.trim().toUpperCase();
    const groupCode = (asset.assetGroup || "").trim().toUpperCase();
    const group = groupByCode.get(groupCode);
    const codeLocked = hasDepreciation.has(asset.id) || hasDebt.has(asset.id)
      || Boolean(asset.sourcePurchaseOrderId || asset.sourceReceiptId);

    let issue = "";
    let detail = "";
    if (!groupCode) {
      issue = "Chưa gán nhóm";
      detail = "Hồ sơ không có Nhóm tài sản.";
    } else if (!group) {
      issue = "Nhóm không có trong danh mục";
      detail = `Mã nhóm "${groupCode}" không tồn tại trong danh mục Nhóm tài sản.`;
    } else if (group.status !== "ACTIVE") {
      issue = "Nhóm đã ngưng hoạt động";
      detail = `Nhóm ${group.code} - ${group.name} đang ở trạng thái ${group.status}.`;
    } else {
      const generated = GENERATED_CODE.exec(code);
      const expected = prefixOfGroup(group);
      if (generated && generated[1] !== expected) {
        issue = "Mã lệch tiền tố nhóm";
        detail = `Mã mang tiền tố ${generated[1]} trong khi nhóm ${group.code} cấp tiền tố ${expected}.`;
      }
    }
    if (!issue) continue;

    const suggestions = issue === "Mã lệch tiền tố nhóm"
      ? []
      : suggestGroups(code, groupCode, activeGroups);
    findings.push({ asset, issue, detail, codeLocked, suggestions });
  }

  console.log(`Tổng hồ sơ Tài sản/CCDC: ${assets.length} · Nhóm tài sản trong danh mục: ${groups.length} (${activeGroups.length} đang hoạt động)`);
  if (findings.length === 0) {
    console.log("Không có hồ sơ nào lệch nhóm hoặc lệch tiền tố mã.");
    return;
  }

  const byIssue = new Map();
  for (const finding of findings) byIssue.set(finding.issue, [...(byIssue.get(finding.issue) || []), finding]);
  console.log(`Cần xem lại: ${findings.length} hồ sơ`);
  console.log();
  for (const [issue, rows] of byIssue) {
    console.log(`### ${issue} — ${rows.length} hồ sơ`);
    for (const { asset, detail, codeLocked, suggestions } of rows) {
      console.log(`  ${asset.code.padEnd(16)} ${asset.name.slice(0, 34).padEnd(36)} ${detail}`);
      if (suggestions.length > 0) {
        console.log(`  ${" ".repeat(16)} → gán lại nhóm: ${suggestions.map((group) => group.code).join(", ")}`);
      }
      if (codeLocked) {
        console.log(`  ${" ".repeat(16)} → mã đã phát sinh chứng từ nên KHOÁ, chỉ sửa được Nhóm tài sản.`);
      }
    }
    console.log();
  }

  const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "outputs");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const outFile = path.join(outDir, `tai_san_lech_nhom_${stamp}.xlsx`);
  const sheet = XLSX.utils.json_to_sheet(findings.map(({ asset, issue, detail, codeLocked, suggestions }) => ({
    "Vấn đề": issue,
    "Mã tài sản": asset.code,
    "Tên tài sản": asset.name,
    "Nhóm đang mang": asset.assetGroup || "",
    "Chi tiết": detail,
    "Nhóm nên gán": suggestions.map((group) => `${group.code} - ${group.name}`).join(" | "),
    "Cửa hàng": asset.branchCode || "",
    "Phòng ban": asset.departmentCode || "",
    "Ngày mua": asset.purchaseDate ? asset.purchaseDate.toISOString().slice(0, 10) : "",
    "Nguyên giá": asset.originalCost,
    "Mã đã khoá": codeLocked ? "x" : "",
    "Nhóm chốt lại (khách điền)": "",
  })));
  sheet["!cols"] = [{ wch: 26 }, { wch: 16 }, { wch: 34 }, { wch: 18 }, { wch: 52 }, { wch: 40 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 11 }, { wch: 26 }];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Lech nhom tai san");
  XLSX.writeFile(book, outFile);
  console.log(`Đã ghi file gửi khách: ${outFile}`);
}

main()
  .catch((error) => { console.error("LỖI:", error.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
