import { prisma } from "@/lib/prisma";
import { internalPartnerCode } from "@/lib/cost-reallocation";

/**
 * Đối tác nội bộ đại diện một nhà hàng. Tạo sẵn khi cần để công nợ nội bộ có đối tượng cụ
 * thể — không bắt người dùng phải tự khai danh mục trước mới lập được phiếu.
 *
 * Dùng chung cho phiếu phân bổ chi phí liên nhà hàng và phiếu điều tiền liên nhà hàng, để
 * hai nghiệp vụ cùng gọi một đối tượng công nợ thay vì mỗi nơi tự đặt một mã.
 */
export async function ensureInternalPartner(tx: typeof prisma, branchCode: string) {
  const code = internalPartnerCode(branchCode);
  const existing = await tx.masterDataItem.findFirst({ where: { type: "PARTNER", code } });
  if (existing) return existing;
  const branch = await tx.masterDataItem.findFirst({ where: { type: "BRANCH", code: branchCode }, select: { name: true } });
  return tx.masterDataItem.create({
    data: {
      type: "PARTNER",
      code,
      name: `${branch?.name || branchCode} (nội bộ)`,
      group: "OTHER_PARTNER",
      partnerType: "OTHER_PARTNER",
      partnerGroup: "INTERNAL",
      status: "ACTIVE",
      note: "Tự tạo cho công nợ nội bộ giữa các nhà hàng",
    },
  });
}
