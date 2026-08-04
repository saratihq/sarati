"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Building2, Check, ChevronRight, Copy, Crown, Layers, LogOut, Pencil, Trash2, X } from "lucide-react";
import { useAuth } from "@/store/useAuth";
import { useOrgs, activeOrgOf } from "@/store/useOrgs";
import * as api from "@/api/client";
import type { OrgInvite, OrgMember, OrgRole } from "@/api/client";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PageHeader } from "@/components/ui/page-header";
import { toast } from "@/lib/toast";
import { formatDate } from "@/lib/format";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { SaratiLoader } from "./SaratiLogo";

// Settings for the ACTIVE organization — rename, members, invites. OSS ships no
// mailer, so an invite is a copyable {origin}/join/{token} URL the inviter hands over.

const ROLE_TINT: Record<OrgRole, { bg: string; fg: string }> = {
  owner: { bg: "var(--orchestr-warning-tint)", fg: "var(--orchestr-warning)" },
  admin: { bg: "var(--orchestr-ai-tint)", fg: "var(--orchestr-ai-bright)" },
  member: { bg: "var(--orchestr-accent-tint)", fg: "var(--orchestr-ink-muted)" },
};

function RoleChip({ role }: { role: OrgRole }) {
  const tint = ROLE_TINT[role] ?? ROLE_TINT.member;
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium capitalize"
      style={{ background: tint.bg, color: tint.fg }}
    >
      {role}
    </span>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--orchestr-accent-tint)",
  border: "1px solid var(--orchestr-line)",
  color: "var(--orchestr-ink)",
};

function sectionCardStyle(): React.CSSProperties {
  return { background: "var(--orchestr-surface-card)", border: "1px solid var(--orchestr-line)" };
}

function joinLinkFor(token: string): string {
  return `${window.location.origin}/join/${token}`;
}

async function copyLink(link: string) {
  try {
    await navigator.clipboard.writeText(link);
    toast.success("Invite link copied");
  } catch {
    // Clipboard can be blocked (non-secure context) — the link stays visible inline.
    toast.error("Couldn't copy automatically", "Select the link text and copy it manually.");
  }
}

export default function OrganizationSettingsPage() {
  useDocumentTitle("Organization");
  const router = useRouter();
  const me = useAuth((s) => s.user);
  const loadMe = useAuth((s) => s.loadMe);
  const orgsLoaded = useOrgs((s) => s.loaded);
  const fetchOrgs = useOrgs((s) => s.fetchOrgs);
  const activeOrg = useOrgs(activeOrgOf);


  // Deep links land here without the Layout shell, so both stores may be cold.
  useEffect(() => {
    fetchOrgs({ force: true });
    if (!me) loadMe();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only warm-up
  }, []);

  return (
    <div className="min-h-screen" style={{ background: "var(--orchestr-surface)" }}>
      <PageHeader title="Organization" backLabel="Settings" onBack={() => router.push("/settings")} />

      <div className="max-w-[720px] mx-auto py-10 px-4">
        {!orgsLoaded ? (
          <div className="flex items-center justify-center py-20">
            <SaratiLoader size={48} />
          </div>
        ) : !activeOrg || activeOrg.is_personal ? (
          /* Personal workspace — nothing to manage; offer the upgrade path. */
          <div className="rounded-xl p-6 text-center" style={sectionCardStyle()}>
            <Building2 size={22} className="mx-auto mb-3" style={{ color: "var(--orchestr-ink-subtle)" }} />
            <h2 className="text-[15px] font-semibold m-0 mb-1.5" style={{ color: "var(--orchestr-ink)" }}>
              You&apos;re in your personal workspace
            </h2>
            <p className="text-[13px] m-0 mb-4 max-w-[420px] mx-auto" style={{ color: "var(--orchestr-ink-muted)" }}>
              Just you — no members to manage. Its environments (prod, staging…) live in Integrations;
              organizations are created from Settings → Workspaces.
            </p>
            <Button variant="secondary" size="sm" onClick={() => router.push("/integrations?picker=0")}>
              Environments
            </Button>
          </div>
        ) : (
          <OrgManagement key={activeOrg.id} orgId={activeOrg.id} orgName={activeOrg.name} myRole={activeOrg.role} myUserId={me?.id ?? null} />
        )}
      </div>

    </div>
  );
}

