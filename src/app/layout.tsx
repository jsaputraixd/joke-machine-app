import type { Metadata } from "next";
import { Space_Mono, Inter } from "next/font/google";
import "./globals.css";

const spaceMono = Space_Mono({
  variable: "--font-hud",
  weight: ["400", "700"],
  subsets: ["latin"],
});

const inter = Inter({
  variable: "--font-body",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Joke Machine — Dad-Bot",
  description: "A talking joke machine with a face. Press a button, it tells you a joke.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${spaceMono.variable} ${inter.variable}`}>
      <body>{children}</body>
    </html>
  );
}
