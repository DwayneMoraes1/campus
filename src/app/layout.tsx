import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Campus Hunt",
  description: "San José State University 3D Campus Map",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
