import { networkInterfaces } from "os";

/**
 * Địa chỉ gốc để dựng LINK CÔNG KHAI gửi ra ngoài (phiếu PO cho nhà cung cấp, mã QR).
 *
 * Link này người khác mở trên MÁY KHÁC nên không được lấy nguyên "localhost" của người
 * đang thao tác — quét QR trên điện thoại thì localhost là chính cái điện thoại đó,
 * Safari báo "không thể kết nối với máy chủ".
 *
 * Thứ tự ưu tiên:
 *   1. APP_PUBLIC_URL — tên miền thật, cấu hình trên máy chủ chạy thật.
 *   2. x-forwarded-host/proto — khi chạy sau reverse proxy (nginx, cloudflare...).
 *   3. Host của request.
 *   4. Nếu host là localhost khi chạy máy cá nhân: đổi sang IP LAN để điện thoại cùng wifi
 *      quét QR mở được.
 */

/** Địa chỉ thuộc dải mạng nội bộ thật (không phải card ảo lung tung). */
function isPrivateIPv4(address: string) {
  const [a, b] = address.split(".").map(Number);
  if (a === 192 && b === 168) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/**
 * IPv4 nội bộ của máy chủ. Ưu tiên dải 192.168.x.x (wifi/LAN gia đình, quán) rồi mới đến
 * 10.x / 172.16-31.x. Máy cài VirtualBox/VMware/WSL/Docker thường có thêm card ảo
 * (192.168.56.1, 172.17.0.1...) mà điện thoại không bao giờ tới được, nên loại tên card ảo.
 */
function lanIPv4() {
  const candidates: Array<{ address: string; score: number }> = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    const virtual = /virtualbox|vmware|hyper-v|docker|wsl|loopback|vethernet|tailscale|zerotier/i.test(name);
    for (const address of addresses || []) {
      if (address.family !== "IPv4" || address.internal) continue;
      if (!isPrivateIPv4(address.address)) continue;
      const [a, b] = address.address.split(".").map(Number);
      let score = a === 192 && b === 168 ? 3 : a === 10 ? 2 : 1;
      if (virtual) score -= 10;
      candidates.push({ address: address.address, score });
    }
  }
  candidates.sort((x, y) => y.score - x.score);
  return candidates[0]?.address || "";
}

function isLoopback(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "0.0.0.0" || host === "::" || host === "::1") return true;
  if (/^0:0:0:0:0:0:0:1$/.test(host)) return true;
  if (host.startsWith("::ffff:")) return isLoopback(host.slice(7));
  return /^127\./.test(host);
}

export function publicBaseUrl(request: Request) {
  const configured = (process.env.APP_PUBLIC_URL || "").trim();
  if (configured) {
    // Khai thiếu scheme ("erp.cty.vn") thì QR mã hoá ra chuỗi không mở được — tự bù https://.
    const withScheme = /^https?:\/\//i.test(configured) ? configured : `https://${configured}`;
    return withScheme.replace(/\/+$/, "");
  }

  const requestUrl = new URL(request.url);
  // Qua nhiều tầng proxy, header thành "erp.cty.vn, 10.0.0.5" — chỉ lấy giá trị đầu, nếu không
  // URL sinh ra có dấu phẩy và mã QR hỏng.
  const firstValue = (value: string) => value.split(",")[0].trim();
  const forwardedHost = firstValue(request.headers.get("x-forwarded-host") || "");
  const host = forwardedHost || request.headers.get("host") || requestUrl.host;
  const protocol = firstValue(request.headers.get("x-forwarded-proto") || requestUrl.protocol.replace(":", "") || "http");

  const [hostname, port] = host.startsWith("[")
    ? [host.slice(0, host.indexOf("]") + 1), host.slice(host.indexOf("]") + 2)]
    : host.split(":");

  if (isLoopback(hostname)) {
    const lan = lanIPv4();
    if (lan) return `${protocol}://${lan}${port ? `:${port}` : ""}`;
  }
  return `${protocol}://${host}`;
}

/** Link công khai này có mở được từ máy khác không (dùng để cảnh báo trên giao diện). */
export function isReachableFromOtherDevices(url: string) {
  try {
    return !isLoopback(new URL(url).hostname);
  } catch {
    return false;
  }
}
