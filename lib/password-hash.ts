import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Mật khẩu lưu dạng băm scrypt (25/11/2026) — trước đó cột User.password là chữ thường.
 * Dạng lưu: `scrypt$N$r$p$<salt base64url>$<hash base64url>`.
 *
 * Mật khẩu cũ (chữ thường) vẫn đăng nhập được: lần đăng nhập đúng đầu tiên hệ thống tự băm lại
 * (`needsRehash`). Muốn băm hết một lượt không chờ đăng nhập: `npm run repair:hash-passwords`.
 */
const PREFIX = "scrypt";
const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;

function scrypt(password: string, salt: Buffer, keyLength: number, options: ScryptOptions) {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export function isHashedPassword(stored: string | null | undefined) {
  return typeof stored === "string" && stored.startsWith(`${PREFIX}$`);
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH, { N, r: R, p: P });
  return [PREFIX, N, R, P, salt.toString("base64url"), key.toString("base64url")].join("$");
}

function sameBytes(left: Buffer, right: Buffer) {
  return left.length === right.length && timingSafeEqual(left, right);
}

/** So mật khẩu nhập với giá trị đã lưu (băm hoặc chữ thường cũ). */
export async function verifyPassword(password: string, stored: string | null | undefined) {
  if (!stored) return false;
  if (!isHashedPassword(stored)) {
    // Dạng cũ: so khớp như trước (bỏ khoảng trắng hai đầu), không lộ thời gian.
    return sameBytes(Buffer.from(stored.trim()), Buffer.from(password));
  }
  const [, n, r, p, salt, hash] = stored.split("$");
  const expected = Buffer.from(hash || "", "base64url");
  if (!salt || expected.length === 0) return false;
  try {
    const key = await scrypt(password, Buffer.from(salt, "base64url"), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
    return sameBytes(key, expected);
  } catch {
    return false;
  }
}

/** Giá trị đã lưu còn là chữ thường (hoặc tham số cũ) — băm lại sau lần đăng nhập đúng. */
export function needsRehash(stored: string | null | undefined) {
  if (!isHashedPassword(stored)) return true;
  const [, n, r, p] = String(stored).split("$");
  return Number(n) !== N || Number(r) !== R || Number(p) !== P;
}

/** Bỏ cột mật khẩu trước khi trả dữ liệu tài khoản về trình duyệt. */
export function withoutPassword<T extends { password?: unknown }>(user: T): Omit<T, "password"> {
  const { password: _password, ...rest } = user;
  void _password;
  return rest;
}
