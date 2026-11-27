import { createCipheriv, createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign, type KeyObject } from "node:crypto";

/**
 * Web Push thuần node:crypto (27/11/2026, học theo HRM — WebPushCrypto.java), không thêm thư viện:
 * - Mã hoá nội dung: RFC 8291 (aes128gcm, RFC 8188) bằng khoá p256dh + auth của trình duyệt.
 * - Ký người gửi: VAPID RFC 8292 (JWT ES256).
 */

export type VapidKeys = { publicKey: string; privateKey: string };
export type PushTarget = { endpoint: string; p256dh: string; auth: string };

const RECORD_SIZE = 4096;

function b64url(value: Buffer | Uint8Array) {
  return Buffer.from(value).toString("base64url");
}

function fromB64url(value: string) {
  return Buffer.from(value.replace(/=+$/, ""), "base64url");
}

/** Sinh cặp khoá VAPID: publicKey = điểm P-256 dạng thô 65 byte, privateKey = số bí mật d 32 byte (base64url). */
export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pub = publicKey.export({ format: "jwk" });
  const priv = privateKey.export({ format: "jwk" });
  const raw = Buffer.concat([Buffer.from([4]), fromB64url(String(pub.x)), fromB64url(String(pub.y))]);
  return { publicKey: b64url(raw), privateKey: String(priv.d) };
}

function vapidPrivateKeyObject(keys: VapidKeys): KeyObject {
  const raw = fromB64url(keys.publicKey);
  if (raw.length !== 65 || raw[0] !== 4) throw new Error("Khoá VAPID công khai không hợp lệ");
  return createPrivateKey({
    key: { kty: "EC", crv: "P-256", x: b64url(raw.subarray(1, 33)), y: b64url(raw.subarray(33, 65)), d: keys.privateKey },
    format: "jwk",
  });
}

/** Header Authorization VAPID cho một endpoint (aud = origin của dịch vụ đẩy, hết hạn 12 giờ). */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, nowSeconds = Math.floor(Date.now() / 1000)) {
  const header = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSeconds + 12 * 3600, sub: subject })));
  const unsigned = `${header}.${claims}`;
  const signature = sign("sha256", Buffer.from(unsigned), { key: vapidPrivateKeyObject(keys), dsaEncoding: "ieee-p1363" });
  return `vapid t=${unsigned}.${b64url(signature)}, k=${keys.publicKey}`;
}

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number) {
  return Buffer.from(hkdfSync("sha256", ikm, salt, info, length));
}

/**
 * Mã hoá nội dung cho một trình duyệt (RFC 8291 §3.4). `salt` / `senderKey` chỉ truyền khi kiểm thử
 * với bộ số cố định; chạy thật luôn sinh ngẫu nhiên mỗi tin.
 */
export function encryptPayload(target: Pick<PushTarget, "p256dh" | "auth">, payload: Buffer, options: { salt?: Buffer; senderPrivateKey?: Buffer } = {}) {
  const uaPublic = fromB64url(target.p256dh);
  const authSecret = fromB64url(target.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("Khoá p256dh không hợp lệ");
  if (authSecret.length < 16) throw new Error("Khoá auth không hợp lệ");
  if (payload.length > RECORD_SIZE - 17 - 86) throw new Error("Nội dung thông báo quá dài");

  const ecdh = createECDH("prime256v1");
  if (options.senderPrivateKey) ecdh.setPrivateKey(options.senderPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = options.salt || randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // Một bản ghi duy nhất: nội dung + byte phân cách 0x02 (bản ghi cuối), không đệm thêm.
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, encrypted]);
}

/**
 * Chỉ gửi tới dịch vụ đẩy của trình duyệt lớn (Chrome/Edge qua FCM & WNS, Firefox, Safari/iPhone).
 * Endpoint do trình duyệt khai nên phải chặn — nếu không ai cũng bắt máy chủ gọi tới địa chỉ nội bộ.
 */
export function isAllowedPushEndpoint(endpoint: string) {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port) return false;
  const host = url.hostname.toLowerCase();
  return host === "fcm.googleapis.com"
    || host === "android.googleapis.com"
    || host.endsWith(".push.services.mozilla.com")
    || host === "web.push.apple.com"
    || host.endsWith(".push.apple.com")
    || host.endsWith(".notify.windows.com");
}

export type PushSendResult = { ok: true } | { ok: false; gone: boolean; status: number; message: string };

/** Gửi một thông báo; `gone` = trình duyệt đã huỷ đăng ký (404/410) → nên xoá đăng ký. */
export async function sendWebPush(target: PushTarget, payload: object, keys: VapidKeys, subject: string, ttlSeconds = 24 * 3600): Promise<PushSendResult> {
  if (!isAllowedPushEndpoint(target.endpoint)) return { ok: false, gone: true, status: 0, message: "Endpoint không được phép" };
  const body = encryptPayload(target, Buffer.from(JSON.stringify(payload), "utf8"));
  try {
    const response = await fetch(target.endpoint, {
      method: "POST",
      headers: {
        Authorization: vapidAuthorization(target.endpoint, keys, subject),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(ttlSeconds),
        Urgency: "high",
      },
      body,
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (response.ok) return { ok: true };
    const text = (await response.text().catch(() => "")).slice(0, 200);
    return { ok: false, gone: response.status === 404 || response.status === 410, status: response.status, message: text };
  } catch (error) {
    return { ok: false, gone: false, status: 0, message: error instanceof Error ? error.message : String(error) };
  }
}
