"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Building2, Check, Plus } from "lucide-react";
import { useOrgs } from "@/store/useOrgs";
import { Button } from "@/components/ui/button";

// Organization affordances for the header user menu. CreateOrgModal lives
// OUTSIDE the dropdown (state in Layout) so closing the menu doesn't unmount it.

function menuItemHover(e: React.MouseEvent<HTMLButtonElement>, on: boolean) {
  e.currentTarget.style.background = on ? "var(--orchestr-accent-tint)" : "transparent";
}

export function OrgMenuSection({ onCreate }: { onCreate: () => void }) {
  const orgs = useOrgs((s) => s.orgs);
  const activeOrgId = useOrgs((s) => s.activeOrgId);
  const switchOrg = useOrgs((s) => s.switchOrg);
  const fetchOrgs = useOrgs((s) => s.fetchOrgs);

  // The menu can open from any screen; the store dedupes, so this is a no-op
  // when Layout already fetched.
  useEffect(() => {
    fetchOrgs();
  }, [fetchOrgs]);

  const isActive = (o: { id: string; is_personal: boolean }) =>
    activeOrgId ? o.id === activeOrgId : o.is_personal;

  return (
    <div className="border-b py-1" style={{ borderColor: "var(--orchestr-line)" }}>
      <p
        className="px-3 pt-1.5 pb-1 m-0 text-[10px] font-semibold uppercase tracking-wider"
        style={{ color: "var(--orchestr-ink-subtle)" }}
      >
        Organization
      </p>
      {orgs.map((o) => {
        const active = isActive(o);
        return (
          <button
            key={o.id}
            onClick={() => {
              // Switching hard-reloads at "/" (see useOrgs), so the menu needn't close.
              if (!active) switchOrg(o.id);
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs bg-transparent border-none cursor-pointer text-left"
            style={{ color: active ? "var(--orchestr-ink)" : "var(--orchestr-ink-muted)" }}
            onMouseEnter={(e) => menuItemHover(e, true)}
            onMouseLeave={(e) => menuItemHover(e, false)}
            aria-current={active ? "true" : undefined}
          >
            <span
              className="w-5 h-5 rounded-md flex items-center justify-center text-[10px] font-semibold shrink-0"
              style={{ background: "var(--orchestr-accent-tint)", color: "var(--orchestr-ink)" }}
            >
              {o.is_personal ? "P" : (o.name.charAt(0) || "O").toUpperCase()}
            </span>
            <span className="flex-1 truncate">{o.is_personal ? "Personal" : o.name}</span>
            {active && <Check size={12} style={{ color: "var(--orchestr-success)" }} />}
          </button>
        );
      })}
      <button
        onClick={onCreate}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs bg-transparent border-none cursor-pointer text-left"
        style={{ color: "var(--orchestr-ink-muted)" }}
        onMouseEnter={(e) => menuItemHover(e, true)}
        onMouseLeave={(e) => menuItemHover(e, false)}
      >
        <Plus size={13} />
        Create organization
      </button>
    </div>
  );
}

export function CreateOrgModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <CreateOrgModalBody onClose={onClose} />;
}

// Body split out so the input state mounts fresh on every open.
function CreateOrgModalBody({ onClose }: { onClose: () => void }) {
  const createAndSwitch = useOrgs((s) => s.createAndSwitch);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Success ends in a hard reload — the modal never needs to close itself.
      await createAndSwitch(trimmed);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create organization");
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
      onClick={onClose}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label="Create organization"
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.15 }}
        className="rounded-2xl p-6 max-w-[400px] w-full mx-4"
        style={{
          background: "var(--orchestr-surface-raised)",
          border: "1px solid var(--orchestr-line-strong)",
          boxShadow: "0 16px 48px rgba(0,0,0,0.6)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-2">
          <Building2 size={15} style={{ color: "var(--orchestr-ink-muted)" }} />
          <h2 className="text-[15px] font-semibold m-0" style={{ color: "var(--orchestr-ink)" }}>
            Create organization
          </h2>
        </div>
        <p className="text-[13px] m-0 leading-relaxed" style={{ color: "var(--orchestr-ink-muted)" }}>
          A shared workspace for your team — workflows, branches, and reviews inside it are visible to every member.
        </p>
        <input
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="Organization name"
          className="w-full mt-4 py-2 px-3 rounded-lg text-sm outline-none"
          style={{
            background: "var(--orchestr-accent-tint)",
            border: "1px solid var(--orchestr-line)",
            color: "var(--orchestr-ink)",
          }}
        />
        {error && (
          <p className="text-xs mt-2 m-0" style={{ color: "var(--orchestr-danger)" }}>
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 mt-5">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={busy || !name.trim()}>
            {busy ? "Creating..." : "Create"}
          </Button>
        </div>
      </motion.div>
    </div>
  );
}
