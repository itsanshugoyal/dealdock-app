import type { Metadata, Viewport } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { Shell } from "../components/shell";
import { ServiceWorkerRegistrar } from "../components/pwa";
import "./globals.css";

export const metadata: Metadata = {
  title: "DealDock",
  description: "Revenue recovery for Instagram-first commerce creators.",
  robots: { index: false, follow: false }, // product app — never indexed
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "DealDock" },
  icons: { icon: "/icons/icon-192.png", apple: "/icons/icon-192.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#050505",
};

const CLERK_ENABLED = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const body = (
    <html lang="en">
      <body>
        <ServiceWorkerRegistrar />
        <Shell>{children}</Shell>
      </body>
    </html>
  );

  // Keyless local dev runs without Clerk; keys in .env turn real auth on.
  return CLERK_ENABLED ? <ClerkProvider>{body}</ClerkProvider> : body;
}
