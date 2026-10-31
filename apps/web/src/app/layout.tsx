import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { ClerkProvider } from "@clerk/nextjs";
import { Shell } from "../components/shell";
import { ServiceWorkerRegistrar } from "../components/pwa";
import { AuthSession } from "../components/auth-session";
import { LocalAuthSession } from "../components/local-auth-session";
import { THEME_BOOT_SCRIPT } from "../lib/theme-script";
import "./globals.css";

// All three families are OFL and self-hosted (licences beside the files); no runtime font CDN.
const geistSans = localFont({
  src: "./fonts/Geist-Variable.woff2",
  weight: "100 900",
  variable: "--font-geist-sans",
  display: "swap",
});
const geistMono = localFont({
  src: "./fonts/GeistMono-Variable.woff2",
  weight: "100 900",
  variable: "--font-geist-mono",
  display: "swap",
  adjustFontFallback: false,
});
// Devanagari fallback: unicode-range keeps it off the wire until Devanagari text appears.
const notoDevanagari = localFont({
  src: [
    { path: "./fonts/NotoSansDevanagari-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/NotoSansDevanagari-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/NotoSansDevanagari-600.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-noto-devanagari",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: "unicode-range", value: "U+0900-097F, U+1CD0-1CFF, U+A8E0-A8FF" }],
});

export const metadata: Metadata = {
  title: "DealDock",
  description: "Find the money in your Instagram DMs and reply in your own voice.",
  robots: { index: false, follow: false }, // product app — never indexed
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "DealDock" },
  icons: { icon: "/icons/icon-192.png", apple: "/icons/icon-192.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F3F3F6" },
    { media: "(prefers-color-scheme: dark)", color: "#09090B" },
  ],
};

// ClerkProvider is a RENDERING concern (it powers client hooks / <SignedIn>),
// NOT the request-level auth gate — that's middleware.ts, which fails closed on
// the explicit DEALDOCK_DISABLE_AUTH flag (F7). Here we only need the provider
// when a publishable key actually exists, so keyless dev/CI builds still
// prerender. If a real deploy somehow lacks the key, the middleware still
// blocks every request before any page renders, so this stays safe.
const CLERK_KEY_PRESENT = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
const LOCAL_INTEGRATION = process.env.NODE_ENV === "development" && process.env.DEALDOCK_DISABLE_AUTH === "true" && Boolean(process.env.DEALDOCK_DEV_ORG_ID && process.env.DEALDOCK_API_URL);

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const content = (
    <>
        <ServiceWorkerRegistrar />
        <Shell>{children}</Shell>
    </>
  );
  const authenticated = LOCAL_INTEGRATION ? <LocalAuthSession>{content}</LocalAuthSession> : CLERK_KEY_PRESENT ? <ClerkProvider><AuthSession>{content}</AuthSession></ClerkProvider> : content;
  const fonts = `${geistSans.variable} ${geistMono.variable} ${notoDevanagari.variable}`;
  // The boot script stamps data-theme before first paint, so the attribute differs from the server HTML.
  return (
    <html lang="en" className={fonts} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>{authenticated}</body>
    </html>
  );
}
