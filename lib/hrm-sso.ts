import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Đăng nhập HRM bằng tài khoản phần mềm kế toán (HRM chạy ở /hr, xem hrm/docs/adr/0003).
 *
 * Cookie phiên `user_session` của app này là JSON KHÔNG ký, nên không dùng nó để chứng minh danh tính
 * với HRM. Thay vào đó, lúc đăng nhập thành công server phát thêm cookie `hrm_sso_proof` có chữ ký
 * (chỉ gửi kèm tới /api/hrm-sso); route SSO chỉ phát vé khi cookie này khớp với user trong phiên.
 */

export const HRM_PROOF_COOKIE = "hrm_sso_proof";
export const HRM_PROOF_PATH = "/api/hrm-sso";
const TICKET_TTL_SECONDS = 60;

export function hrmSsoSecret(): string | null {
  const s = process.env.HRM_SSO_SECRET || "";
  return s.length >= 32 ? s : null;
}

function mac(secret: string, data: string) {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

function sameText(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Giá trị cookie chứng thực: userId.issuedAtMs.chữ-ký */
export function signProof(secret: string, userId: string, issuedAtMs = Date.now()) {
  const body = `${Buffer.from(userId).toString("base64url")}.${issuedAtMs}`;
  return `${body}.${mac(secret, `proof|${body}`)}`;
}

/** Trả userId nếu cookie hợp lệ và chưa quá maxAgeSeconds. */
export function verifyProof(secret: string, value: string | undefined, maxAgeSeconds: number): string | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const body = `${parts[0]}.${parts[1]}`;
  if (!sameText(mac(secret, `proof|${body}`), parts[2])) return null;
  const issuedAt = Number(parts[1]);
  if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > maxAgeSeconds * 1000 || issuedAt > Date.now() + 60_000) return null;
  return Buffer.from(parts[0], "base64url").toString();
}

/** Vé một lần, sống 60 giây: v1.<payload>.<chữ ký> — định dạng khớp SsoTicket.java bên HRM. */
export function issueHrmTicket(secret: string, user: { id: string; email: string; name: string }) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: "accounting",
    aud: "hrm",
    sub: user.id,
    email: user.email,
    name: user.name,
    iat: now,
    exp: now + TICKET_TTL_SECONDS,
    jti: randomBytes(18).toString("base64url"),
  };
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `v1.${p}.${mac(secret, `v1.${p}`)}`;
}

/** Chỉ nhận đường dẫn nội bộ của HRM. */
export function safeHrmNext(next: string | null) {
  if (!next || !next.startsWith("/") || next.startsWith("//") || /[\\\r\n]/.test(next)) return "/";
  return next;
}
