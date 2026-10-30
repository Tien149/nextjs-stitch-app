"use client";

import { useEffect, useRef, useState } from "react";

type BaseProps = {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  required?: boolean;
  disabled?: boolean;
  name?: string;
  id?: string;
  ariaLabel?: string;
};

type PickerMode = "date" | "month";

function validDate(year: number, month: number, day: number) {
  const value = new Date(year, month - 1, day);
  return value.getFullYear() === year && value.getMonth() === month - 1 && value.getDate() === day;
}

function parseDate(value: string) {
  const match = value.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  return year >= 1900 && year <= 2200 && validDate(year, month, day)
    ? `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
    : null;
}

function parseMonth(value: string) {
  const match = value.trim().match(/^(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const month = Number(match[1]);
  const year = Number(match[2]);
  return year >= 1900 && year <= 2200 && month >= 1 && month <= 12
    ? `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`
    : null;
}

function maskTypedValue(value: string, mode: PickerMode) {
  const digits = value.replace(/\D/g, "").slice(0, mode === "date" ? 8 : 6);
  if (mode === "month") {
    if (digits.length < 2) return digits;
    return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  }
  if (digits.length < 2) return digits;
  const day = digits.slice(0, 2);
  if (digits.length < 4) return `${day}/${digits.slice(2)}`;
  return `${day}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

function formatValue(value: string, mode: PickerMode) {
  if (!value) return "";
  if (mode === "month") {
    const match = value.match(/^(\d{4})-(\d{2})$/);
    return match ? `${match[2]}/${match[1]}` : maskTypedValue(value, mode);
  }
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : maskTypedValue(value, mode);
}

function DatePickerInput({ mode, value, onChange, className = "", required, disabled, name, id, ariaLabel }: BaseProps & { mode: PickerMode }) {
  const nativeRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLInputElement>(null);
  const focusedRef = useRef(false);
  const [draft, setDraft] = useState(() => formatValue(value, mode));
  const [touched, setTouched] = useState(false);
  const parse = mode === "date" ? parseDate : parseMonth;
  const parsedDraft = draft ? parse(draft) : null;
  const invalid = touched && Boolean(draft) && !parsedDraft;

  const updateTypedValue = (rawValue: string) => {
    const nextDraft = maskTypedValue(rawValue, mode);
    setDraft(nextDraft);
    setTouched(false);
    const nextValue = parse(nextDraft);
    if (nextValue) onChange(nextValue);
    else if (!nextDraft) onChange("");
  };

  useEffect(() => {
    if (focusedRef.current) return;
    const timer = window.setTimeout(() => setDraft(formatValue(value, mode)), 0);
    return () => window.clearTimeout(timer);
  }, [mode, value]);

  useEffect(() => {
    textRef.current?.setCustomValidity(draft && !parsedDraft
      ? mode === "date" ? "Ngày không hợp lệ. Nhập theo định dạng dd/mm/yyyy." : "Kỳ không hợp lệ. Nhập theo định dạng mm/yyyy."
      : "");
  }, [draft, mode, parsedDraft]);

  const openPicker = () => {
    if (disabled) return;
    const picker = nativeRef.current;
    if (!picker) return;
    try {
      picker.showPicker();
    } catch {
      picker.focus();
      picker.click();
    }
  };

  return (
    <div className={`date-control ${invalid ? "date-control-invalid" : ""} ${disabled ? "date-control-disabled" : ""} ${className}`}>
      <input
        ref={textRef}
        id={id}
        name={name}
        type="text"
        inputMode="numeric"
        maxLength={mode === "date" ? 10 : 7}
        autoComplete="off"
        value={draft}
        required={required}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={invalid}
        placeholder={mode === "date" ? "dd/mm/yyyy" : "mm/yyyy"}
        className="date-control-input"
        onFocus={() => { focusedRef.current = true; }}
        onBeforeInput={(event) => {
          const inserted = (event.nativeEvent as InputEvent).data;
          if (inserted && !/^[0-9/]+$/.test(inserted)) event.preventDefault();
        }}
        onPaste={(event) => {
          if (!/^[0-9/]+$/.test(event.clipboardData.getData("text"))) event.preventDefault();
        }}
        onKeyDown={(event) => {
          const cursor = event.currentTarget.selectionStart;
          if (event.key === "Backspace" && cursor === draft.length && draft.endsWith("/")) {
            event.preventDefault();
            updateTypedValue(draft.replace(/\D/g, "").slice(0, -1));
          }
        }}
        onChange={(event) => updateTypedValue(event.target.value)}
        onBlur={() => {
          focusedRef.current = false;
          setTouched(true);
          const nextValue = parse(draft);
          if (nextValue) {
            onChange(nextValue);
            setDraft(formatValue(nextValue, mode));
            setTouched(false);
          }
        }}
      />
      <button type="button" onClick={openPicker} disabled={disabled} className="date-control-button" title={mode === "date" ? "Chọn ngày" : "Chọn tháng"} aria-label={mode === "date" ? "Mở lịch chọn ngày" : "Mở lịch chọn tháng"}>
        <span className="material-symbols-outlined text-[19px]">calendar_month</span>
      </button>
      <input
        ref={nativeRef}
        type={mode}
        value={value}
        disabled={disabled}
        tabIndex={-1}
        aria-hidden="true"
        className="pointer-events-none absolute right-1 top-1/2 h-8 w-8 -translate-y-1/2 opacity-0"
        onChange={(event) => {
          onChange(event.target.value);
          setDraft(formatValue(event.target.value, mode));
          setTouched(false);
        }}
      />
    </div>
  );
}

export function DateInput(props: BaseProps) {
  return <DatePickerInput {...props} mode="date" />;
}

export function MonthInput(props: BaseProps) {
  return <DatePickerInput {...props} mode="month" />;
}

/**
 * Ngày + giờ ("YYYY-MM-DDTHH:mm", cùng giá trị với input datetime-local) nhưng ngày hiện dd/mm/yyyy
 * — datetime-local trên điện thoại tiếng Anh ra tháng/ngày/năm (khách 24/10/2026).
 */
export function DateTimeInput({ value, onChange, className = "", ariaLabel }: { value: string; onChange: (value: string) => void; className?: string; ariaLabel?: string }) {
  const [day = "", time = ""] = (value || "").split("T");
  return (
    <div className={`flex gap-2 ${className}`}>
      <DateInput className="min-w-0 flex-1" value={day} onChange={(nextDay) => onChange(nextDay ? `${nextDay}T${time || "00:00"}` : "")} ariaLabel={ariaLabel ? `${ariaLabel} — ngày` : undefined} />
      <input type="time" className="control !mt-0 w-28" value={time.slice(0, 5)} aria-label={ariaLabel ? `${ariaLabel} — giờ` : undefined}
        onChange={(event) => onChange(`${day || new Date().toISOString().slice(0, 10)}T${event.target.value || "00:00"}`)} />
    </div>
  );
}

/**
 * Ô ngày + ô giờ của bộ lọc khoảng thời gian (khách 30/10/2026: lọc báo cáo / phiếu kho theo giờ để
 * khớp giờ chốt kiểm kê). Giờ để trống = cả ngày (lib/date-range vnRangeBounds).
 */
export function DateWithTimeInput({ date, time, onDate, onTime, ariaLabel }: { date: string; time: string; onDate: (value: string) => void; onTime: (value: string) => void; ariaLabel?: string }) {
  return (
    // Ô hẹp (điện thoại, lưới nhiều cột) thì ô giờ xuống dòng dưới ô ngày thay vì bóp nhỏ ô ngày.
    <div className="flex flex-wrap gap-2">
      <DateInput className="control min-w-[8.5rem] flex-1" value={date} onChange={onDate} ariaLabel={ariaLabel} />
      <input
        type="time"
        className="control w-28 shrink-0 grow basis-24"
        value={time}
        aria-label={ariaLabel ? `Giờ — ${ariaLabel}` : "Giờ"}
        title="Giờ (để trống = cả ngày)"
        onChange={(event) => onTime(event.target.value)}
      />
    </div>
  );
}
