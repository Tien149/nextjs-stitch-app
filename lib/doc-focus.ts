/**
 * Màn đích của link chứng từ (/open/<mã> → ?tab=&code=&date=, khách 27/10/2026): đọc tham số trên
 * URL một lần lúc mở màn, rồi cuộn tới dòng mang `data-doc-code` đúng mã khi danh sách đã vẽ.
 */
export type DocFocus = { tab: string; code: string; date: string; branch: string };

export function readDocFocus(): DocFocus | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const code = (params.get("code") || "").trim();
  if (!code) return null;
  const date = (params.get("date") || "").trim();
  return { tab: (params.get("tab") || "").trim(), code, date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "", branch: (params.get("branch") || "").trim().toUpperCase() };
}

/** Cuộn tới dòng của phiếu (thử lại vài lần vì danh sách tải sau). */
export function scrollToDoc(code: string) {
  if (typeof window === "undefined" || !code) return;
  let tries = 0;
  const attempt = () => {
    const node = document.querySelector(`[data-doc-code="${CSS.escape(code)}"]`);
    if (node) {
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (++tries < 20) window.setTimeout(attempt, 300);
  };
  window.setTimeout(attempt, 300);
}

/** Lớp tô sáng dòng đang được trỏ tới. */
export const focusRowClass = "bg-amber-50 ring-2 ring-inset ring-amber-300";
