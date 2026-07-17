import { redirect } from "next/navigation";

export default function PayrollImportsPage() {
  redirect("/imports?tab=payroll");
}
