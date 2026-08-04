"use client";

import { createContext, useContext, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import * as api from "@/api/client";
import { Button } from "@/components/ui/button";
import InlineRename from "@/components/InlineRename";
import { toast } from "@/lib/toast";

// What the nested overview/settings pages read: workflow id + name, plus the setter.
export interface WorkflowOutletContext {
  workflowId: string;
  workflowName: string;
  setWorkflowName: (name: string) => void;
}

const WorkflowContext = createContext<WorkflowOutletContext | null>(null);

/** The enclosing WorkflowDetail's context — throws when used outside it. */
export function useWorkflowContext(): WorkflowOutletContext {
  const ctx = useContext(WorkflowContext);
  if (!ctx) {
    throw new Error("useWorkflowContext must be used within WorkflowDetail");
  }
  return ctx;
}

// A slim header row (back link + workflow name) above the routed page.
export default function WorkflowDetail({ children }: { children: React.ReactNode }) {
  const params = useParams();
  const id = params?.id ? String(params.id) : undefined;
  const router = useRouter();
  // Back always means one level up: sub-pages → the workflow, overview → the dashboard.
  const pathname = usePathname();
  const subPage = pathname?.endsWith("/runs") ? "Runs" : pathname?.endsWith("/settings") ? "Settings" : null;
  const [workflowName, setWorkflowName] = useState("...");
  const [lastId, setLastId] = useState(id);

  if (id !== lastId) {
    setLastId(id);
    setWorkflowName("...");
  }

  useEffect(() => {
    if (!id) return;
    api
      .getWorkflow(id)
      .then((wf) => {
        setWorkflowName(wf.name);
      })
      .catch(() => {
        // Say why before bouncing — a silent dump to the dashboard reads as a broken app.
        toast.error("Workflow not found", "It may have been deleted, or you don't have access.");
        router.push("/");
      });
  }, [id, router]);

  return (
    <main className="flex-1 overflow-y-auto py-6 px-8">
      <div className="max-w-[1100px] mx-auto">
        <div className="flex items-center gap-2 mb-5 min-w-0">
          <Button variant="ghost" size="sm" asChild>
            <Link href={subPage ? `/workflows/${id}/overview` : "/"}>
              <ArrowLeft size={13} />
              {subPage ? workflowName : "All workflows"}
            </Link>
          </Button>
          <span className="text-[13px]" style={{ color: "var(--orchestr-ink-faint)" }}>
            /
          </span>
          {subPage ? (
            <h1 className="text-[15px] font-semibold m-0 truncate" style={{ color: "var(--orchestr-ink)" }}>
              {subPage}
            </h1>
          ) : (
            <InlineRename
              workflowId={id}
              name={workflowName}
              canRename={workflowName !== "..."}
              onRenamed={setWorkflowName}
              textClassName="text-[15px] font-semibold m-0 truncate"
            />
          )}
        </div>
        <WorkflowContext.Provider value={{ workflowId: id ?? "", workflowName, setWorkflowName }}>
          {children}
        </WorkflowContext.Provider>
      </div>
    </main>
  );
}
