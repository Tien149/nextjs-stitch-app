"use client";

import { useEffect } from "react";

type InputKind = "code" | "phone" | "tax-code" | "account-number" | "email";

const rules: Record<InputKind, { allowed: RegExp; pattern: string; message: string; maxLength: number }> = {
  code: { allowed: /^[A-Za-z0-9._-]*$/, pattern: "[A-Za-z0-9._-]+", message: "Mã chỉ được gồm chữ không dấu, số, dấu chấm, gạch ngang hoặc gạch dưới.", maxLength: 50 },
  phone: { allowed: /^\+?[0-9 ]*$/, pattern: "\\+?[0-9 ]{8,16}", message: "Số điện thoại chỉ được gồm dấu + và 8-16 chữ số.", maxLength: 17 },
  "tax-code": { allowed: /^[0-9-]*$/, pattern: "[0-9-]{10,15}", message: "Mã số thuế chỉ được gồm 10-14 chữ số và dấu gạch ngang.", maxLength: 15 },
  "account-number": { allowed: /^[0-9]*$/, pattern: "[0-9]{4,30}", message: "Số tài khoản chỉ được gồm 4-30 chữ số.", maxLength: 30 },
  email: { allowed: /^\S*$/, pattern: "[^\\s@]+@[^\\s@]+\\.[^\\s@]+", message: "Email không đúng định dạng.", maxLength: 120 },
};

function prospectiveValue(input: HTMLInputElement, inserted: string) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  return input.value.slice(0, start) + inserted + input.value.slice(end);
}

function acceptsNumber(input: HTMLInputElement, value: string) {
  if (!value) return true;
  const decimalAllowed = input.step === "any" || input.step.includes(".");
  return decimalAllowed ? /^\d*(\.\d*)?$/.test(value) : /^\d*$/.test(value);
}

export default function InputValidationGuard() {
  useEffect(() => {
    const prepare = (input: HTMLInputElement) => {
      if (input.type === "number" && !input.hasAttribute("min")) input.min = "0";
      const kind = input.dataset.inputKind as InputKind | undefined;
      if (!kind || !rules[kind]) return;
      input.pattern = rules[kind].pattern;
      input.maxLength = rules[kind].maxLength;
      if (kind === "phone") input.inputMode = "tel";
      if (["tax-code", "account-number"].includes(kind)) input.inputMode = "numeric";
      if (kind === "email") input.type = "email";
    };

    const isAccepted = (input: HTMLInputElement, nextValue: string) => {
      if (input.type === "number") return acceptsNumber(input, nextValue);
      const kind = input.dataset.inputKind as InputKind | undefined;
      return !kind || !rules[kind] || rules[kind].allowed.test(nextValue);
    };

    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof HTMLInputElement) prepare(event.target);
    };
    const onBeforeInput = (event: InputEvent) => {
      if (!(event.target instanceof HTMLInputElement) || event.data === null) return;
      const input = event.target;
      prepare(input);
      if (!isAccepted(input, prospectiveValue(input, event.data))) event.preventDefault();
    };
    const onPaste = (event: ClipboardEvent) => {
      if (!(event.target instanceof HTMLInputElement)) return;
      const input = event.target;
      prepare(input);
      const pasted = event.clipboardData?.getData("text") || "";
      if (!isAccepted(input, prospectiveValue(input, pasted))) event.preventDefault();
    };
    const onInput = (event: Event) => {
      if (!(event.target instanceof HTMLInputElement)) return;
      const input = event.target;
      prepare(input);
      input.setCustomValidity("");
      if (!isAccepted(input, input.value)) input.setCustomValidity("Dữ liệu không đúng định dạng của trường này.");
    };
    const onInvalid = (event: Event) => {
      if (!(event.target instanceof HTMLInputElement)) return;
      const input = event.target;
      const kind = input.dataset.inputKind as InputKind | undefined;
      if (kind && rules[kind] && input.validity.patternMismatch) input.setCustomValidity(rules[kind].message);
      else if (input.type === "number" && (input.validity.badInput || input.validity.rangeUnderflow)) input.setCustomValidity("Vui lòng nhập số không âm đúng định dạng.");
    };

    document.addEventListener("focusin", onFocus, true);
    document.addEventListener("beforeinput", onBeforeInput, true);
    document.addEventListener("paste", onPaste, true);
    document.addEventListener("input", onInput, true);
    document.addEventListener("invalid", onInvalid, true);
    return () => {
      document.removeEventListener("focusin", onFocus, true);
      document.removeEventListener("beforeinput", onBeforeInput, true);
      document.removeEventListener("paste", onPaste, true);
      document.removeEventListener("input", onInput, true);
      document.removeEventListener("invalid", onInvalid, true);
    };
  }, []);

  return null;
}
