import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "The Balance — Foundation",
  description:
    "Global State Intelligence & State-Building Platform. GROUP 00 Foundation skeleton (mission 00-01).",
  robots: { index: false, follow: false }, // internal platform, not for indexing
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen flex flex-col">
        {children}
      </body>
    </html>
  );
}
