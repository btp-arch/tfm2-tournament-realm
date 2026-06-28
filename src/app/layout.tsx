import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import { ActiveActionBanner } from "@/components/active-action-banner";
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
        <ActiveActionBanner />
        <main className="container">{children}</main>
        <Analytics />
      </body>
    </html>
  );
}
