import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { AppProviders } from "@/components/AppProviders";
import { clerkEnabled, clerkPublishableKey } from "@/lib/config";
import "./globals.css";

// The only family the design system loads; globals.css sets it as the default body font.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Sarati",
  description: "Build-and-run automation platform with version control for your workflows.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // Headless Clerk only — the auth UI is hand-built; no Clerk-rendered components anywhere.
    <ClerkProvider
      publishableKey={clerkPublishableKey}
      afterSignOutUrl="/login"
      // Self-host runs with no Clerk at all (ADR 0054); the provider still mounts so Clerk's hooks
      // keep a context and report signed-out instead of throwing.
      __internal_bypassMissingPublishableKey={!clerkEnabled}
    >
      {/*
        No theme class here — ThemeProvider writes `.dark` onto <html> before first paint, and
        hardcoding it would pin every visitor to dark. That pre-hydration mutation is why
        `suppressHydrationWarning` is required.
      */}
      <html lang="en" className={inter.variable} suppressHydrationWarning>
        <body>
          <AppProviders>{children}</AppProviders>
        </body>
      </html>
    </ClerkProvider>
  );
}
