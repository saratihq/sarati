"use client";

import SettingsPage from "@/components/SettingsPage";

// Global settings — auth is enforced by src/middleware.ts, so the page just renders.
export default function Page() {
  return <SettingsPage />;
}
