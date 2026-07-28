import { Prisma, PrismaClient } from '@prisma/custom-client';

const globalForPrisma = global as unknown as {
  prismaBase: PrismaClient;
};

const basePrisma =
  globalForPrisma.prismaBase ||
  new PrismaClient({
    log: ['query'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prismaBase = basePrisma;

/**
 * Các model có cột deletedAt -> áp dụng xoá mềm.
 * Lấy động từ DMMF nên thêm cột trong schema là tự có hiệu lực, không cần sửa file này.
 */
const SOFT_DELETE_MODELS = new Set(
  Prisma.dmmf.datamodel.models
    .filter((model) => model.fields.some((field) => field.name === 'deletedAt'))
    .map((model) => model.name)
);

export function isSoftDeletable(model?: string): boolean {
  return Boolean(model && SOFT_DELETE_MODELS.has(model));
}

export function softDeletableModels(): string[] {
  return [...SOFT_DELETE_MODELS];
}

type WhereArg = Record<string, unknown> | undefined;

/** Chỉ lấy bản ghi còn sống, trừ khi lời gọi đã tự chỉ định điều kiện deletedAt. */
function onlyAlive(where: WhereArg): Record<string, unknown> {
  if (where && Object.prototype.hasOwnProperty.call(where, 'deletedAt')) return where;
  return { ...(where || {}), deletedAt: null };
}

/** Tên model trong DMMF (PascalCase) -> key trên PrismaClient (camelCase). */
function clientKey(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

function delegateOf(model: string) {
  return (basePrisma as unknown as Record<string, any>)[clientKey(model)];
}

/**
 * Client dùng trong toàn bộ ứng dụng.
 *
 * - delete/deleteMany bị chuyển thành xoá mềm (set deletedAt) thay vì xoá vĩnh viễn.
 * - Các truy vấn đọc tự loại bản ghi đã xoá.
 * - upsert chạm vào bản ghi đã xoá sẽ khôi phục lại bản ghi đó (tránh sinh ra bản ghi
 *   "ẩn" mà người dùng không thấy nhưng vẫn chiếm mã unique).
 *
 * Lưu ý: extension của Prisma chỉ chặn được thao tác ở cấp cao nhất. Quan hệ lồng qua
 * `include`/`select` KHÔNG được lọc tự động — nơi nào cần thì lọc thủ công bằng
 * `where: { deletedAt: null }`.
 */
export const prisma = basePrisma.$extends({
  query: {
    $allModels: {
      async findMany({ model, args, query }) {
        if (isSoftDeletable(model)) args.where = onlyAlive(args.where as WhereArg) as never;
        return query(args);
      },
      async findFirst({ model, args, query }) {
        if (isSoftDeletable(model)) args.where = onlyAlive(args.where as WhereArg) as never;
        return query(args);
      },
      async findFirstOrThrow({ model, args, query }) {
        if (isSoftDeletable(model)) args.where = onlyAlive(args.where as WhereArg) as never;
        return query(args);
      },
      async count({ model, args, query }) {
        if (isSoftDeletable(model)) args.where = onlyAlive(args.where as WhereArg) as never;
        return query(args);
      },
      async aggregate({ model, args, query }) {
        if (isSoftDeletable(model)) args.where = onlyAlive(args.where as WhereArg) as never;
        return query(args);
      },
      async groupBy({ model, args, query }) {
        if (isSoftDeletable(model)) args.where = onlyAlive(args.where as WhereArg) as never;
        return query(args);
      },

      // findUnique nhận khoá unique nên không chèn thêm điều kiện được -> lọc ở kết quả.
      async findUnique({ model, args, query }) {
        const result = (await query(args)) as { deletedAt?: Date | null } | null;
        if (result && isSoftDeletable(model) && result.deletedAt) return null;
        return result;
      },
      async findUniqueOrThrow({ model, args, query }) {
        const result = (await query(args)) as { deletedAt?: Date | null } | null;
        if (result && isSoftDeletable(model) && result.deletedAt) {
          throw new Error(`${model}: bản ghi không tồn tại hoặc đã bị xoá`);
        }
        return result;
      },

      // Không xoá vĩnh viễn: quy về đánh dấu deletedAt.
      async delete({ model, args, query }) {
        if (!isSoftDeletable(model)) return query(args);
        return delegateOf(model).update({
          where: (args as { where: unknown }).where,
          data: { deletedAt: new Date() },
        });
      },
      async deleteMany({ model, args, query }) {
        if (!isSoftDeletable(model)) return query(args);
        return delegateOf(model).updateMany({
          where: onlyAlive((args as { where?: WhereArg }).where),
          data: { deletedAt: new Date() },
        });
      },

      // Ghi đè lên bản ghi đã xoá thì khôi phục luôn, tránh để lại bản ghi ẩn.
      async upsert({ model, args, query }) {
        if (isSoftDeletable(model)) {
          const typed = args as { update: Record<string, unknown> };
          typed.update = { ...typed.update, deletedAt: null, deletedBy: null };
        }
        return query(args);
      },
    },
  },
});

/**
 * Client thô, KHÔNG lọc bản ghi đã xoá.
 * Chỉ dùng cho màn hình Thùng rác, khôi phục dữ liệu và tác vụ quản trị.
 */
export const prismaRaw = basePrisma;

/**
 * Kiểu client bên trong `prisma.$transaction`.
 * Dùng thay cho `Prisma.TransactionClient` vì client đã qua `$extends` có kiểu khác.
 */
export type TxClient = Omit<
  typeof prisma,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * Kiểu client bên trong `prismaRaw.$transaction` — KHÔNG có lớp xoá mềm.
 * Dùng cho rollback import và các tác vụ quản trị cần xoá vĩnh viễn thật sự.
 */
export type RawTxClient = Prisma.TransactionClient;
