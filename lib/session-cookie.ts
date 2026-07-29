import type { NextResponse } from "next/server";
import { SESSION_KEY } from "@/lib/auth-demo";

// Tuổi thọ cookie phiên. Trước đây client tự đặt 1 giờ nên cookie chết trong khi
// localStorage vẫn còn, dẫn tới màn hình mở được nhưng mọi API trả 401.
// Nay chỉ server đặt cookie, mặc định 8 giờ (một ca làm việc), tick "ghi nhớ" thì 7 ngày.
export const SESSION_MAX_AGE_DEFAULT = 60 * 60 * 8;
export const SESSION_MAX_AGE_REMEMBER = 60 * 60 * 24 * 7;

// Không đặt cờ Secure: hệ thống đang chạy trên HTTP, bật Secure thì trình duyệt
// sẽ bỏ luôn cookie và không tài khoản nào gọi được API.
const baseCookieOptions = {
  name: SESSION_KEY,
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
};

export function setSessionCookie(response: NextResponse, value: string, rememberMe: boolean) {
  response.cookies.set({
    ...baseCookieOptions,
    value,
    maxAge: rememberMe ? SESSION_MAX_AGE_REMEMBER : SESSION_MAX_AGE_DEFAULT,
  });
}

export function clearSessionCookie(response: NextResponse) {
  response.cookies.set({
    ...baseCookieOptions,
    value: "",
    maxAge: 0,
  });
}
