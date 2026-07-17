import { redirect } from "next/navigation";

export default function RevenueImportsPage() {
  redirect("/imports?tab=revenue");
}
