import { prisma, prismaRaw, isSoftDeletable } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit-log";
import type { DemoSession } from "@/lib/auth-demo";

/**
 * Đăng ký các thực thể được phép xoá mềm / khôi phục từ màn hình Thùng rác.
 *
 * - `model`   : tên model Prisma (PascalCase)
 * - `label`   : tên tiếng Việt hiển thị cho người dùng
 * - `module`  : href của menu, dùng để kiểm tra quyền và điều hướng
 * - `codeField` / `titleField`: cột dùng để mô tả bản ghi trong danh sách thùng rác
 * - `cascade` : các quan hệ con cũng bị xoá mềm/khôi phục theo bản ghi cha
 */
export type TrashEntity = {
  model: string;
  label: string;
  module: string;
  codeField?: string;
  titleField?: string;
  branchField?: string;
  cascade?: { model: string; foreignKey: string }[];
};

export const TRASH_ENTITIES: TrashEntity[] = [
  { model: "FinancialVoucher", label: "Phiếu thu/chi", module: "/vouchers", codeField: "code", titleField: "description", branchField: "branchCode" },
  { model: "Deposit", label: "Tiền cọc", module: "/deposits", codeField: "code", titleField: "partnerName", branchField: "branchCode" },
  { model: "DebtRecord", label: "Công nợ", module: "/debts", codeField: "code", titleField: "partnerName", branchField: "branchCode" },
  { model: "MoneyTransfer", label: "Chuyển tiền nội bộ", module: "/finance-operations", codeField: "code", titleField: "description", branchField: "branchCode" },
  { model: "CashbookAdjustment", label: "Điều chỉnh sổ quỹ", module: "/finance-operations", codeField: "code", titleField: "description", branchField: "branchCode" },
  { model: "Accrual", label: "Chi phí trả trước", module: "/finance-operations", codeField: "code", titleField: "name", branchField: "branchCode" },
  { model: "OpeningBalance", label: "Số dư đầu kỳ", module: "/opening-balances", codeField: "objectCode", titleField: "objectName", branchField: "branchCode" },

  {
    model: "InventoryItem", label: "Hàng hoá / Nguyên vật liệu", module: "/inventory", codeField: "code", titleField: "name",
    cascade: [{ model: "ItemUnitConversion", foreignKey: "itemId" }],
  },
  { model: "InventoryTransaction", label: "Phiếu nhập/xuất kho", module: "/inventory", codeField: "code", titleField: "note", branchField: "branchCode" },
  { model: "StocktakeSession", label: "Phiếu kiểm kê", module: "/inventory", codeField: "code", titleField: "note", branchField: "branchCode" },
  { model: "Recipe", label: "Định mức (BOM)", module: "/inventory", codeField: "code", titleField: "productName" },

  { model: "PurchaseRequestTemplate", label: "Mẫu yêu cầu mua hàng", module: "/procurement", codeField: "code", titleField: "name", branchField: "branchCode" },
  {
    model: "PurchaseRequest", label: "Đề nghị mua hàng", module: "/procurement", codeField: "code", titleField: "reason", branchField: "branchCode",
    cascade: [{ model: "SupplierQuote", foreignKey: "requestId" }],
  },
  { model: "PurchaseOrder", label: "Đơn mua hàng", module: "/procurement", codeField: "code", titleField: "supplierName", branchField: "branchCode" },
  { model: "SupplierQuote", label: "Báo giá nhà cung cấp", module: "/procurement", codeField: "supplierCode", titleField: "supplierName" },

  {
    model: "AssetRecord", label: "Tài sản", module: "/assets", codeField: "code", titleField: "name", branchField: "branchCode",
    cascade: [
      { model: "AssetMaintenance", foreignKey: "assetId" },
      { model: "AssetDamageReport", foreignKey: "assetId" },
    ],
  },
  { model: "AssetMaintenance", label: "Lịch bảo trì", module: "/assets", titleField: "maintenanceType" },
  { model: "AssetDamageReport", label: "Báo hỏng tài sản", module: "/assets", codeField: "code", titleField: "description" },

  { model: "MasterDataItem", label: "Danh mục", module: "/settings", codeField: "code", titleField: "name", branchField: "branch" },
  { model: "AccountingAccount", label: "Tài khoản kế toán", module: "/accounting", codeField: "code", titleField: "name" },
  { model: "JournalEntry", label: "Bút toán", module: "/accounting", codeField: "code", titleField: "description", branchField: "branchCode" },
  { model: "PostingRule", label: "Quy tắc hạch toán", module: "/accounting", codeField: "ruleCode", titleField: "name" },

  {
    model: "WorkItem", label: "Công việc", module: "/work-management", codeField: "code", titleField: "title", branchField: "branchCode",
    cascade: [
      { model: "WorkChecklistItem", foreignKey: "workItemId" },
      { model: "WorkComment", foreignKey: "workItemId" },
      { model: "WorkAttachment", foreignKey: "workItemId" },
    ],
  },
  { model: "WorkChecklistItem", label: "Mục checklist", module: "/work-management", titleField: "title" },
  { model: "WorkComment", label: "Bình luận công việc", module: "/work-management", titleField: "content" },
  { model: "WorkAttachment", label: "Tệp đính kèm", module: "/work-management", titleField: "fileName" },

  { model: "User", label: "Người dùng", module: "/permissions", codeField: "email", titleField: "name" },
  { model: "Role", label: "Vai trò", module: "/permissions", codeField: "name", titleField: "name" },

  { model: "ImportBatch", label: "Lô import", module: "/imports", codeField: "templateCode", titleField: "fileName", branchField: "branchCode" },
  {
    model: "BankStatementTransaction", label: "Giao dịch sao kê", module: "/imports", codeField: "transactionCode", titleField: "description", branchField: "branchCode",
    // Xoá giao dịch sao kê thì các cặp đối soát trỏ vào nó cũng phải ẩn theo,
    // nếu không màn hình Đối soát sẽ còn lại những cặp mồ côi.
    cascade: [{ model: "ReconciliationMatch", foreignKey: "bankTransactionId" }],
  },
  { model: "RevenueImportRow", label: "Dòng doanh thu", module: "/imports", codeField: "externalRef", titleField: "revenueSource", branchField: "branchCode" },
  { model: "PayrollImportRow", label: "Dòng lương", module: "/imports", codeField: "employeeCode", titleField: "employeeName", branchField: "branchCode" },
  { model: "ReconciliationMatch", label: "Cặp đối soát", module: "/reconciliations", codeField: "targetCode", titleField: "note" },
];

