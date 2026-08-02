"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Hiển thị một giá trị định danh (mã phiếu, mã danh mục, MST, số tài khoản...)
 * và cho phép copy chỉ bằng một cú nhấp chuột.
 *
 * Vẫn giữ được thao tác bôi đen thủ công: nếu người dùng đang bôi đen một phần
 * giá trị thì không copy đè lên vùng chọn đó.
 */
export default function CopyableText({
  value,
  children,
  className = "",
  title,
}: {
  value?: string | null;
  children?: React.ReactNode;
  className?: string;
  title?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, []);

  const text = (value ?? "").toString().trim();
  if (!text) return <>{children ?? value ?? ""}</>;

  const copy = async () => {
    // Người dùng đang chủ động bôi đen -> tôn trọng vùng chọn, không copy cả ô.
    if (window.getSelection()?.toString()) return;

    // Clipboard API có thể tồn tại nhưng vẫn từ chối (trang chạy HTTP nội bộ, nhúng
    // trong iframe, hoặc tab mất focus) nên phải thử tiếp cách cũ thay vì bỏ cuộc.
    let done = false;
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        done = true;
      } catch {
        done = false;
      }
    }

    if (!done) {
      try {
        const helper = document.createElement("textarea");
        helper.value = text;
        helper.setAttribute("readonly", "");
        helper.style.position = "fixed";
        helper.style.top = "0";
        helper.style.opacity = "0";
        document.body.appendChild(helper);
        helper.select();
        done = document.execCommand("copy");
        document.body.removeChild(helper);
      } catch {
        done = false;
      }
    }

    if (!done) return; // Không báo "Đã copy" khi thực tế chưa copy được.
    setCopied(true);
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <span
      role="button"
      tabIndex={0}
      onClick={copy}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          void copy();
        }
      }}
      title={title || `Nhấp để copy: ${text}`}
      aria-label={`Copy ${text}`}
      className={`copyable ${copied ? "copyable-done" : ""} ${className}`}
    >
      {children ?? text}
      <span className="copyable-flag" aria-hidden={!copied}>
        {copied ? "Đã copy" : ""}
      </span>
    </span>
  );
}
