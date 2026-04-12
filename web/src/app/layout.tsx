import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Analytics } from "@vercel/analytics/react";

export const viewport = {
  width: "device-width",
  initialScale: 1,
};

export const metadata: Metadata = {
  title: "FlightSnooper",
  description: "Snoop on your flight before you board. Look up any flight number to see historical performance, departure airport context, and arrival airport context — powered by Flightradar24.",
  openGraph: {
    title: "FlightSnooper",
    description: "Snoop on your flight before you board. Historical performance, airport context, and more — from a single flight number.",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "FlightSnooper",
    description: "Snoop on your flight before you board. Historical performance, airport context, and more — from a single flight number.",
  },
  robots: {
    index: false,
    follow: false,
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
