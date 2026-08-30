"use client";

import { useRef, useState } from "react";
import { exportTableToExcel } from "@/lib/export-table-excel";

/**
 * Nút "Xuất Excel" dùng chung cho mọi bảng dữ liệu. Đặt nút trong cùng <section> (hoặc khối
 * data-export-root) với bảng là đủ — nút tự tìm thẻ <table> gần nhất trong khối đó rồi xuất
 * đúng những dòng đang hiển thị. Trỏ targetId khi bảng nằm ngoài khối chứa nút.
 */
type ExportExcelButtonProps = {
  /** Tên file, không kèm ngày và đuôi file. */
  fileName: string;
  /** id của khối bao bảng hoặc của chính thẻ table; bỏ trống thì lấy [data-export-root]/section gần nhất. */
  targetId?: string;
  sheetName?: string;
  label?: string;
  className?: string;
  title?: string;
};

export default function ExportExcelButton({
  fileName,
  targetId,
  sheetName,
  label = "Xuất Excel",
  className,
  title,
}: ExportExcelButtonProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = async () => {
    const root = targetId ? document.getElementById(targetId) : buttonRef.current?.closest("[data-export-root], section");
    const table = root instanceof HTMLTableElement ? root : root?.querySelector("table") || null;
    if (!table) {
      window.alert("Không tìm thấy bảng dữ liệu để xuất.");
      return;
    }
    setIsExporting(true);
    try {
      const rowCount = await exportTableToExcel(table, { fileName, sheetName });
      if (rowCount === 0) window.alert("Bảng đang trống, chưa có dữ liệu để xuất.");
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Không xuất được file Excel");
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <button
      ref={buttonRef}
      type="button"
      data-no-export
      onClick={() => void handleExport()}
      disabled={isExporting}
      title={title || "Xuất đúng những dòng đang hiển thị ra file Excel"}
      className={
        className ||
        "bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-60 px-3 py-1.5 rounded-lg text-xs font-bold transition inline-flex items-center gap-1.5 shadow-sm"
      }
    >
      <span className="material-symbols-outlined text-[16px]">download</span>
      {isExporting ? "Đang xuất..." : label}
    </button>
  );
}
