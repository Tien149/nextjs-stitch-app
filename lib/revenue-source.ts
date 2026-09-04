/**
 * Nhóm doanh thu (revenueSource) của từng dòng doanh thu POS.
 *
 * File POS của khách có cột "Nhóm doanh thu" nhưng để trống toàn bộ (ghi "-"), trong khi
 * revenueSource chính là categoryCode của dòng Có 511 khi ghi sổ (lib/accounting.ts) và là
 * căn cứ suy bộ phận Bếp/Bar khi mã hàng chưa gán nhóm (lib/revenue-department.ts).
 * Vì vậy nhóm doanh thu được khai một lần trên DANH MỤC MẶT HÀNG (InventoryItem.revenueGroup,
 * chọn từ danh mục Thu/Chi nhóm NHÓM DOANH THU — không phải mọi loại thu quỹ) rồi import tra
 * theo mã hàng.
 *
 * File của khách còn ghi cột này bằng CHỮ ("ĐỒ ĂN" / "ĐỒ UỐNG") thay vì mã danh mục, mà chữ
 * đó không phải categoryCode nào nên doanh thu rơi vào "Chưa phân loại". Vì vậy giá trị trong
 * file được quy về mã danh mục Thu trước khi dùng (loadRevenueCategoryIndex): khớp mã -> khớp
 * tên -> khớp TỪ KHOÁ người dùng tự khai trên danh mục (MasterDataItem.matchKeywords, sửa ngay
 * trên màn hình Cài đặt > Danh mục Thu/Chi) -> nhận dạng sẵn có (đồ ăn = bếp, đồ uống = bar).
 * Chữ không quy được về mã nào thì coi như chưa khai để danh mục mặt hàng được quyền điền.
 *
 * Thứ tự ưu tiên: mã suy từ giá trị trong file -> danh mục mặt hàng -> chữ thô trong file.
 */

import type { Prisma } from "@prisma/custom-client";
import { isRevenueGroupCategory } from "@/lib/voucher-rules";

/**
 * Ô "trống" trên file POS không phải lúc nào cũng là chuỗi rỗng: bản xuất của khách điền "-",
 * chỗ khác điền "n/a". Coi các giá trị này là chưa khai để danh mục mặt hàng được quyền điền.
 */
const blankMarkers = new Set(["", "-", "--", "---", "N/A", "NA", "NULL", "NONE", "KHONG", "KHÔNG"]);

/** Trả về giá trị nhóm doanh thu thật sự có trong file, hoặc "" nếu ô đó coi như bỏ trống. */
export function cleanRevenueSourceInput(value: unknown) {
  const text = String(value ?? "").trim();
  return blankMarkers.has(text.toUpperCase()) ? "" : text;
}

export type RevenueSourceResolver = (productCode?: string | null) => string;

type ItemLookupClient = Pick<Prisma.TransactionClient, "inventoryItem">;

/**
 * Nạp sẵn map mã hàng -> nhóm doanh thu cho một danh sách mã hàng rồi trả về resolver đồng bộ,
 * dùng được cả trong transaction import lẫn script backfill (script chạy PrismaClient thô nên
 * phải lọc deletedAt tường minh, không có extension xoá mềm).
 */
export async function buildRevenueSourceResolver(client: ItemLookupClient, productCodes: string[]): Promise<RevenueSourceResolver> {
  const codes = [...new Set(productCodes.map((code) => (code || "").toUpperCase()).filter(Boolean))];
  const items = codes.length > 0
    ? await client.inventoryItem.findMany({
        where: { code: { in: codes }, deletedAt: null, revenueGroup: { not: null } },
        select: { code: true, revenueGroup: true },
      })
    : [];
  const byProduct = new Map(items.map((item) => [item.code.toUpperCase(), item.revenueGroup || ""]));
  return (productCode) => (productCode ? byProduct.get(productCode.toUpperCase()) || "" : "");
}

/**
 * Gộp hai nguồn theo đúng thứ tự ưu tiên — dùng chung cho import và backfill.
 * Không truyền index thì giữ nguyên hành vi cũ (file thắng, y nguyên chữ trong file).
 */
