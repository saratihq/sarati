"use client";

import { useEffect, useRef, useState } from "react";
import * as api from "@/api/client";
import type { OrgSummary } from "@/api/client";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import { activeOrgOf, orgLabel, useOrgs } from "@/store/useOrgs";
import { SaratiLoader } from "./SaratiLogo";

const SWITCH_NOTE_KEY = "sarati:workspace-switch";

interface SwitchNote {
  workflowId: string;
  orgId: string;
}

async function workflowWorkspace(workflowId: string): Promise<{ org: OrgSummary; active: boolean } | null> {
  await useOrgs.getState().fetchOrgs();
  if (!useOrgs.getState().loaded) return null;
  let orgId: string | null | undefined;
  try {
    orgId = (await api.getWorkflow(workflowId)).org_id;
  } catch {
    return null; // the page's own load reports it
  }
  if (!orgId) return null;
  const find = () => useOrgs.getState().orgs.find((o) => o.id === orgId);
  let org = find();
  if (!org) {
    await useOrgs.getState().fetchOrgs({ force: true });
    org = find();
  }
  if (!org) return null;
  return { org, active: activeOrgOf(useOrgs.getState())?.id === org.id };
}

function takeSwitchNote(): Partial<SwitchNote> | null {
  try {
    const raw = window.sessionStorage.getItem(SWITCH_NOTE_KEY);
    window.sessionStorage.removeItem(SWITCH_NOTE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function leaveSwitchNote(note: SwitchNote): boolean {
  try {
    window.sessionStorage.setItem(SWITCH_NOTE_KEY, JSON.stringify(note));
    return true;
  } catch {
    return false;
  }
}

/** Holds a workflow's pages until it knows the workflow's workspace, switching to it when it is another of yours; opens them unswitched when it can't tell. */
export default function WorkflowWorkspaceGate({
  workflowId,
  children,
}: {
  workflowId: string;
  children: React.ReactNode;
}) {
  const [decision, setDecision] = useState<{ workflowId: string; stuckOn: OrgSummary | null } | null>(null);
  const taken = useRef<{ workflowId: string; note: Partial<SwitchNote> | null } | null>(null);

  useEffect(() => {
    // Taken as the check starts, so a check abandoned mid-way leaves no note behind; dev's re-run reuses it.
    if (taken.current?.workflowId !== workflowId) taken.current = { workflowId, note: takeSwitchNote() };
    const { note } = taken.current;
    let live = true;
    void workflowWorkspace(workflowId).then((entry) => {
      if (!live) return;
      const open = () => setDecision({ workflowId, stuckOn: null });
      if (!entry) return open();
      const noted = note?.workflowId === workflowId && note.orgId === entry.org.id;
      if (entry.active) {
        if (noted) toast.info(`Switched to ${orgLabel(entry.org)}`);
        return open();
      }
      const stuck = () => setDecision({ workflowId, stuckOn: entry.org });
      // The note is the loop guard: a reload that comes back still in the other workspace stops here.
      if (noted || !leaveSwitchNote({ workflowId, orgId: entry.org.id })) return stuck();
      try {
        useOrgs.getState().switchOrg(entry.org.id, { stay: true });
      } catch {
        takeSwitchNote();
        stuck();
      }
    });
    return () => {
      live = false;
    };
  }, [workflowId]);

  if (decision?.workflowId !== workflowId) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "var(--orchestr-surface)" }}>
        <SaratiLoader size={48} ariaLabel="Opening workflow" />
      </div>
    );
  }
  if (decision.stuckOn) {
    return (
      <div
        className="min-h-screen flex flex-col items-center justify-center gap-3 px-4 text-center"
        style={{ background: "var(--orchestr-surface)" }}
      >
        <h1 className="text-[15px] font-semibold m-0" style={{ color: "var(--orchestr-ink)" }}>
          {`Couldn't switch to ${orgLabel(decision.stuckOn)}`}
        </h1>
        <p className="text-[13px] m-0" style={{ color: "var(--orchestr-ink-muted)" }}>
          This workflow belongs to that workspace.
        </p>
        <Button variant="secondary" size="sm" className="mt-1" onClick={() => window.location.reload()}>
          Try again
        </Button>
      </div>
    );
  }
  return children;
}
