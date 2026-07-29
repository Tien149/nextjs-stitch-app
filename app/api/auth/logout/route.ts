import { NextResponse } from "next/server";
import { clearSessionCookie } from "@/lib/session-cookie";

// Cookie phiên là httpOnly nên JS phía client không xoá được, phải đi qua route này.
export async function POST() {
  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response);
  return response;
}
