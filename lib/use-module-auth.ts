"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { appMenuItems, canAccessMenu, type DemoSession, SESSION_KEY } from "@/lib/auth-demo";

export function useModuleAuth(href: string) {
  const router = useRouter();
  const [user, setUser] = useState<DemoSession | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const raw = localStorage.getItem(SESSION_KEY);
    const menu = appMenuItems.find((item) => item.href === href);
    if (!raw) {
      router.push(`/login?next=${encodeURIComponent(href)}`);
      return;
    }
    try {
      const session = JSON.parse(raw) as DemoSession;
      if (!menu || !canAccessMenu(session.role, menu)) {
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
