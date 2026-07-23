import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const logo = await prisma.masterDataItem.findFirst({
    where: {
      type: "SYSTEM_PARAM",
      code: "APP_LOGO",
      status: "ACTIVE",
    },
  });

  return NextResponse.json({
    name: logo?.name || "FIN ERP",
    subtitle: logo?.group || "Finance Suite",
    logoUrl: logo?.note || "",
  });
}
