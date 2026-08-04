"use client";

import SSOCallbackPage from "@/components/SSOCallbackPage";

// Public OAuth callback — middleware must keep /sso-callback unguarded.
export default function Page() {
  return <SSOCallbackPage />;
}
