"use client";

import ImportUploadPage from "@/app/imports/ImportUploadPage";
import { importTabById } from "@/lib/import-tabs";

/**
 * Mục "Điều tiền" ở nhóm Tiền (khách 23/11/2026: "bốc ra từ import để vào mục này"). Đúng khung
 * import Điều tiền của màn Import dữ liệu — quyền vẫn theo Import dữ liệu như cũ.
 */
export default function MoneyTransfersPage() {
  const tab = importTabById("internal-transfer");
  if (!tab) return null;
  return (
    <ImportUploadPage
      title="Điều tiền"
      subtitle={tab.subtitle}
      menuHref="/imports"
      apiPath={tab.apiPath}
      templatePath={tab.templatePath}
      templateCode={tab.templateCode}
      primaryFields={tab.primaryFields}
      requiresBranch={tab.requiresBranch}
    />
  );
}
