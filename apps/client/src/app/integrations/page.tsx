"use client";

import { Suspense } from "react";
import IntegrationsPage from "@/components/IntegrationsPage";

// IntegrationsPage reads useSearchParams(), which Next requires a Suspense boundary around.
export default function Page() {
  return (
    <Suspense fallback={null}>
      <IntegrationsPage />
    </Suspense>
  );
}
