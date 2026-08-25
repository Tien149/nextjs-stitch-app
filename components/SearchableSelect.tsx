"use client";

import { useEffect, useRef, useState } from "react";

export type OptionItem = {
  value: string;
  label: string;
  subLabel?: string;
};

interface SearchableSelectProps {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  options: OptionItem[];
  placeholder?: string;
  searchPlaceholder?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
}

export function SearchableSelect({
  label,
  value,
  onChange,
  options,
  placeholder = "Chọn...",
  searchPlaceholder = "Gõ tên hoặc mã để tìm...",
  required,
  disabled,
  className = "",
}: SearchableSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const selectedOption = options.find((opt) => opt.value === value);

  const filteredOptions = options.filter((option) => {
    if (!search.trim()) return true;
    const term = search.toLowerCase();
    return (
      option.label.toLowerCase().includes(term) ||
      option.value.toLowerCase().includes(term) ||
      (option.subLabel && option.subLabel.toLowerCase().includes(term))
    );
  });

  // Close dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setSearch("");
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (!isOpen) return;
    const timer = window.setTimeout(() => {
      searchInputRef.current?.focus();
    }, 50);
    return () => window.clearTimeout(timer);
  }, [isOpen]);

  const handleSelect = (val: string) => {
    onChange(val);
    setIsOpen(false);
    setSearch("");
  };

  const toggleDropdown = () => {
    if (isOpen) setSearch("");
    setIsOpen((current) => !current);
  };

  return (
    <div className={`relative min-w-0 ${className}`} ref={containerRef}>
      {label && (
        <label className="text-xs font-bold text-slate-700 mb-1 block">
          {label}
          {required && <span className="text-red-500 ml-0.5">*</span>}
        </label>
      )}

      {/* Trigger Button */}
      <button
        type="button"
        disabled={disabled}
        onClick={toggleDropdown}
        className={`w-full min-h-[38px] px-3 py-2 text-left text-sm rounded-lg border transition-all duration-150 flex items-center justify-between gap-2 bg-white shadow-sm ${
          isOpen
            ? "border-blue-500 ring-2 ring-blue-100"
            : "border-slate-300 hover:border-slate-400"
        } ${disabled ? "bg-slate-100 cursor-not-allowed opacity-60" : "cursor-pointer"}`}
      >
        <span className={`block truncate font-medium ${selectedOption ? "text-slate-800" : "text-slate-400"}`}>
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <svg
          className={`w-4 h-4 text-slate-400 transition-transform duration-200 shrink-0 ${
            isOpen ? "rotate-180 text-blue-600" : ""
          }`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Popover Dropdown: panel rộng theo nội dung chứ không bó đúng bề ngang ô, vì ô hẹp
          thì tên đối tác dài bị xuống dòng từng ký tự. Không bao giờ hẹp hơn ô, không tràn màn hình. */}
      {isOpen && (
        <div className="absolute left-0 top-full mt-1.5 w-max min-w-full max-w-[min(24rem,calc(100vw-2rem))] bg-white border border-slate-200 rounded-xl shadow-2xl z-50 overflow-hidden animate-in fade-in-50 zoom-in-95 duration-100">
          {/* Search Box */}
          <div className="p-2 border-b border-slate-100 bg-slate-50/80 sticky top-0 z-10">
            <div className="relative">
              <svg
                className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
              <input
                ref={searchInputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={searchPlaceholder}
                className="w-full pl-8 pr-7 py-1.5 text-xs border border-slate-200 rounded-md bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 text-slate-800 placeholder-slate-400"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-0.5 text-xs"
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          {/* Options List */}
          <ul className="max-h-52 overflow-y-auto overscroll-contain py-1 text-sm divide-y divide-slate-50">
            {filteredOptions.length === 0 ? (
              <li className="px-3 py-4 text-xs text-center text-slate-400 italic">
                {options.length === 0 ? "Chưa có dữ liệu danh mục" : "Không tìm thấy kết quả phù hợp"}
              </li>
            ) : (
              filteredOptions.map((opt) => {
                const isSelected = opt.value === value;
                return (
                  <li key={opt.value}>
                    <button
                      type="button"
                      onClick={() => handleSelect(opt.value)}
                      className={`w-full text-left px-3 py-2.5 text-xs transition-colors flex items-center justify-between gap-3 ${
                        isSelected
                          ? "bg-blue-50 text-blue-700 font-semibold"
                          : "text-slate-700 hover:bg-slate-50 hover:text-slate-900"
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="font-medium whitespace-normal break-words leading-snug">
                          {opt.label}
                        </div>
                        {opt.subLabel && (
                          <div className="text-[11px] text-slate-400 font-normal mt-0.5 truncate">
                            {opt.subLabel}
                          </div>
                        )}
                      </div>
                      {isSelected && (
                        <svg className="w-4 h-4 text-blue-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
