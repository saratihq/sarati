import WorkflowWorkspaceGate from "@/components/WorkflowWorkspaceGate";

// The redirect pages stay outside this group: a gate above them would turn their 307 into a 200.
export default async function WorkflowWorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <WorkflowWorkspaceGate workflowId={id}>{children}</WorkflowWorkspaceGate>;
}