function OrgManagement({
  orgId,
  orgName,
  myRole,
  myUserId,
}: {
  orgId: string;
  orgName: string;
  myRole: OrgRole;
  myUserId: string | null;
}) {
  const fetchOrgs = useOrgs((s) => s.fetchOrgs);
  const canManage = myRole === "owner" || myRole === "admin";
  const isOwner = myRole === "owner";

  // ── Rename ──
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(orgName);
  const [savingName, setSavingName] = useState(false);

  const saveName = async () => {
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === orgName) {
      setRenaming(false);
      setNameDraft(orgName);
      return;
    }
    setSavingName(true);
    try {
      await api.renameOrg(orgId, trimmed);
      toast.success("Organization renamed", `Now "${trimmed}"`);
      setRenaming(false);
      await fetchOrgs({ force: true }); // the header switcher shows the new name
    } catch (e) {
      toast.error("Rename failed", e instanceof Error ? e.message : undefined);
    } finally {
      setSavingName(false);
    }
  };

  // ── Members ──
  const [members, setMembers] = useState<OrgMember[] | null>(null);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<OrgMember | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [confirmTransfer, setConfirmTransfer] = useState<OrgMember | null>(null);

  // ── Delete organization (owner-only, type-name-to-confirm) ──
  const [showDelete, setShowDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const deleteOrg = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await api.deleteOrg(orgId);
      toast.success("Organization deleted", orgName);
      // Back to the personal scope — hard reload to drop every org-scoped cache.
      api.setActiveOrgId(null);
      window.location.assign("/");
    } catch (e) {
      toast.error("Couldn't delete organization", e instanceof Error ? e.message : undefined);
      setDeleting(false);
    }
  };

  // The last owner can't leave (server-guarded), so gate Leave rather than let
  // it fail — but only once the roster has loaded, or co-owners read as sole.
  const isSoleOwner =
    isOwner && members !== null && members.filter((m) => m.role === "owner").length <= 1;

  const loadMembers = useCallback(async () => {
    try {
      const { members } = await api.listOrgMembers(orgId);
      setMembers(members);
      setMembersError(null);
    } catch (e) {
      setMembersError(e instanceof Error ? e.message : "Failed to load members");
    }
  }, [orgId]);

  // ── Invites ──
  const [invites, setInvites] = useState<OrgInvite[] | null>(null);
  const [invitesError, setInvitesError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<OrgRole>("member");
  const [inviting, setInviting] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<OrgInvite | null>(null);
  // The last created invite's link — with no mailer, this copy moment is the
  // whole delivery mechanism.
  const [createdLink, setCreatedLink] = useState<{ email: string; link: string } | null>(null);

  const loadInvites = useCallback(async () => {
    if (!canManage) return;
    try {
      const { invites } = await api.listOrgInvites(orgId);
      setInvites(invites);
      setInvitesError(null);
    } catch (e) {
      setInvitesError(e instanceof Error ? e.message : "Failed to load pending invites");
    }
  }, [orgId, canManage]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: state is set after an await, not synchronously
    loadMembers();
    loadInvites();
  }, [loadMembers, loadInvites]);

  const sendInvite = async () => {
    const email = inviteEmail.trim();
    if (!email || inviting) return;
    setInviting(true);
    try {
      const invite = await api.createOrgInvite(orgId, email, inviteRole);
      if (invite.token) {
        const link = joinLinkFor(invite.token);
        setCreatedLink({ email, link });
        await copyLink(link);
      } else {
        // The create response is contracted to carry the token — say so loudly
        // if the service ever stops sending it.
        toast.error("Invite created, but no link returned", "The service response had no token.");
      }
      setInviteEmail("");
      await loadInvites();
    } catch (e) {
      toast.error("Invite failed", e instanceof Error ? e.message : undefined);
    } finally {
      setInviting(false);
    }
  };

  const changeRole = async (member: OrgMember, role: OrgRole) => {
    try {
      await api.updateOrgMemberRole(orgId, member.user_id, role);
      toast.success("Role updated", `${member.email} is now ${role}`);
      await loadMembers();
    } catch (e) {
      toast.error("Role change failed", e instanceof Error ? e.message : undefined);
    }
  };

  const removeMember = async (member: OrgMember) => {
    try {
      await api.removeOrgMember(orgId, member.user_id);
      toast.success("Member removed", member.email);
      await loadMembers();
    } catch (e) {
      toast.error("Remove failed", e instanceof Error ? e.message : undefined);
    }
  };

  const transferOwnership = async (member: OrgMember) => {
    try {
      await api.transferOrgOwnership(orgId, member.user_id);
      toast.success("Ownership transferred", `${member.email} is now the owner`);
      // We just stepped down to admin — refresh the roster and the org so the
      // incoming myRole re-gates this page.
      await Promise.all([loadMembers(), fetchOrgs({ force: true })]);
    } catch (e) {
      toast.error("Transfer failed", e instanceof Error ? e.message : undefined);
    }
  };

  const leaveOrg = async () => {
    if (!myUserId) return;
    try {
      await api.removeOrgMember(orgId, myUserId);
      // Back to the personal scope — hard reload drops every org-scoped cache.
      api.setActiveOrgId(null);
      window.location.assign("/");
    } catch (e) {
      toast.error("Couldn't leave organization", e instanceof Error ? e.message : undefined);
    }
  };

  const revokeInvite = async (invite: OrgInvite) => {
    try {
      await api.revokeOrgInvite(orgId, invite.id);
      toast.success("Invite revoked", invite.email);
      if (createdLink?.email === invite.email) setCreatedLink(null);
      await loadInvites();
    } catch (e) {
      toast.error("Revoke failed", e instanceof Error ? e.message : undefined);
    }
  };

  return (
    <>
      {/* ── Organization name ── */}
      <section className="mb-10">
        <h2 className="text-xs text-[var(--orchestr-ink-muted)] font-semibold uppercase tracking-wider mb-4">
          Organization
        </h2>
        <div className="rounded-xl p-5 flex items-center gap-4" style={sectionCardStyle()}>
          <div
            className="w-10 h-10 rounded-lg flex items-center justify-center text-sm font-semibold shrink-0"
            style={{ background: "var(--orchestr-accent-tint-strong)", color: "var(--orchestr-ink)" }}
          >
            {(orgName.charAt(0) || "O").toUpperCase()}
          </div>
          {renaming ? (
            <div className="flex items-center gap-2 flex-1">
              <input
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveName();
                  if (e.key === "Escape") {
                    setRenaming(false);
                    setNameDraft(orgName);
                  }
                }}
                autoFocus
                className="flex-1 py-1.5 px-3 rounded-lg text-sm outline-none"
                style={inputStyle}
                aria-label="Organization name"
              />
              <Button size="sm" onClick={saveName} disabled={savingName || !nameDraft.trim()}>
                {savingName ? "Saving..." : "Save"}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Cancel rename"
                onClick={() => {
                  setRenaming(false);
                  setNameDraft(orgName);
                }}
              >
                <X size={14} />
              </Button>
            </div>
          ) : (
            <>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate m-0" style={{ color: "var(--orchestr-ink)" }}>
                  {orgName}
                </p>
                <p className="text-xs mt-0.5 m-0" style={{ color: "var(--orchestr-ink-subtle)" }}>
                  Your role: <span className="capitalize">{myRole}</span>
                </p>
              </div>
              {canManage && (
                <Button variant="secondary" size="sm" onClick={() => setRenaming(true)}>
                  <Pencil size={12} />
                  Rename
                </Button>
              )}
            </>
          )}
        </div>
      </section>

      {/* ── Members ── */}
      <section className="mb-10">
        <h2 className="text-xs text-[var(--orchestr-ink-muted)] font-semibold uppercase tracking-wider mb-4">
          Members
        </h2>
        <div className="rounded-xl" style={sectionCardStyle()}>
          {members === null && !membersError && (
            <div className="flex items-center justify-center py-8">
              <SaratiLoader size={32} />
            </div>
          )}
          {membersError && (
            <p className="text-xs p-5 m-0" style={{ color: "var(--orchestr-danger)" }}>
              {membersError}
            </p>
          )}
          {members?.map((m, i) => {
            const isSelf = m.user_id === myUserId;
            return (
              <div
                key={m.user_id}
                className="flex items-center gap-3 px-5 py-3.5"
                style={i > 0 ? { borderTop: "1px solid var(--orchestr-line)" } : undefined}
              >
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-semibold shrink-0"
                  style={{ background: "var(--orchestr-accent-tint)", color: "var(--orchestr-ink)" }}
                >
                  {(m.name?.charAt(0) || m.email.charAt(0) || "?").toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-medium truncate m-0" style={{ color: "var(--orchestr-ink)" }}>
                    {m.name || m.email}
                    {isSelf && (
                      <span className="font-normal" style={{ color: "var(--orchestr-ink-subtle)" }}>
                        {" "}
                        (you)
                      </span>
                    )}
                  </p>
                  <p className="text-[11px] truncate m-0 mt-0.5" style={{ color: "var(--orchestr-ink-subtle)" }}>
                    {m.email} · joined {formatDate(m.joined_at)}
                  </p>
                </div>
                {/* Owners may re-role others; owners stay owners — transfer is not a dropdown flick. */}
                {isOwner && !isSelf && m.role !== "owner" ? (
                  <select
                    value={m.role}
                    onChange={(e) => changeRole(m, e.target.value as OrgRole)}
                    className="text-xs py-1 px-2 rounded-lg outline-none cursor-pointer"
                    style={inputStyle}
                    aria-label={`Role of ${m.email}`}
                  >
                    <option value="admin">admin</option>
                    <option value="member">member</option>
                  </select>
                ) : (
                  <RoleChip role={m.role} />
                )}
                {isSelf ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmLeave(true)}
                    disabled={isSoleOwner}
                    title={isSoleOwner ? "Transfer ownership before you can leave" : undefined}
                  >
                    <LogOut size={12} />
                    Leave
                  </Button>
                ) : (
                  <>
                    {/* Ownership handoff — deliberate, confirm-gated, never a dropdown flick. */}
                    {isOwner && m.role !== "owner" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Make ${m.email} the owner`}
                        onClick={() => setConfirmTransfer(m)}
                      >
                        <Crown size={12} />
                        Make owner
                      </Button>
                    )}
                    {canManage && m.role !== "owner" && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${m.email}`}
                        onClick={() => setConfirmRemove(m)}
                      >
                        <Trash2 size={13} style={{ color: "var(--orchestr-danger)" }} />
                      </Button>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* ── Invites (management only) ── */}
      {canManage && (
        <section className="mb-10">
          <h2 className="text-xs text-[var(--orchestr-ink-muted)] font-semibold uppercase tracking-wider mb-4">
            Invite people
          </h2>
          <div className="rounded-xl p-5" style={sectionCardStyle()}>
            <div className="flex items-center gap-2">
              <input
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") sendInvite();
                }}
                type="email"
                placeholder="teammate@company.com"
                className="flex-1 py-2 px-3 rounded-lg text-sm outline-none"
                style={inputStyle}
                aria-label="Invite email"
              />
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as OrgRole)}
                className="text-xs py-2 px-2 rounded-lg outline-none cursor-pointer"
                style={inputStyle}
                aria-label="Invite role"
              >
                <option value="member">member</option>
                <option value="admin">admin</option>
              </select>
              <Button size="sm" onClick={sendInvite} disabled={inviting || !inviteEmail.trim()}>
                {inviting ? "Creating..." : "Create invite"}
              </Button>
            </div>
            <p className="text-[11px] mt-2 m-0" style={{ color: "var(--orchestr-ink-subtle)" }}>
              Creating an invite gives you a link to share with your teammate.
            </p>

            {createdLink && (
              <div
                className="mt-3 rounded-lg px-3 py-2.5 flex items-center gap-2"
                style={{ background: "var(--orchestr-success-tint)", border: "1px solid var(--orchestr-line)" }}
                data-testid="invite-link"
              >
                <Check size={13} className="shrink-0" style={{ color: "var(--orchestr-success)" }} />
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] m-0" style={{ color: "var(--orchestr-ink-muted)" }}>
                    Invite for <span style={{ color: "var(--orchestr-ink)" }}>{createdLink.email}</span>
                  </p>
                  <p className="text-xs font-mono truncate m-0 mt-0.5" style={{ color: "var(--orchestr-ink)" }}>
                    {createdLink.link}
                  </p>
                </div>
                <Button variant="secondary" size="sm" onClick={() => copyLink(createdLink.link)}>
                  <Copy size={12} />
                  Copy
                </Button>
              </div>
            )}

            {invitesError && (
              <div className="mt-4 flex items-center justify-between gap-3">
                <p className="text-[11px] m-0" style={{ color: "var(--orchestr-danger)" }}>
                  {invitesError}
                </p>
                <Button variant="ghost" size="sm" onClick={() => loadInvites()}>
                  Retry
                </Button>
              </div>
            )}

            {!invitesError && invites && invites.length > 0 && (
              <div className="mt-4">
                <p className="text-[11px] font-semibold uppercase tracking-wider m-0 mb-2" style={{ color: "var(--orchestr-ink-subtle)" }}>
                  Pending
                </p>
                {invites.map((inv, i) => (
                  <div
                    key={inv.id}
                    className="flex items-center gap-3 py-2.5"
                    style={i > 0 ? { borderTop: "1px solid var(--orchestr-line)" } : undefined}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] truncate m-0" style={{ color: "var(--orchestr-ink)" }}>
                        {inv.email}
                      </p>
                      <p className="text-[11px] m-0 mt-0.5" style={{ color: "var(--orchestr-ink-subtle)" }}>
                        <span className="capitalize">{inv.role}</span>
                        {inv.expires_at ? ` · expires ${formatDate(inv.expires_at)}` : ""}
                      </p>
                    </div>
                    {inv.token && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Copy invite link for ${inv.email}`}
                        onClick={() => copyLink(joinLinkFor(inv.token!))}
                      >
                        <Copy size={13} />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Revoke invite for ${inv.email}`}
                      onClick={() => setConfirmRevoke(inv)}
                    >
                      <X size={13} style={{ color: "var(--orchestr-danger)" }} />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── Environments moved to Integrations (ADR 0014) — leave a pointer ── */}
      <section className="mb-10">
        <h2 className="text-xs text-[var(--orchestr-ink-muted)] font-semibold uppercase tracking-wider mb-4 flex items-center gap-1.5">
          <Layers size={13} /> Environments
        </h2>
        <Link
          href="/integrations?picker=0"
          className="w-full flex items-center gap-3 py-3 px-4 rounded-xl transition-colors duration-150 text-left no-underline"
          style={{ background: "var(--orchestr-surface-card)", border: "1px solid var(--orchestr-line)" }}
        >
          <span className="text-[12px] flex-1" style={{ color: "var(--orchestr-ink-muted)" }}>
            Per-environment accounts now live in Integrations — assign who prod, staging and the rest run as.
          </span>
          <span className="text-[12px] inline-flex items-center gap-0.5" style={{ color: "var(--orchestr-ink)" }}>
            Manage
            <ChevronRight size={13} />
          </span>
        </Link>
      </section>

      {/* ── Danger zone (owner only) ── */}
      {isOwner && (
        <section className="mb-10">
          <h2 className="text-xs font-semibold uppercase tracking-wider mb-4" style={{ color: "var(--orchestr-danger)" }}>
            Danger zone
          </h2>
          <div
            className="rounded-xl p-5 flex items-center gap-4"
            style={{ background: "var(--orchestr-surface-card)", border: "1px solid var(--orchestr-danger)" }}
          >
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium m-0" style={{ color: "var(--orchestr-ink)" }}>
                Delete this organization
              </p>
              <p className="text-xs mt-0.5 m-0" style={{ color: "var(--orchestr-ink-subtle)" }}>
                Removes the organization and everyone&apos;s access. Move or delete its workflows first.
              </p>
            </div>
            <Button variant="destructive" size="sm" onClick={() => setShowDelete(true)}>
              <Trash2 size={13} />
              Delete
            </Button>
          </div>
        </section>
      )}

      {/* Removing a member cuts their access to every workflow in the org */}
      <ConfirmDialog
        open={confirmRemove !== null}
        title="Remove member?"
        message={`${confirmRemove?.email ?? ""} will immediately lose access to this organization's workflows.`}
        confirmLabel="Remove"
        destructive
        onConfirm={() => {
          if (confirmRemove) removeMember(confirmRemove);
          setConfirmRemove(null);
        }}
        onCancel={() => setConfirmRemove(null)}
      />

      <ConfirmDialog
        open={confirmLeave}
        title="Leave organization?"
        message="You'll lose access to this organization's workflows and land back in your personal workspace. An owner or admin can invite you again."
        confirmLabel="Leave"
        destructive
        onConfirm={() => {
          setConfirmLeave(false);
          leaveOrg();
        }}
        onCancel={() => setConfirmLeave(false)}
      />

      {/* The invite link is the whole delivery mechanism — revoking it strands whoever holds it. */}
      <ConfirmDialog
        open={confirmRevoke !== null}
        title="Revoke invite?"
        message={`The invite link sent to ${confirmRevoke?.email ?? ""} will stop working, and they won't be able to join with it.`}
        confirmLabel="Revoke invite"
        destructive
        onConfirm={() => {
          if (confirmRevoke) revokeInvite(confirmRevoke);
          setConfirmRevoke(null);
        }}
        onCancel={() => setConfirmRevoke(null)}
      />

      {/* Ownership is one-way from the actor's side: you step down to admin. */}
      <ConfirmDialog
        open={confirmTransfer !== null}
        title="Transfer ownership?"
        message={`${confirmTransfer?.email ?? ""} will become the owner and you'll step down to admin. Only an owner can manage roles and transfer ownership — you won't be able to undo this yourself.`}
        confirmLabel="Transfer ownership"
        destructive
        onConfirm={() => {
          if (confirmTransfer) transferOwnership(confirmTransfer);
          setConfirmTransfer(null);
        }}
        onCancel={() => setConfirmTransfer(null)}
      />

      {/* Delete is irreversible — gate it behind typing the org name, not one click. */}
      <ConfirmDialog
        open={showDelete}
        title={`Delete ${orgName}?`}
        message="This permanently deletes the organization and removes every member's access."
        consequence="This cannot be undone."
        nameEcho={orgName}
        confirmLabel={deleting ? "Deleting…" : "Delete organization"}
        onConfirm={deleteOrg}
        onCancel={() => !deleting && setShowDelete(false)}
      />
    </>
  );
}
