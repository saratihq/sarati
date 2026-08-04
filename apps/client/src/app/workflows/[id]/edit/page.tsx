"use client";

import WorkflowEditPage from "@/components/WorkflowEditPage";

// Route guard is handled by src/middleware.ts — the page just renders the screen.
export default function Page() {
  return <WorkflowEditPage />;
}
