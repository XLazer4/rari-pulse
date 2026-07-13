import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "rari-pulse",
  description: "Rarible protocol activity across chains",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
