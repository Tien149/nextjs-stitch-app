import { redirect } from "next/navigation";

export default function BankStatementImportsPage() {
  redirect("/imports?tab=bank-statements");
}
