"use client";

import OrganizationSettingsPage from "@/components/OrganizationSettingsPage";

// Organization settings — auth is enforced by src/middleware.ts, so the page just renders.
export default function Page() {
  return <OrganizationSettingsPage />;
}
