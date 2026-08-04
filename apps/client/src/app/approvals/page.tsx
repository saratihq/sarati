"use client";

// Global approvals inbox — every run waiting on a human, org-wide. Auth is enforced by middleware.
import Layout from "@/components/Layout";
import ApprovalsInboxPage from "@/components/ApprovalsInboxPage";

export default function Page() {
  return (
    <Layout>
      <ApprovalsInboxPage />
    </Layout>
  );
}
