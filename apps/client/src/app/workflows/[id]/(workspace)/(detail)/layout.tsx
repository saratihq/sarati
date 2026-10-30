"use client";

import Layout from "@/components/Layout";
import WorkflowDetail from "@/components/WorkflowDetail";

// Shell for a single workflow's tabs. A route group on purpose, so the standalone full-page routes
// (/edit, /compare) sit OUTSIDE it.
export default function WorkflowDetailLayout({ children }: { children: React.ReactNode }) {
  return (
    <Layout>
      <WorkflowDetail>{children}</WorkflowDetail>
    </Layout>
  );
}
