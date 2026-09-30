"use client";

import type { ReactNode } from "react";
import { DocumentTitle } from "./DocumentTitle";
import { ErrorBoundary } from "./ErrorBoundary";
import { ThemeProvider } from "./ThemeProvider";
import { Toaster } from "./ui/toast";

/** Client-side app shell mounted once in the root layout: theme, tab title, render-crash net, toast stack. */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <DocumentTitle />
      <ErrorBoundary>{children}</ErrorBoundary>
      <Toaster />
    </ThemeProvider>
  );
}
