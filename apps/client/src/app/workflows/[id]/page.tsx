import { redirect } from "next/navigation";

// The bare /workflows/:id index redirects to the one-page overview.
export default async function WorkflowIndexPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/workflows/${id}/overview`);
}
