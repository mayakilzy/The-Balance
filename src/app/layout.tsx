import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "الميزان — The Balance",
  description:
    "Global State Intelligence & State-Building Platform. GROUP 00 Foundation.",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <body className="min-h-screen">
        {children}
      </body>
    </html>
  );
}
