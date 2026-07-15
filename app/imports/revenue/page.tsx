import ImportUploadPage from "@/app/imports/ImportUploadPage";

export default function RevenueImportsPage() {
  return (
    <ImportUploadPage
      title="Import Doanh thu POS"
      subtitle="Giai đoạn 2 - Nhóm C 3.2: upload, preview và commit doanh thu bán hàng."
      menuHref="/imports/revenue"
      apiPath="/api/imports/revenue"
      templatePath="/templates/mau_doanh_thu_pos.xlsx"
      templateCode="REVENUE_POS_STANDARD_V1"
      primaryFields={[
        "sale_date",
        "branch_code",
        "channel",
        "payment_method",
        "gross_amount",
        "net_amount",
        "external_ref",
      ]}
    />
  );
}
