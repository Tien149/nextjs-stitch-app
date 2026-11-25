import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Cookie phiên có chữ ký (25/11/2026). Trước đó cookie `user_session` là JSON trần: ai sửa cookie
 * (đổi role thành Admin, thêm menu) là API tin luôn. Nay cookie = `<JSON base64url>.<HMAC-SHA256>`,
 * máy chủ chỉ nhận cookie đúng chữ ký; cookie cũ (chưa ký) bị bỏ — người dùng đăng nhập lại một lần.
 *
 * Khoá: biến môi trường SESSION_SECRET (≥ 32 ký tự). Chưa khai thì suy từ DATABASE_URL (chỉ máy chủ
 * biết) để hệ thống không chết đăng nhập — nên khai SESSION_SECRET riêng.
 */
let cachedSecret: string | null = null;
let warned = false;

export function sessionSecret() {
  if (cachedSecret) return cachedSecret;
  const configured = process.env.SESSION_SECRET || "";
  if (configured.length >= 32) {
    cachedSecret = configured;
    return cachedSecret;
  }
  const databaseUrl = process.env.DATABASE_URL || "";
  if (!databaseUrl) throw new Error("Chưa cấu hình SESSION_SECRET — không phát hành được phiên đăng nhập");
  if (!warned) {
    warned = true;
    console.warn("SESSION_SECRET chưa cấu hình (hoặc < 32 ký tự): khoá ký cookie phiên đang suy từ DATABASE_URL.");
  }
  cachedSecret = createHash("sha256").update(`fin-erp-session|${databaseUrl}`).digest("base64url");
  return cachedSecret;
}

function mac(body: string) {
  return createHmac("sha256", sessionSecret()).update(`session|${body}`).digest("base64url");
}

/** Giá trị cookie phiên có chữ ký từ chuỗi JSON của phiên. */
export function signSessionValue(json: string) {
  const body = Buffer.from(json, "utf8").toString("base64url");
  return `${body}.${mac(body)}`;
}

/** Chuỗi JSON của phiên nếu chữ ký đúng; sai / thiếu chữ ký / cookie cũ → null. */
export function verifySessionValue(value: string | null | undefined) {
  if (!value) return null;
  const raw = value.includes("%") ? safeDecode(value) : value;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = raw.slice(0, dot);
  const signature = Buffer.from(raw.slice(dot + 1));
  const expected = Buffer.from(mac(body));
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
  try {
    return Buffer.from(body, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
