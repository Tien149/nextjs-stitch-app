import type { NextConfig } from "next";
import { networkInterfaces } from "os";

/**
 * IP LAN của chính máy đang chạy (192.168.x.x, 10.x.x.x...).
 *
 * Chế độ `next dev` CHẶN tài nguyên /_next/* nếu request đến từ origin khác localhost
 * (trả 403). Mở app bằng IP LAN trên điện thoại thì mọi file JS bị chặn -> trang hiện ra
 * nhưng đứng im ở chữ "Đang tải...", vì React không chạy được.
 *
 * Lấy IP động thay vì ghi cứng: đổi wifi hay chạy trên máy khác vẫn dùng được ngay,
 * không phải sửa lại tệp này. Chỉ ảnh hưởng lúc chạy dev; bản chạy thật không có giới hạn này.
 */
function lanHosts() {
  const hosts: string[] = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal) hosts.push(address.address);
    }
  }
  return hosts;
}

const nextConfig: NextConfig = {
  allowedDevOrigins: lanHosts(),
};

export default nextConfig;
