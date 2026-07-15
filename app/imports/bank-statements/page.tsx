import ImportUploadPage from "@/app/imports/ImportUploadPage";

export default function BankStatementImportsPage() {
  return (
    <ImportUploadPage
      title="Import Sao kê Ngân hàng"
      subtitle="Giai đoạn 2 - Nhóm C 3.1: upload, preview và commit giao dịch ngân hàng."
      menuHref="/imports/bank-statements"
      apiPath="/api/imports/bank-statements"
      templatePath="/templates/mau_sao_ke_ngan_hang.xlsx"
      templateCode="BANK_STATEMENT_STANDARD_V1"
      primaryFields={[
        "transaction_date",
        "bank_account",
        "transaction_code",
        "description",
        "debit_amount",
        "credit_amount",
      ]}
    />
  );
}
