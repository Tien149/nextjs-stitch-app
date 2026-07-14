import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FIN-ERP Executive Dashboard",
  description: "Hệ thống quản trị tài chính doanh nghiệp thông minh",
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
        {children}
      </body>
    </html>
  );
}
