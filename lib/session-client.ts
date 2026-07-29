import { SESSION_KEY } from "@/lib/auth-demo";

export const LOGIN_PATH = "/login";

export function clearClientSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // localStorage có thể bị chặn (chế độ riêng tư), bỏ qua để vẫn đăng xuất được
  }
}

// Cookie phiên là httpOnly nên phải nhờ server xoá, sau đó mới dọn localStorage.
export async function logout() {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch {
    // Mất mạng thì vẫn dọn phiên phía client rồi đẩy về trang đăng nhập
  }
  clearClientSession();
}

export function loginPathWithNext(next: string) {
  if (!next || next === LOGIN_PATH || next.startsWith(`${LOGIN_PATH}?`)) return LOGIN_PATH;
  return `${LOGIN_PATH}?next=${encodeURIComponent(next)}`;
}
