"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { canOpenPath, type DemoSession, SESSION_KEY } from "@/lib/auth-demo";

export function useModuleAuth(href: string) {
  const router = useRouter();
  const [user, setUser] = useState<DemoSession | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) {
      router.push(`/login?next=${encodeURIComponent(href)}`);
      return;
    }
    try {
      const session = JSON.parse(raw) as DemoSession;
      if (!canOpenPath(session, href)) {
        router.push("/");
        return;
      }
      window.setTimeout(() => {
        setUser(session);
        setLoading(false);
      }, 0);
    } catch {
      localStorage.removeItem(SESSION_KEY);
      router.push(`/login?next=${encodeURIComponent(href)}`);
    }
  }, [href, router]);

  return { user, loading, router };
}
