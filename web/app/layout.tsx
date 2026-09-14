import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Periscope — Below the surface",
  description: "Competitive intelligence beyond the initial page. Explore browser interactions, authorized sessions, and the evidence behind every recovered fact.",
  openGraph: { title: "Periscope — Below the surface", description: "Every research tool reads what websites serve. Periscope reads what they hide.", type: "website" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><head><link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous"/><link href="https://fonts.googleapis.com/css2?family=Roboto+Mono:wght@400;500&family=Sora:wght@400;500;600;700&display=swap" rel="stylesheet"/></head><body>{children}</body></html>;
}
