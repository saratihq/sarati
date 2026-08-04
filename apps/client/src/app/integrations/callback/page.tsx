"use client";

import { Suspense } from "react";
import IntegrationsCallback from "@/components/IntegrationsCallback";

// IntegrationsCallback reads useSearchParams(), which Next requires a Suspense boundary around.
export default function Page() {
  return (
    <Suspense fallback={null}>
      <IntegrationsCallback />
    </Suspense>
  );
}
