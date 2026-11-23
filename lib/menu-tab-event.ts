import { useEffect, useRef } from "react";

/**
 * Bấm mục menu trỏ vào một tab của CHÍNH trang đang mở (ví dụ đang ở "Sổ quỹ" bấm "Trích trước &
 * Phân bổ" — cùng /finance-operations, khác ?tab=): Next chỉ đổi URL chứ không dựng lại trang,
 * mà trang chỉ đọc ?tab= lúc mở, nên màn đứng yên. Sidebar phát sự kiện này, trang nghe để đổi tab.
 */
const MENU_TAB_EVENT = "app:menu-tab";

export function announceMenuTab(path: string, tab: string) {
  window.dispatchEvent(new CustomEvent(MENU_TAB_EVENT, { detail: { path, tab } }));
}

export function useMenuTab(path: string, onTab: (tab: string) => void) {
  const handler = useRef(onTab);
  useEffect(() => {
    handler.current = onTab;
  });
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ path?: string; tab?: string }>).detail;
      if (detail?.path === path && detail.tab) handler.current(detail.tab);
    };
    window.addEventListener(MENU_TAB_EVENT, listener);
    return () => window.removeEventListener(MENU_TAB_EVENT, listener);
  }, [path]);
}
