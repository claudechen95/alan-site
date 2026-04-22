import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Alan's Check-ins",
  description: "Daily accountability tracker",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#f8f7f4]">{children}</body>
    </html>
  );
}
