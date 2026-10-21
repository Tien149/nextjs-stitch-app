"use client";

/**
 * Ô nhập SỐ LƯỢNG có số lẻ (khách 21/10/2026: đặt hàng không gõ được 2,5 kg).
 *
 * `<input type="number">` trên điện thoại tiếng Việt cho gõ dấu phẩy nhưng trình duyệt coi "2,5" là
 * không hợp lệ và trả về chuỗi rỗng — số lượng mất trắng. Ô này là input text bàn phím số: nhận cả
 * phẩy lẫn chấm làm dấu thập phân, tối đa `decimals` chữ số sau dấu (mặc định 3). `value` trả ra
 * ngoài luôn dùng dấu chấm ("2.5") để Number() đọc được.
 */
type QuantityInputProps = {
  value: string;
  onChange: (value: string) => void;
  decimals?: number;
  className?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  title?: string;
};

export function normalizeQuantityInput(raw: string, decimals = 3) {
  const cleaned = raw.replace(/,/g, ".").replace(/[^\d.]/g, "");
  const [whole, ...rest] = cleaned.split(".");
  if (rest.length === 0) return whole;
  return `${whole || "0"}.${rest.join("").slice(0, decimals)}`;
}

export function QuantityInput({ value, onChange, decimals = 3, className = "", placeholder, required, disabled, ariaLabel, title }: QuantityInputProps) {
  return (
    <input
      type="text"
      inputMode="decimal"
      autoComplete="off"
      className={className}
      placeholder={placeholder}
      required={required}
      disabled={disabled}
      aria-label={ariaLabel}
      title={title}
      // Hiện dấu phẩy như cách người dùng gõ / đọc số lẻ ở Việt Nam.
      value={value.replace(".", ",")}
      onChange={(event) => onChange(normalizeQuantityInput(event.target.value, decimals))}
    />
  );
}