export function pickRevenueSource(fileValue: unknown, catalogValue: string, index?: RevenueCategoryIndex) {
  const fromFile = cleanRevenueSourceInput(fileValue);
  if (!fromFile) return catalogValue || "";
  if (!index) return fromFile;
  // Chữ tự do không tra được về mã danh mục nào ("Set combo", "Khác"...) thì nhường danh mục
  // mặt hàng; hết đường mới giữ lại chữ thô để báo cáo còn thấy dữ liệu gốc mà đối chiếu.
  return index.toCode(fromFile) || catalogValue || fromFile;
}

/**
 * Loại món suy từ chữ tự do — nền của cả nhóm doanh thu lẫn bộ phận Bếp/Bar.
 * SERVICE là dịch vụ / phụ thu (spec 04/09/2026: "Dịch vụ" lên Doanh thu phụ thu) — không có
 * bộ phận Bếp/Bar và không theo dõi tồn kho.
 */
export type RevenueKind = "FOOD" | "DRINK" | "SERVICE";

/** "ĐỒ ĂN" -> "DO AN", "REV_FOOD" -> "REV FOOD": bỏ dấu, hoa hết, mọi ký tự lạ thành khoảng trắng. */
function normalizeKindText(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

/**
 * Nhận dạng "đồ ăn" (bếp) hay "đồ uống" (bar) từ chữ tự do: dùng cho cả giá trị trong file POS
 * lẫn tên/mã danh mục Thu. "AN" và "UONG" phải khớp NGUYÊN TỪ, vì "DOANH thu" có chứa "an".
 * Chữ mang cả hai vế ("ăn uống") là danh mục gộp, không suy bừa về một bên.
 */
export function revenueKindFromText(value: unknown): RevenueKind | null {
  const text = normalizeKindText(value);
  if (!text) return null;
  const food = /\bAN\b/.test(text) || text.includes("FOOD") || text.includes("KITCHEN") || text.includes("BEP") || text.includes("AM THUC");
  const drink = /\bUONG\b/.test(text) || text.includes("DRINK") || text.includes("BEVERAGE") || text.includes("BAR") || text.includes("NUOC");
  if (food && drink) return null;
  if (food) return "FOOD";
  if (drink) return "DRINK";
  // "Dịch vụ", "Phụ thu", "Service charge"... — chỉ khi không dính chữ ăn/uống nào.
  if (/\bDICH VU\b|\bPHU THU\b|SERVICE|SURCHARGE/.test(text)) return "SERVICE";
  return null;
}

/** Quy chữ trong file về mã danh mục Thu. Trả "" khi không nhận ra. */
export type RevenueCategoryIndex = { toCode: (value: unknown) => string };

export type CategoryLookupClient = Pick<Prisma.TransactionClient, "masterDataItem">;

/** Mã ưu tiên khi danh mục có nhiều nhóm cùng loại món, để kết quả không phụ thuộc thứ tự alphabet. */
const preferredCodes: Record<RevenueKind, string[]> = {
  FOOD: ["REV_FOOD", "REV_KITCHEN", "REV_BEP"],
  DRINK: ["REV_DRINK", "REV_BAR"],
  SERVICE: ["REV_SERVICE", "REV_PHU", "REV_PHUTHU", "REV_SURCHARGE", "REV_DICHVU"],
};

/**
 * Nạp danh mục Thu đang hoạt động rồi trả về bộ quy đổi chữ -> mã.
 * deletedAt lọc tường minh vì script backfill chạy PrismaClient thô, không có extension xoá mềm.
 */
export async function loadRevenueCategoryIndex(client: CategoryLookupClient): Promise<RevenueCategoryIndex> {
  const categories = await client.masterDataItem.findMany({
    where: { type: "REVENUE_EXPENSE_CATEGORY", status: "ACTIVE", deletedAt: null },
    select: { code: true, name: true, group: true, matchKeywords: true },
    orderBy: { code: "asc" },
  });
  // Chỉ danh mục khai là NHÓM DOANH THU mới được nhận: danh mục Chi thì chữ "bar" dính vào phí
  // bar, còn loại thu quỹ (thu tiền thừa, thu đặt cọc...) tuy là tiền vào nhưng không phải
  // doanh thu, quy chữ trong file POS về đó là sai ngay từ gốc.
  const revenueCategories = categories.filter((category) => isRevenueGroupCategory(category.group));
  const byCode = new Map(revenueCategories.map((category) => [category.code.toUpperCase(), category.code] as const));
  const byName = new Map(revenueCategories.map((category) => [normalizeKindText(category.name), category.code] as const).filter(([name]) => name));
  // Từ khoá khai tay thắng cả nhận dạng sẵn có: khách tự dạy hệ thống đọc file của mình.
  // Hai danh mục khai trùng một từ khoá thì danh mục có mã đứng trước giữ từ khoá đó.
  const byKeyword = new Map<string, string>();
  for (const category of revenueCategories) {
    for (const keyword of splitMatchKeywords(category.matchKeywords)) {
      if (!byKeyword.has(keyword)) byKeyword.set(keyword, category.code);
    }
  }
  const byKind = new Map<RevenueKind, string>();
  for (const kind of ["FOOD", "DRINK", "SERVICE"] as RevenueKind[]) {
    const matched = revenueCategories.filter((category) => revenueKindFromText(`${category.code} ${category.name}`) === kind);
    const picked = preferredCodes[kind].map((code) => matched.find((category) => category.code.toUpperCase() === code)).find(Boolean) || matched[0];
    if (picked) byKind.set(kind, picked.code);
  }
  return {
    toCode(value) {
      const text = cleanRevenueSourceInput(value);
      if (!text) return "";
      const normalized = normalizeKindText(text);
      const exact = byCode.get(text.toUpperCase()) || byName.get(normalized) || byKeyword.get(normalized);
      if (exact) return exact;
      const kind = revenueKindFromText(text);
      return (kind && byKind.get(kind)) || "";
    },
  };
}

/**
 * Mã các nhóm doanh thu khai "không theo dõi tồn kho" trên danh mục Thu/Chi (viết hoa).
 *
 * Phụ thu / dịch vụ / thuê không gian bán ra không rút thứ gì khỏi kho, nhưng file POS vẫn ghi
 * chúng thành dòng có mã hàng + số lượng nên trước đây bị đẩy vào hàng chờ "Rã nguyên liệu":
 * nút Rã hoặc báo lỗi không tìm thấy mặt hàng, hoặc xuất bán thẳng làm tồn âm. Khai cờ trên
 * danh mục là đủ cho cả cụm mã cùng nhóm, không phải khai lại từng mã hàng.
 * deletedAt lọc tường minh vì script backfill chạy PrismaClient thô, không có extension xoá mềm.
 */
export async function loadNonInventoryRevenueGroups(client: CategoryLookupClient): Promise<Set<string>> {
  const categories = await client.masterDataItem.findMany({
    where: { type: "REVENUE_EXPENSE_CATEGORY", skipInventory: true, deletedAt: null },
    select: { code: true, group: true },
  });
  // Cờ chỉ có nghĩa với nhóm doanh thu: loại thu quỹ và danh mục Chi không bao giờ đi kèm mã hàng.
  return new Set(categories.filter((category) => isRevenueGroupCategory(category.group)).map((category) => category.code.toUpperCase()));
}

/**
 * Dòng doanh thu này có phải theo dõi tồn kho (vào hàng chờ rã nguyên liệu) không.
 * Chưa quy được về mã danh mục nào thì vẫn coi là có, để không bỏ sót hàng thật.
 */
export function tracksInventory(revenueSource: unknown, nonInventoryGroups: Set<string>) {
  const code = String(revenueSource ?? "").trim().toUpperCase();
  return !code || !nonInventoryGroups.has(code);
}

/** Ô từ khoá là chữ tự do: tách theo dấu phẩy, chấm phẩy, gạch đứng hoặc xuống dòng. */
export function splitMatchKeywords(value: unknown) {
  return String(value ?? "")
    .split(/[,;|\n\r]+/)
    .map((keyword) => normalizeKindText(keyword))
    .filter(Boolean);
}
