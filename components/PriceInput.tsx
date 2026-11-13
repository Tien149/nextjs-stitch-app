"use client";

import { useEffect, useRef } from "react";

/**
 * Ô nhập ĐƠN GIÁ có phân cách hàng nghìn (khách 13/11/2026: "16000" khó đọc, muốn "16.000").
 *
 * Khác MoneyInput ở chỗ cho số lẻ: đơn giá theo ĐVT nhỏ (đ/GR) có thể lẻ tới 2 chữ số. Hiển thị
 * kiểu Việt Nam — dấu chấm phân cách nghìn, dấu PHẨY là thập phân ("1.234,5"); dấu chấm người
 * dùng gõ bị coi là phân cách nghìn nên bỏ qua. `value` trả ra ngoài là chuỗi số thô dùng dấu
 * chấm thập phân ("1234.5") như ô number cũ, form và API không phải đổi gì.
 */
type PriceInputProps = {
  value: string;
  onChange: (value: string) => void;
  decimals?: number;
  className?: string;
  placeholder?: string;
  ariaLabel?: string;
};

/** Chữ số và dấu phẩy thập phân — thứ con trỏ bám theo khi chuỗi được định dạng lại. */
const significant = (value: string) => value.replace(/[^\d,]/g, "");

/** Chuỗi đang hiện trên ô ("1.234,5") → chuỗi thô ("1234.5"). Giữ dấu chấm cuối khi vừa gõ phẩy. */
export function parsePriceInput(text: string, decimals = 2) {
  const [whole, ...rest] = text.replace(/\./g, "").split(",");
  const digits = whole.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  if (rest.length === 0) return digits;
  return `${digits || "0"}.${rest.join("").replace(/\D/g, "").slice(0, decimals)}`;
}

/** Chuỗi thô ("1234.5", "16000") → chuỗi hiển thị ("1.234,5", "16.000"). */
export function formatPriceInput(raw: string) {
  if (!raw) return "";
  const [whole, fraction] = raw.split(".");
  const digits = whole.replace(/\D/g, "");
  const grouped = digits ? new Intl.NumberFormat("vi-VN").format(Number(digits)) : "";
  return fraction === undefined ? grouped : `${grouped || "0"},${fraction}`;
}

function caretAfterSignificant(formatted: string, count: number) {
  if (count <= 0) return 0;
  let seen = 0;
  for (let index = 0; index < formatted.length; index += 1) {
    if (/[\d,]/.test(formatted[index])) {
      seen += 1;
      if (seen === count) return index + 1;
    }
  }
  return formatted.length;
}

export function PriceInput({ value, onChange, decimals = 2, className = "", placeholder, ariaLabel }: PriceInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const caretRef = useRef<number | null>(null);
  const formatted = formatPriceInput(value);

  useEffect(() => {
    const element = inputRef.current;
    const caret = caretRef.current;
    caretRef.current = null;
    if (!element || caret === null || document.activeElement !== element) return;
    const position = caretAfterSignificant(element.value, caret);
    element.setSelectionRange(position, position);
  }, [formatted]);

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      className={className}
      placeholder={placeholder}
      aria-label={ariaLabel}
      value={formatted}
      onChange={(event) => {
        const input = event.target;
        const caret = input.selectionStart ?? input.value.length;
        caretRef.current = significant(input.value.slice(0, caret)).length;
        onChange(parsePriceInput(input.value, decimals));
      }}
    />
  );
}
