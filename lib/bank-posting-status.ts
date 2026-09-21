/**
 * Trạng thái VÀO SỔ của một dòng sao kê ngân hàng.
 *
 * Khách yêu cầu 21/09/2026: một ngày có hàng chục giao dịch, dò bằng mắt xem dòng nào chưa
 * vào sổ thì quá bất tiện — cần lọc được. Luật nằm ở đây để bộ lọc phía máy chủ và nhãn phía
 * màn hình không bao giờ lệch nhau: lệch một chút là lọc "Chưa vào sổ" lại ra dòng đang hiện
 * chữ "ĐÃ VÀO SỔ", và người dùng hết tin vào bộ lọc.
 *
 * Ba trạng thái PHỦ KÍN và KHÔNG CHỒNG LẤN — mọi dòng rơi vào đúng một rổ:
 *  - POSTED      "ĐÃ VÀO SỔ": đã nối được chứng từ.
 *  - NOT_POSTED  "CHƯA VÀO SỔ": chưa nối và hệ thống đã đánh dấu cần xử tay. Đây mới là rổ
 *                việc thật sự phải làm, cũng là rổ duy nhất có nút "Vào sổ".
 *  - LEGACY      "DỮ LIỆU CŨ": chưa nối và cũng chưa được đánh dấu — dòng import từ trước khi
 *                có luồng tự lập chứng từ. Tách riêng để nó không trộn vào việc của hôm nay.
 */
export const BANK_POSTING_STATUSES = ["NOT_POSTED", "POSTED", "LEGACY"] as const;
export type BankPostingStatus = (typeof BANK_POSTING_STATUSES)[number];

const MATCHED = "MATCHED";
const MANUAL_REQUIRED = "MANUAL_REQUIRED";

type BankPostingRow = { reconcileStatus: string; autoProcessType: string | null };

export function bankPostingStatusOf(row: BankPostingRow): BankPostingStatus {
  if (row.reconcileStatus === MATCHED) return "POSTED";
  return row.autoProcessType === MANUAL_REQUIRED ? "NOT_POSTED" : "LEGACY";
}

export const BANK_POSTING_STATUS_LABELS: Record<BankPostingStatus, string> = {
  POSTED: "ĐÃ VÀO SỔ",
  NOT_POSTED: "CHƯA VÀO SỔ",
  LEGACY: "DỮ LIỆU CŨ",
};

export function isBankPostingStatus(value: string): value is BankPostingStatus {
  return (BANK_POSTING_STATUSES as readonly string[]).includes(value);
}

/**
 * Điều kiện Prisma của một trạng thái. Trả mảng để nơi gọi spread thẳng vào `AND` — giá trị
 * lạ ra mảng rỗng, tức không lọc gì, chứ không ném lỗi ra giữa màn hình.
 *
 * Nhánh LEGACY phải liệt kê riêng `autoProcessType: null`: điều kiện `NOT` của Prisma bỏ luôn
 * dòng NULL, mà dòng chưa được đánh dấu mới đúng là thứ rổ này cần tìm.
 */
export function bankPostingStatusFilter(value: string) {
  const status = (value || "").toUpperCase();
  if (status === "POSTED") return [{ reconcileStatus: MATCHED }];
  if (status === "NOT_POSTED") return [{ NOT: { reconcileStatus: MATCHED }, autoProcessType: MANUAL_REQUIRED }];
  if (status === "LEGACY") {
    return [{
      NOT: { reconcileStatus: MATCHED },
      OR: [{ autoProcessType: null }, { NOT: { autoProcessType: MANUAL_REQUIRED } }],
    }];
  }
  return [];
}
