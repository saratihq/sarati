"use client";

import type { ReactNode } from "react";
import { ErrorBoundary } from "./ErrorBoundary";
import { ThemeProvider } from "./ThemeProvider";
import { Toaster } from "./ui/toast";

/** Client-side app shell mounted once in the root layout: theme, render-crash net, toast stack. */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <ErrorBoundary>{children}</ErrorBoundary>
      <Toaster />
    </ThemeProvider>
  );
}
