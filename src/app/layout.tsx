import type { Metadata } from "next";
import "./globals.css";
import { SiteNav } from "@/components/site-nav";

export const metadata: Metadata = {
  title: "TFM2 Tournament Realm",
  description: "Unofficial free-entry competitive tournament hub for Teamfight Manager 2.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <SiteNav />
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
