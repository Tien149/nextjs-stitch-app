import { NextResponse } from "next/server";
import { clearSessionCookie } from "@/lib/session-cookie";
import { HRM_PROOF_COOKIE, HRM_PROOF_PATH } from "@/lib/hrm-sso";

// Cookie phiên là httpOnly nên JS phía client không xoá được, phải đi qua route này.
export async function POST() {
  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response);
  response.cookies.set({ name: HRM_PROOF_COOKIE, value: "", httpOnly: true, sameSite: "lax", path: HRM_PROOF_PATH, maxAge: 0 });
  return response;
}
