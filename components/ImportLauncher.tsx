"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ImportUploadPage from "@/app/imports/ImportUploadPage";
import { SESSION_KEY, type DemoSession } from "@/lib/auth-demo";
import { masterTypeLabels, permittedImportTabs, type ImportTab } from "@/lib/import-tabs";

/**
 * Nút "Import Excel" đặt ngay trên màn nghiệp vụ (khách 23/11/2026: bỏ tab Import riêng). Bấm là
 * mở khung import nổi phủ lên màn, Đóng là quay lại đúng chỗ đang làm.
 *
 * Quyền giữ nguyên như màn Import dữ liệu cũ: vai trò phải được tick "Import dữ liệu" trong
 * Phân quyền VÀ được loại import đó (lib/import-tabs.ts). Không đủ quyền thì nút không hiện.
 *
 * Link cũ "/imports?tab=..." được chuyển về màn nghiệp vụ kèm "?import=<loại>" — nút nào nhận
 * loại đó thì tự mở khung.
 */
export function ImportLauncher({ tabIds, autoOpenTabIds = [], masterType = "", onClosed, label = "Import Excel", compact = false }: {
  tabIds: string[];
  /** Loại import không có nút ở trạng thái hiện tại của màn nhưng link cũ vẫn được mở thẳng. */
  autoOpenTabIds?: string[];
  /** Import danh mục hệ thống: loại danh mục đang xem ở màn Cấu hình danh mục. */
  masterType?: string;
  /** Gọi khi đóng khung — màn nghiệp vụ tải lại số liệu sau khi import. */
  onClosed?: () => void;
  label?: string;
  compact?: boolean;
}) {
  const [tabs, setTabs] = useState<ImportTab[]>([]);
  const [open, setOpen] = useState<ImportTab | null>(null);
  const [picking, setPicking] = useState(false);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const tabKey = tabIds.join(",");
  const autoKey = autoOpenTabIds.join(",");

  useEffect(() => {
    let session: DemoSession | null = null;
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      session = raw ? (JSON.parse(raw) as DemoSession) : null;
    } catch {
      session = null;
    }
    const permitted = permittedImportTabs(session);
    const allowed = permitted.filter((tab) => tabKey.split(",").includes(tab.id));
    const params = new URLSearchParams(window.location.search);
    const requested = params.get("import") || "";
    const autoOpen = permitted.find((tab) => tab.id === requested && [...tabKey.split(","), ...autoKey.split(",")].includes(tab.id)) || null;
    if (autoOpen) {
      params.delete("import");
      const query = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
    }
    const timer = window.setTimeout(() => {
      setTabs(allowed);
      if (autoOpen) setOpen(autoOpen);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [tabKey, autoKey]);

  // Khung đang mở: khoá cuộn nền để chỉ cuộn trong khung.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  useEffect(() => {
    if (!picking) return;
    const close = (event: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) setPicking(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [picking]);

  if (tabs.length === 0 && !open) return null;

  const close = () => {
    setOpen(null);
    onClosed?.();
  };
  const buttonClass = `inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-blue-200 bg-blue-50 font-bold text-blue-700 shadow-sm hover:bg-blue-100 ${compact ? "h-8 px-2.5 text-xs" : "h-9 px-3 text-sm"}`;

  return (
    <div ref={pickerRef} className="relative inline-block" data-no-export>
      {tabs.length > 0 && <button
        type="button"
        className={buttonClass}
        onClick={() => (tabs.length === 1 ? setOpen(tabs[0]) : setPicking((value) => !value))}
        title={tabs.length === 1 ? tabs[0].title : "Chọn loại file cần import"}
      >
        <span className="material-symbols-outlined text-base">upload_file</span>
        {label}
        {tabs.length > 1 && <span className="material-symbols-outlined text-base">expand_more</span>}
      </button>}
      {picking && (
        <div className="absolute right-0 z-40 mt-1 w-64 rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm font-medium text-slate-700 hover:bg-slate-50"
              onClick={() => {
                setPicking(false);
                setOpen(tab);
              }}
            >
              <span className="material-symbols-outlined text-lg text-blue-600">{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </div>
      )}
      {/* Portal ra body: màn cha hay có backdrop-blur/transform, khi đó "fixed" bám theo khối cha
          chứ không phủ cả màn hình. */}
      {open && createPortal(
        // Sự kiện React vẫn nổi qua portal lên cây cha: nút đặt trong <form> của màn (VD form kiểm kê
        // tài sản) thì submit trong khung import sẽ chạy luôn onSubmit của form đó. Chặn submit tại đây
        // (không chặn click/mousedown: dropdown trong khung cần nghe mousedown ở document).
        <div
          className="fixed inset-0 z-[45] overflow-y-auto bg-slate-100 lg:left-64"
          role="dialog"
          aria-modal="true"
          aria-label={open.title}
          onSubmit={(event) => event.stopPropagation()}
        >
          <ImportUploadPage
            key={open.id}
            title={open.title}
            subtitle={open.id === "master-data" && masterTypeLabels[masterType.toUpperCase()]
              ? `${open.subtitle} Đang import danh mục ${masterTypeLabels[masterType.toUpperCase()]}: cột "Loại danh mục" của mọi dòng phải điền ${masterType.toUpperCase()}.`
              : open.subtitle}
            menuHref="/imports"
            apiPath={open.apiPath}
            templatePath={open.templatePath}
            templateCode={open.templateCode}
            primaryFields={open.primaryFields}
            requiresBranch={open.requiresBranch}
            expectedMasterType={open.id === "master-data" ? masterType.toUpperCase() : ""}
            onClose={close}
          />
        </div>,
        document.body,
      )}
    </div>
  );
}
