import type { Metadata } from "next";
import { merriweather } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Krzyżowa-Music — bilety",
  description: "Sprzedaż biletów na koncerty festiwalu Krzyżowa-Music",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="pl" className={merriweather.variable}>
      <body>{children}</body>
    </html>
  );
}
