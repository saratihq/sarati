"use client";

import OidcCallback from "@/components/OidcCallback";

// Registered in every operator's identity provider as the redirect URI: renaming this route breaks sign-in.
export default function Page() {
  return <OidcCallback />;
}
