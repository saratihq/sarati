"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import * as api from "@/api/client";
import { useWorkflowContext } from "./WorkflowDetail";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { toast } from "@/lib/toast";
import { useDocumentTitle } from "@/lib/useDocumentTitle";

export default function WorkflowSettingsPage() {
  useDocumentTitle("Workflow settings");
  const { workflowId, workflowName, setWorkflowName } = useWorkflowContext();
  const router = useRouter();

  const [name, setName] = useState(workflowName);
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    api
      .getWorkflow(workflowId)
      .then((wf) => {
        setName(wf.name);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load workflow"));
  }, [workflowId]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updateWorkflow(workflowId, {
        name: name || undefined,
        description: description || undefined,
      });
      setWorkflowName(updated.name);
      toast.success("Settings saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setConfirmingDelete(false);
    try {
      await api.deleteWorkflow(workflowId);
      toast.success(`Workflow "${name || workflowName}" deleted`);
      router.push("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete");
    }
  };

  return (
    <div>
      <h2 className="text-[18px] font-semibold text-[var(--orchestr-ink)] m-0 mb-6">Workflow settings</h2>

      {error && (
        <div
          className="py-2 px-4 rounded-lg text-[11px] mb-4"
          style={{ background: "var(--orchestr-danger-tint)", color: "var(--orchestr-danger)" }}
        >
          {error}
        </div>
      )}

      {/* Metadata */}
      <section
        className="rounded-lg p-5 mb-6"
        style={{ background: "var(--orchestr-surface-card)", border: "1px solid var(--orchestr-line)" }}
      >
        <h3 className="text-[13px] font-semibold m-0 mb-4" style={{ color: "var(--orchestr-ink-muted)" }}>
          General
        </h3>
        <div className="space-y-4">
          <div>
            <label className="block text-[11px] mb-1.5" style={{ color: "var(--orchestr-ink-muted)" }}>
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full py-2 px-3 rounded-lg text-[13px] outline-none"
              style={{
                color: "var(--orchestr-ink)",
                background: "var(--orchestr-surface-raised)",
                border: "1px solid var(--orchestr-line)",
              }}
            />
          </div>
          <div>
            <label className="block text-[11px] mb-1.5" style={{ color: "var(--orchestr-ink-muted)" }}>
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Optional description..."
              className="w-full py-2 px-3 rounded-lg text-[13px] outline-none resize-none"
              style={{
                color: "var(--orchestr-ink)",
                background: "var(--orchestr-surface-raised)",
                border: "1px solid var(--orchestr-line)",
              }}
            />
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? "Saving..." : "Save changes"}
            </Button>
          </div>
        </div>
      </section>

      {/* Danger zone */}
      <section
        className="rounded-lg p-5"
        style={{ background: "var(--orchestr-danger-tint)", border: "1px solid var(--orchestr-danger-tint)" }}
      >
        <h3 className="text-[13px] font-semibold text-[var(--orchestr-danger)] m-0 mb-3">Danger zone</h3>
        <p className="text-[11px] mb-3" style={{ color: "var(--orchestr-ink-subtle)" }}>
          Permanently delete this workflow and all its versions, branches, and reviews.
        </p>
        <Button variant="destructive" onClick={() => setConfirmingDelete(true)}>
          Delete workflow
        </Button>
      </section>

      <ConfirmDialog
        open={confirmingDelete}
        title="Delete workflow?"
        message={`"${name || workflowName}" and every one of its versions, branches, reviews, and deployments will be permanently removed. Deployed copies on the engine are deleted too.`}
        consequence="This cannot be undone."
        nameEcho={name || workflowName}
        confirmLabel="Delete workflow"
        onConfirm={handleDelete}
        onCancel={() => setConfirmingDelete(false)}
      />
    </div>
  );
}
