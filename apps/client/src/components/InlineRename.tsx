"use client";

import { useRef, useState } from "react";
import { Pencil } from "lucide-react";
import * as api from "@/api/client";
import { toast } from "@/lib/toast";

/** Inline workflow rename: Enter/blur commits via the workflow PUT, Escape cancels; never commits a version. */
export default function InlineRename({
  workflowId,
  name,
  onRenamed,
  canRename = true,
  textClassName = "text-[14px] font-semibold m-0 truncate",
}: {
  workflowId?: string;
  name: string;
  onRenamed: (name: string) => void;
  canRename?: boolean;
  textClassName?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [saving, setSaving] = useState(false);
  // Render-time derived reset: an externally changed name replaces the local copy unless mid-edit.
  const [lastName, setLastName] = useState(name);
  if (name !== lastName) {
    setLastName(name);
    if (!editing) setValue(name);
  }

  // Enter commits and unmounts the input, whose blur commits again — a ref (not state) dedupes them.
  const committingRef = useRef(false);
  const commit = async () => {
    if (committingRef.current) return;
    committingRef.current = true;
    const next = value.trim();
    setEditing(false);
    try {
      if (!next || next === name) {
        setValue(name);
        return;
      }
      // No persisted workflow yet: the host owns the name until the first save creates the row.
      if (!workflowId) {
        onRenamed(next);
        return;
      }
      setSaving(true);
      try {
        await api.updateWorkflow(workflowId, { name: next });
        onRenamed(next);
        toast.success(`Renamed to "${next}"`);
      } catch (e) {
        setValue(name);
        toast.error("Couldn't rename the workflow", e instanceof Error ? e.message : undefined);
      } finally {
        setSaving(false);
      }
    } finally {
      committingRef.current = false;
    }
  };

  if (editing) {
    return (
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") void commit();
          if (e.key === "Escape") {
            setValue(name);
            setEditing(false);
          }
        }}
        autoFocus
        aria-label="Workflow name"
        className={`bg-transparent border-none outline-none min-w-0 w-[280px] ${textClassName.replace("truncate", "")}`}
        style={{ color: "var(--orchestr-ink)", borderBottom: "1px solid var(--orchestr-line-strong)" }}
      />
    );
  }
  return (
    <>
      <h1 className={textClassName} style={{ color: "var(--orchestr-ink)" }}>
        {value}
      </h1>
      {canRename && (
        <button
          type="button"
          aria-label="Rename workflow"
          onClick={() => setEditing(true)}
          disabled={saving}
          className="shrink-0 bg-transparent border-none p-0.5 cursor-pointer inline-flex"
          style={{ color: "var(--orchestr-ink-subtle)" }}
          data-testid="rename-workflow"
        >
          <Pencil size={12} />
        </button>
      )}
    </>
  );
}
