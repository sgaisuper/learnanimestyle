import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Airi Paper Tutor",
  description: "Anime-style research paper tutor with transcript-driven lessons.",
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
