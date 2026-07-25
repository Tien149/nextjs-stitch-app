import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const [logo, branches] = await Promise.all([
    prisma.masterDataItem.findFirst({
      where: {
        type: "SYSTEM_PARAM",
        code: "APP_LOGO",
        status: "ACTIVE",
      },
    }),
    prisma.masterDataItem.findMany({
      where: {
        type: "BRANCH",
        status: "ACTIVE",
      },
      select: {
        code: true,
        name: true,
      },
      orderBy: {
        name: "asc",
      },
    }),
  ]);

  return NextResponse.json({
    name: logo?.name || "FIN ERP",
    subtitle: logo?.group || "Finance Suite",
    logoUrl: logo?.note || "",
    branches,
  });
}