const ENTITY_BY_MODEL = new Map(TRASH_ENTITIES.map((entity) => [entity.model, entity]));

export function trashEntity(model: string): TrashEntity | undefined {
  return ENTITY_BY_MODEL.get(model);
}

/** Tên model (PascalCase) -> key trên PrismaClient (camelCase). */
function clientKey(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

/**
 * Prisma không sinh kiểu cho việc tra cứu delegate bằng chuỗi tên model, nên các
 * thao tác động dưới đây dùng một kiểu delegate tối giản thay vì `any`.
 */
type DynamicDelegate = {
  findUnique: (args: unknown) => Promise<Record<string, unknown> | null>;
  findFirst: (args: unknown) => Promise<Record<string, unknown> | null>;
  findMany: (args: unknown) => Promise<Record<string, unknown>[]>;
  count: (args: unknown) => Promise<number>;
  update: (args: unknown) => Promise<unknown>;
  updateMany: (args: unknown) => Promise<unknown>;
};

/** Đọc một cột dạng chuỗi từ bản ghi động, trả null nếu thiếu. */
function fieldText(row: Record<string, unknown>, field?: string): string | null {
  if (!field) return null;
  const value = row[field];
  return value === null || value === undefined ? null : String(value);
}

function rawDelegate(model: string): DynamicDelegate {
  return (prismaRaw as unknown as Record<string, DynamicDelegate>)[clientKey(model)];
}

function liveDelegate(model: string): DynamicDelegate {
  return (prisma as unknown as Record<string, DynamicDelegate>)[clientKey(model)];
}

export class SoftDeleteError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function assertKnownModel(model: string) {
  if (!isSoftDeletable(model)) {
    throw new SoftDeleteError(`Model "${model}" không hỗ trợ xoá mềm`, 400);
  }
}

type ActionInput = {
  model: string;
  id: string;
  session?: DemoSession | null;
  /** Ghi chú lý do xoá, hiển thị lại trong thùng rác và nhật ký. */
  reason?: string | null;
};

/**
 * Xoá mềm một bản ghi: đánh dấu deletedAt/deletedBy, xoá mềm các bản ghi con
 * đã khai báo trong `cascade`, và ghi nhật ký hệ thống.
 */
export async function softDeleteRecord({ model, id, session, reason }: ActionInput) {
  assertKnownModel(model);
  const entity = trashEntity(model);
  const delegate = rawDelegate(model);

  const current = await delegate.findUnique({ where: { id } });
  if (!current) throw new SoftDeleteError("Không tìm thấy bản ghi cần xoá", 404);
  if (current.deletedAt) throw new SoftDeleteError("Bản ghi này đã bị xoá trước đó", 400);

  const deletedAt = new Date();
  const deletedBy = session?.name || session?.email || null;

  await prismaRaw.$transaction(async (tx) => {
    const txDelegate = (tx as unknown as Record<string, DynamicDelegate>)[clientKey(model)];
    await txDelegate.update({ where: { id }, data: { deletedAt, deletedBy } });

    for (const child of entity?.cascade || []) {
      const childDelegate = (tx as unknown as Record<string, DynamicDelegate>)[clientKey(child.model)];
      await childDelegate.updateMany({
        where: { [child.foreignKey]: id, deletedAt: null },
        data: { deletedAt, deletedBy },
      });
    }
  });

  await writeAuditLog({
    session,
    module: entity?.module || model,
    action: "SOFT_DELETE",
    entityType: model,
    entityId: id,
    entityCode: fieldText(current, entity?.codeField),
    branchCode: fieldText(current, entity?.branchField),
    message: reason || null,
    metadata: { label: entity?.label, cascade: entity?.cascade?.map((c) => c.model) },
  });

  return { ok: true, deletedAt, deletedBy };
}

/** Khôi phục bản ghi đã xoá mềm (kèm các bản ghi con bị xoá theo). */
export async function restoreRecord({ model, id, session }: ActionInput) {
  assertKnownModel(model);
  const entity = trashEntity(model);
  const delegate = rawDelegate(model);

  const current = await delegate.findUnique({ where: { id } });
  if (!current) throw new SoftDeleteError("Không tìm thấy bản ghi cần khôi phục", 404);
  if (!current.deletedAt) throw new SoftDeleteError("Bản ghi này đang hoạt động, không cần khôi phục", 400);

  await prismaRaw.$transaction(async (tx) => {
    const txDelegate = (tx as unknown as Record<string, DynamicDelegate>)[clientKey(model)];
    await txDelegate.update({ where: { id }, data: { deletedAt: null, deletedBy: null } });

    for (const child of entity?.cascade || []) {
      const childDelegate = (tx as unknown as Record<string, DynamicDelegate>)[clientKey(child.model)];
      // Chỉ khôi phục con bị xoá cùng thời điểm với cha, tránh làm sống lại
      // những bản ghi con người dùng đã chủ động xoá riêng từ trước.
      await childDelegate.updateMany({
        where: { [child.foreignKey]: id, deletedAt: current.deletedAt },
        data: { deletedAt: null, deletedBy: null },
      });
    }
  });

  await writeAuditLog({
    session,
    module: entity?.module || model,
    action: "RESTORE",
    entityType: model,
    entityId: id,
    entityCode: fieldText(current, entity?.codeField),
    branchCode: fieldText(current, entity?.branchField),
    metadata: { label: entity?.label },
  });

  return { ok: true };
}

export type TrashRow = {
  id: string;
  model: string;
  label: string;
  module: string;
  code: string | null;
  title: string | null;
  branchCode: string | null;
  deletedAt: Date;
  deletedBy: string | null;
};

/**
 * Liệt kê bản ghi trong thùng rác. Trả về dạng chuẩn hoá để một màn hình
 * duy nhất hiển thị được mọi loại thực thể.
 */
export async function listTrash(options: {
  models?: string[];
  branchCodes?: string[];
  keyword?: string;
  limitPerModel?: number;
}): Promise<TrashRow[]> {
  const limit = options.limitPerModel ?? 100;
  const targets = (
    options.models?.length
      ? TRASH_ENTITIES.filter((entity) => options.models!.includes(entity.model))
      : TRASH_ENTITIES
  ).filter((entity) => isSoftDeletable(entity.model));

  const chunks = await Promise.all(
    targets.map(async (entity) => {
      const rows = await rawDelegate(entity.model).findMany({
        where: { deletedAt: { not: null } },
        orderBy: { deletedAt: "desc" },
        take: limit,
      });

      return rows.map(
        (row: Record<string, unknown>): TrashRow => ({
          id: String(row.id),
          model: entity.model,
          label: entity.label,
          module: entity.module,
          code: fieldText(row, entity.codeField),
          title: fieldText(row, entity.titleField),
          branchCode: fieldText(row, entity.branchField),
          deletedAt: row.deletedAt as Date,
          deletedBy: fieldText(row, "deletedBy"),
        }),
      );
    }),
  );

  let result = chunks.flat();

  if (options.branchCodes?.length && !options.branchCodes.includes("ALL")) {
    result = result.filter((row) => !row.branchCode || options.branchCodes!.includes(row.branchCode));
  }

  const keyword = options.keyword?.trim().toLowerCase();
  if (keyword) {
    result = result.filter(
      (row) =>
        row.code?.toLowerCase().includes(keyword) ||
        row.title?.toLowerCase().includes(keyword) ||
        row.label.toLowerCase().includes(keyword),
    );
  }

  return result.sort((a, b) => b.deletedAt.getTime() - a.deletedAt.getTime());
}

/**
 * Tìm bản ghi ĐÃ XOÁ đang chiếm mã unique, để báo lỗi có hướng xử lý thay vì
 * chỉ trả về "mã đã tồn tại" trong khi người dùng không thấy bản ghi nào.
 */
export async function findDeletedByUnique(
  model: string,
  where: Record<string, unknown>,
): Promise<{ id: string; deletedAt: Date; deletedBy: string | null } | null> {
  if (!isSoftDeletable(model)) return null;
  const row = await rawDelegate(model).findFirst({
    where: { ...where, deletedAt: { not: null } },
    select: { id: true, deletedAt: true, deletedBy: true },
  });
  if (!row) return null;
  return {
    id: String(row.id),
    deletedAt: row.deletedAt as Date,
    deletedBy: fieldText(row, "deletedBy"),
  };
}

/**
 * Thông báo chuẩn khi mã trùng với một bản ghi đang nằm trong thùng rác.
 */
export function duplicatedInTrashMessage(code: string, label = "Bản ghi") {
  return `${label} với mã "${code}" đang nằm trong Thùng rác. Hãy khôi phục bản ghi đó hoặc dùng mã khác.`;
}

/** Đếm số bản ghi trong thùng rác theo từng loại, phục vụ badge trên UI. */
export async function countTrash(models?: string[]) {
  const targets = models?.length
    ? TRASH_ENTITIES.filter((entity) => models.includes(entity.model))
    : TRASH_ENTITIES;

  const counts = await Promise.all(
    targets.map(async (entity) => ({
      model: entity.model,
      label: entity.label,
      module: entity.module,
      count: (await rawDelegate(entity.model).count({ where: { deletedAt: { not: null } } })) as number,
    })),
  );

  return counts.filter((item) => item.count > 0);
}

export { liveDelegate };
