/**
 * Loại thông báo vai trò được chọn nhận ở màn Phân quyền (Role.notificationTypes). Dùng được cả ở
 * trình duyệt lẫn máy chủ. Thêm loại mới: khai ở đây + gọi notifyUsers ở nơi phát sinh.
 */
export const NOTIFICATION_TYPES = [
  {
    key: "PR_PENDING",
    label: "PR chờ duyệt",
    desc: "Có yêu cầu mua mới hoặc gửi lại sau khi bị từ chối. Chỉ người có quyền Duyệt Mua hàng và được phân đúng cửa hàng, kho của PR mới nhận.",
  },
] as const;

export type NotificationTypeKey = (typeof NOTIFICATION_TYPES)[number]["key"];

export function sanitizeNotificationTypes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const known = new Set<string>(NOTIFICATION_TYPES.map((type) => type.key));
  return [...new Set(value.filter((item): item is string => typeof item === "string" && known.has(item)))];
}
