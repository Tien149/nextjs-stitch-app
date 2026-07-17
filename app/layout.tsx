import type { Metadata } from "next";
import InputValidationGuard from "@/components/InputValidationGuard";
import "./globals.css";

export const metadata: Metadata = {
  title: "FIN ERP",
  description: "Hệ thống quản trị tài chính, POS và công nợ",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="vi" className="h-full antialiased" suppressHydrationWarning>
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-full flex flex-col bg-[#f1f5f9] text-[#171c1f]" suppressHydrationWarning>
        <InputValidationGuard />
        {children}
      </body>
    </html>
  );
}
