"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, Plus, SlidersHorizontal } from "lucide-react";
import { useAuth } from "@/store/useAuth";
import { setActiveOrgId } from "@/api/client";
import { CreateOrgModal } from "@/components/OrgSwitcher";
import { useOrgs, activeOrgOf } from "@/store/useOrgs";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import ApiKeysSettings from "./ApiKeysSettings";
import { ThemePicker } from "./ThemePicker";

export default function SettingsPage() {
  useDocumentTitle("Settings");
  const router = useRouter();
  const user = useAuth((s) => s.user);
  const loadMe = useAuth((s) => s.loadMe);
  const activeOrg = useOrgs(activeOrgOf);
  const orgs = useOrgs((s) => s.orgs);
  const [showCreateOrg, setShowCreateOrg] = useState(false);
  const fetchOrgs = useOrgs((s) => s.fetchOrgs);

  // Deep links land here without the Layout shell, so warm the org row's data.
  useEffect(() => {
    fetchOrgs();
    if (!useAuth.getState().user) loadMe();
  }, [fetchOrgs, loadMe]);

  return (
    <div className="min-h-screen" style={{ background: "var(--orchestr-surface)" }}>
      <PageHeader title="Settings" backLabel="Back" onBack={() => router.push("/")} />

      <div className="max-w-[560px] mx-auto py-10 px-4">
        {/* Profile section */}
        <section className="mb-10">
          <h2 className="text-xs text-[var(--orchestr-ink-muted)] font-semibold uppercase tracking-wider mb-4">
            Profile
          </h2>
          <div
            className="rounded-lg p-5"
            style={{
              background: "var(--orchestr-surface-card)",
              border: "1px solid var(--orchestr-line)",
            }}
          >
            <div className="flex items-center gap-4">
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center text-sm font-semibold text-[var(--orchestr-ink)]"
                style={{ background: "var(--orchestr-accent-tint-strong)" }}
              >
                {user?.name?.charAt(0)?.toUpperCase() || "U"}
              </div>
              <div>
                <p className="text-sm font-medium text-[var(--orchestr-ink)]">{user?.name}</p>
                <p className="text-xs mt-0.5" style={{ color: "var(--orchestr-ink-subtle)" }}>
                  {user?.email}
                </p>
              </div>
            </div>
          </div>
          {/* Personal configuration (owner IA 2026-07-14): your own workspace
              isn't a peer of organizations — it's part of YOU. One row, one
              destination: Integrations (your connections + its environments). */}
          <div
            className="rounded-lg p-5 mt-2 flex items-center gap-4"
            style={{ background: "var(--orchestr-surface-card)", border: "1px solid var(--orchestr-line)" }}
          >
            <div
              className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
              style={{ background: "var(--orchestr-accent-tint)", color: "var(--orchestr-ink-muted)" }}
            >
              <SlidersHorizontal size={16} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate m-0" style={{ color: "var(--orchestr-ink)" }}>
                Configuration
              </p>
              <p className="text-xs mt-0.5 m-0" style={{ color: "var(--orchestr-ink-subtle)" }}>
                Your connected accounts and your personal workspace&apos;s environments
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                if (activeOrg && !activeOrg.is_personal) {
                  setActiveOrgId(null);
                  window.location.assign("/integrations?picker=0");
                } else {
                  router.push("/integrations?picker=0");
                }
              }}
            >
              Open
            </Button>
          </div>
        </section>

        {/* Appearance */}
        <section className="mb-10">
          <h2 className="text-xs text-[var(--orchestr-ink-muted)] font-semibold uppercase tracking-wider mb-4">
            Appearance
          </h2>
          <ThemePicker />
        </section>

        {/* Workspaces — EVERY org the user belongs to (owner report 2026-07-14:
            an org you created was reachable only via the switcher; Settings
            showed just the active context). Manage switches context and opens
            the org page — members, invites, rename, delete all live there. */}
        <section className="mb-10">
          <h2 className="text-xs text-[var(--orchestr-ink-muted)] font-semibold uppercase tracking-wider mb-4">
            Workspaces
          </h2>
          <div className="flex flex-col gap-2">
            {orgs.filter((org) => !org.is_personal).map((org) => {
              const isActive = activeOrg?.id === org.id;
              return (
                <div
                  key={org.id}
                  className="rounded-lg p-5 flex items-center gap-4"
                  style={{
                    background: "var(--orchestr-surface-card)",
                    border: "1px solid var(--orchestr-line)",
                  }}
                >
                  <div
                    className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
                    style={{ background: "var(--orchestr-accent-tint)", color: "var(--orchestr-ink-muted)" }}
                  >
                    <Building2 size={17} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate m-0" style={{ color: "var(--orchestr-ink)" }}>
                      {org.name}
                      {isActive && (
                        <span className="text-[10px] font-semibold uppercase ml-2" style={{ color: "var(--orchestr-ink-subtle)" }}>
                          active
                        </span>
                      )}
                    </p>
                    <p className="text-xs mt-0.5 m-0" style={{ color: "var(--orchestr-ink-subtle)" }}>
                      {`Your role: ${org.role}`}
                    </p>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      if (isActive) {
                        router.push("/settings/organization");
                        return;
                      }
                      // switchOrg() would hard-reload to the dashboard — set the
                      // org and reload straight to the management page instead.
                      setActiveOrgId(org.is_personal ? null : org.id);
                      window.location.assign("/settings/organization");
                    }}
                  >
                    Manage
                  </Button>
                </div>
              );
            })}
            {/* Creating a workspace is a LIST-level act (owner call 2026-07-14)
                — it lives here, not inside any workspace's manage page. */}
            <button
              onClick={() => setShowCreateOrg(true)}
              className="self-start inline-flex items-center gap-1.5 text-[12px] font-medium bg-transparent border-none cursor-pointer px-1 py-1"
              style={{ color: "var(--orchestr-ink-muted)" }}
            >
              <Plus size={13} />
              New organization
            </button>
          </div>
        </section>

        <CreateOrgModal open={showCreateOrg} onClose={() => setShowCreateOrg(false)} />

        {/* Personal API keys (ork_) — create / list / revoke */}
        <ApiKeysSettings />

      </div>
    </div>
  );
}
