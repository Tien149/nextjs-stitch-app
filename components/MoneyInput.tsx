"use client";

import { useEffect, useRef } from "react";

/**
 * Ô nhập số tiền có phân cách hàng nghìn ngay trong lúc gõ.
 *
 * `<input type="number">` không hiển thị được dấu phân cách nên "24000000" đọc bằng mắt rất
 * dễ đếm nhầm một chữ số — đúng lỗi hay gặp khi nhập phiếu chi. Ô này là input text, hiện
 * "24.000.000" theo đúng cách mọi bảng trong app đang in tiền, nhưng `value` trả ra ngoài
 * vẫn là chuỗi số thô để form và API không phải biết gì về định dạng.
 *
 * Con trỏ được đặt lại theo số CHỮ SỐ đứng trước nó, không theo vị trí ký tự: chèn thêm một
 * dấu chấm vào giữa chuỗi mà giữ nguyên vị trí ký tự sẽ làm con trỏ lùi một bậc mỗi lần
 * qua mốc hàng nghìn. Việc đặt lại nằm trong effect vì phải đợi React vẽ xong chuỗi mới.
 */

type MoneyInputProps = {
  /** Chuỗi số thô, ví dụ "2500000". Rỗng nghĩa là chưa nhập. */
  value: string;
  onChange: (value: string) => void;
  className?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  name?: string;
  id?: string;
  ariaLabel?: string;
};

const digitsOf = (value: string) => value.replace(/\D/g, "");

/** "2500000" -> "2.500.000". Bỏ số 0 vô nghĩa ở đầu để "0100" không thành "0.100". */
export function formatMoneyInput(value: string) {
  const digits = digitsOf(value).replace(/^0+(?=\d)/, "");
  if (!digits) return "";
  return new Intl.NumberFormat("vi-VN").format(Number(digits));
}

/** Vị trí ký tự nằm ngay sau chữ số thứ `digitCount` của chuỗi đã format. */
function caretAfterDigits(formatted: string, digitCount: number) {
  if (digitCount <= 0) return 0;
  let seen = 0;
  for (let index = 0; index < formatted.length; index += 1) {
    if (/\d/.test(formatted[index])) {
      seen += 1;
      if (seen === digitCount) return index + 1;
    }
  }
  return formatted.length;
}

export function MoneyInput({
  value,
  onChange,
  className = "",
  placeholder,
  required,
  disabled,
  readOnly,
  name,
  id,
  ariaLabel,
}: MoneyInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  /** Số chữ số đứng trước con trỏ ở lần gõ vừa rồi; null nghĩa là giá trị đổi từ bên ngoài. */
  const caretDigitsRef = useRef<number | null>(null);

  const formatted = formatMoneyInput(value);

  useEffect(() => {
    const element = inputRef.current;
    const caretDigits = caretDigitsRef.current;
    caretDigitsRef.current = null;
    if (!element || caretDigits === null || document.activeElement !== element) return;
    const position = caretAfterDigits(element.value, caretDigits);
    element.setSelectionRange(position, position);
  }, [formatted]);

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    const caret = input.selectionStart ?? input.value.length;
    caretDigitsRef.current = digitsOf(input.value.slice(0, caret)).length;
    onChange(digitsOf(input.value).replace(/^0+(?=\d)/, ""));
  };

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      value={formatted}
      onChange={handleChange}
      className={className}
      placeholder={placeholder}
      required={required}
      disabled={disabled}
      readOnly={readOnly}
      name={name}
      id={id}
      aria-label={ariaLabel}
    />
  );
}
