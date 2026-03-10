import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Starcite Multi-Agent Viewer",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
