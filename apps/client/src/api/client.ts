import { apiBaseUrl, clerkEnabled } from "@/lib/config";
import { clearLocalSession, readLocalSession, writeLocalSession } from "@/lib/localSession";

// Resolved in @/lib/config, which fails a production build when NEXT_PUBLIC_API_URL is unset.
const API_BASE = apiBaseUrl + "/api";

// ─── Active organization (tenancy scope) ───
// Sent as X-Org-Id; personal org is stored as null (no header) so a stale selection heals by clearing.
const ACTIVE_ORG_KEY = "orchestr:active-org";

let activeOrgId: string | null | undefined; // undefined = not read from storage yet

export function getActiveOrgId(): string | null {
  if (activeOrgId === undefined) {
    activeOrgId =
      typeof window === "undefined"
        ? null
        : window.localStorage.getItem(ACTIVE_ORG_KEY);
  }
  return activeOrgId;
}

export function setActiveOrgId(id: string | null): void {
  activeOrgId = id;
  if (typeof window === "undefined") return;
  if (id) window.localStorage.setItem(ACTIVE_ORG_KEY, id);
  else window.localStorage.removeItem(ACTIVE_ORG_KEY);
}

// Structural type for the ClerkProvider-managed window global.
type ClerkGlobal = {
  loaded?: boolean;
  session?: { getToken(): Promise<string | null> } | null;
  signOut?: () => Promise<void>;
};

// ClerkJS hydrates after the first render — reading the session before it loads makes a
// signed-in cold navigation look signed-out, so wait (bounded) for `loaded`.
async function clerkWhenLoaded(): Promise<ClerkGlobal | null> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const clerk = (window as { Clerk?: ClerkGlobal }).Clerk;
    if (clerk?.loaded) return clerk;
    if (Date.now() > deadline) return clerk ?? null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The bearer token for this request: a local email+password session, else a fresh Clerk JWT. */
export async function getAuthToken(): Promise<string | null> {
  if (typeof window === "undefined") return null;
  const local = readLocalSession();
  if (local) return local;
  // Without a key ClerkJS never loads, so waiting for it would stall every call for the full timeout.
  if (!clerkEnabled) return null;
  const clerk = await clerkWhenLoaded();
  if (!clerk?.session) return null;
  try {
    return await clerk.session.getToken();
  } catch {
    return null;
  }
}

/** End the session — the local one if there is one, else Clerk's. */
export async function signOut(): Promise<void> {
  if (typeof window === "undefined") return;
  if (readLocalSession()) {
    clearLocalSession();
    setActiveOrgId(null); // the next account on this browser must not inherit an org it can't read
    window.location.assign("/login");
    return;
  }
  const clerk = clerkEnabled ? await clerkWhenLoaded() : null;
  if (!clerk?.signOut) {
    window.location.assign("/login");
    return;
  }
  await clerk.signOut();
}

// Human-readable message out of any backend/proxy error shape: `detail` string or array, `message`, `error`.
function extractErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const b = body as { detail?: unknown; message?: unknown; error?: unknown };
    if (typeof b.detail === "string" && b.detail) return b.detail;
    if (Array.isArray(b.detail)) {
      const msgs = b.detail
        .map((d) =>
          d && typeof d === "object" ? (d as { msg?: string }).msg : null,
        )
        .filter(Boolean);
      if (msgs.length) return msgs.join("; ");
    }
    if (typeof b.message === "string" && b.message) return b.message;
    if (typeof b.error === "string" && b.error) return b.error;
  }
  return fallback;
}

/** Error carrying the HTTP `status`, the service's machine-readable `code`, and the full parsed `body`. */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly body?: unknown;
  constructor(message: string, status: number, code?: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

// 401 = the backend rejected the token. Drop a local session first, or /login would re-authenticate
// with the dead token and bounce straight back; Clerk's own state decides that for the Clerk path.
function handleUnauthorized(): void {
  clearLocalSession();
  if (typeof window !== "undefined") {
    window.location.assign("/login");
  }
}

/** Shared fetch: auth + org headers, ApiError translation. Exported for sibling API modules. */
export async function request<T>(
  path: string,
  options?: RequestInit,
  /** Sign-in calls set false: their 401 IS the answer, and bouncing would wipe the form's error. */
  config?: { redirectOn401?: boolean },
): Promise<T> {
  const token = await getAuthToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options?.headers as Record<string, string>),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const orgId = getActiveOrgId();
  if (orgId) {
    headers["X-Org-Id"] = orgId;
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
    });
  } catch (e) {
    // fetch() rejects with a bare TypeError when the server is unreachable.
    if (e instanceof TypeError) {
      throw new Error(
        "Can't reach the Sarati server. Check your connection, or try again in a moment.",
      );
    }
    throw e;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    const rawCode =
      body && typeof body === "object"
        ? (body as { code?: unknown }).code
        : undefined;
    const code = typeof rawCode === "string" ? rawCode : undefined;
    if (res.status === 401 && config?.redirectOn401 !== false) {
      handleUnauthorized();
    }
    throw new ApiError(
      extractErrorMessage(body, `API error ${res.status}`),
      res.status,
      code,
      body,
    );
  }
  // Tolerate bodyless 2xx (204s): res.json() would reject on an empty body.
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// ─── Auth Types ───

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

export interface MeResponse {
  user: AuthUser;
}

// ─── Auth API Functions ───
// Sign-in/sign-up go to Clerk directly; the backend only exposes /auth/me.

export async function authMe(): Promise<MeResponse> {
  return request("/auth/me");
}

// ─── Local email + password auth (ADR 0054) ───
// The self-host front door. Registration is never open: the instance's FIRST account, or an invite.

/** Mirrors the service's minimum, so the form can refuse a short password before submitting. */
export const MIN_PASSWORD_LENGTH = 12;

export interface LocalAuthStatus {
  /** This instance offers email + password sign-in at all. */
  enabled: boolean;
  /** True only while the instance has zero users — the first-run window. */
  awaiting_bootstrap: boolean;
}

export interface LocalSessionGrant {
  token: string;
  expires_at: string;
  user: AuthUser;
}

/** Unauthenticated: what sign-in this instance offers. */
export async function getLocalAuthStatus(): Promise<LocalAuthStatus> {
  return request("/auth/local/status", undefined, { redirectOn401: false });
}

/** Sign in with email + password. Persists the session on success. */
export async function localLogin(email: string, password: string): Promise<LocalSessionGrant> {
  return persistGrant(
    await request<LocalSessionGrant>(
      "/auth/local/login",
      { method: "POST", body: JSON.stringify({ email, password }) },
      { redirectOn401: false },
    ),
  );
}

/** Create an account — first-run bootstrap, or against an invite token. Persists the session. */
export async function localRegister(body: {
  email: string;
  password: string;
  name?: string;
  invite_token?: string;
}): Promise<LocalSessionGrant> {
  return persistGrant(
    await request<LocalSessionGrant>(
      "/auth/local/register",
      { method: "POST", body: JSON.stringify(body) },
      { redirectOn401: false },
    ),
  );
}

function persistGrant(grant: LocalSessionGrant): LocalSessionGrant {
  writeLocalSession(grant.token, grant.expires_at);
  return grant;
}

// ─── Organizations (tenancy) ───
// OSS ships no mailer, so invites are LINKS: create returns the raw token for a {origin}/join/{token} URL.

export type OrgRole = "owner" | "admin" | "member";

export interface OrgSummary {
  id: string;
  name: string;
  is_personal: boolean;
  /** MY role in this org — drives which management controls render. */
  role: OrgRole;
}

export interface OrgMember {
  user_id: string;
  email: string;
  name: string;
  role: OrgRole;
  joined_at?: string | null;
}

export interface OrgInvite {
  id: string;
  email: string;
  role: OrgRole;
  /** Raw invite token — present at least on the create response (link UI). */
  token?: string | null;
  expires_at?: string | null;
  created_at?: string | null;
}

export async function listOrgs(): Promise<{ orgs: OrgSummary[] }> {
  return request("/orgs");
}

export async function createOrg(name: string): Promise<OrgSummary> {
  return request("/orgs", { method: "POST", body: JSON.stringify({ name }) });
}

export async function renameOrg(orgId: string, name: string): Promise<void> {
  await request(`/orgs/${encodeURIComponent(orgId)}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

/** Delete a whole organization (owner-only; refuses while workflows remain). */
export async function deleteOrg(orgId: string): Promise<void> {
  await request(`/orgs/${encodeURIComponent(orgId)}`, { method: "DELETE" });
}

export async function listOrgMembers(
  orgId: string,
): Promise<{ members: OrgMember[] }> {
  return request(`/orgs/${encodeURIComponent(orgId)}/members`);
}

export async function updateOrgMemberRole(
  orgId: string,
  userId: string,
  role: OrgRole,
): Promise<void> {
  await request(
    `/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ role }),
    },
  );
}

/** Remove a member; removing yourself = leaving the organization. */
export async function removeOrgMember(
  orgId: string,
  userId: string,
): Promise<void> {
  await request(
    `/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
    { method: "DELETE" },
  );
}

/** Hand off ownership: the caller (an owner) becomes admin; `userId` becomes the sole owner. */
export async function transferOrgOwnership(
  orgId: string,
  userId: string,
): Promise<OrgSummary> {
  return request(`/orgs/${encodeURIComponent(orgId)}/transfer-ownership`, {
    method: "POST",
    body: JSON.stringify({ user_id: userId }),
  });
}

export async function listOrgInvites(
  orgId: string,
): Promise<{ invites: OrgInvite[] }> {
  return request(`/orgs/${encodeURIComponent(orgId)}/invites`);
}

export async function createOrgInvite(
  orgId: string,
  email: string,
  role: OrgRole,
): Promise<OrgInvite> {
  return request(`/orgs/${encodeURIComponent(orgId)}/invites`, {
    method: "POST",
    body: JSON.stringify({ email, role }),
  });
}

export async function revokeOrgInvite(
  orgId: string,
  inviteId: string,
): Promise<void> {
  await request(
    `/orgs/${encodeURIComponent(orgId)}/invites/${encodeURIComponent(inviteId)}`,
    { method: "DELETE" },
  );
}

// ── Personal API keys (ork_) — for CI / service calls ──────────────────────
export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  scopes: string[] | null;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string | null;
}

/** The plaintext `key` is returned ONCE by create and never again. */
export interface IssuedApiKey {
  id: string;
  name: string;
  key: string;
  prefix: string;
  created_at: string | null;
}

export async function listApiKeys(): Promise<{
  api_keys: ApiKeySummary[];
  grantable_scopes: string[];
}> {
  return request("/api-keys");
}

export async function createApiKey(name: string, scopes: string[]): Promise<IssuedApiKey> {
  return request("/api-keys", {
    method: "POST",
    body: JSON.stringify({ name, scopes }),
  });
}

export async function revokeApiKey(keyId: string): Promise<void> {
  await request(`/api-keys/${encodeURIComponent(keyId)}`, { method: "DELETE" });
}

/** Peek an invite (org + role) without consuming it — powers the join preview. */
export async function previewOrgInvite(
  token: string,
): Promise<{ org_id: string; org_name: string; role: OrgRole }> {
  return request(`/orgs/invites/${encodeURIComponent(token)}`);
}

export async function acceptOrgInvite(
  token: string,
): Promise<{ org_id: string; name: string }> {
  return request(`/orgs/invites/${encodeURIComponent(token)}/accept`, {
    method: "POST",
  });
}

// ─── Types ───

export interface TriggerInfo {
  event: string;
  system: string;
  type: string;
}

export interface StepInfo {
  order: number;
  action: string;
  system: string;
  category: string;
}

export interface VariableInfo {
  name: string;
  description: string;
  example: string;
}

export interface ExtractionResult {
  trigger: TriggerInfo;
  steps: StepInfo[];
  variables: VariableInfo[];
  summary: string;
}

export interface DiscoveredNode {
  name: string;
  type: string;
  node_type: string;
  description: string;
  match_score: number;
  example_config?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
}

export interface DeployResult {
  workflow_id: string;
  workflow_url: string;
  name: string;
  version_number?: number;
  activated?: boolean;
  activation_error?: string | null;
  ref_warnings?: string[];
}

export interface ExecuteResult {
  execution_id: string;
}

// ─── Dashboard Types ───

export interface WorkflowSummary {
  id: string;
  name: string;
  active: boolean;
  source?: string;
  node_count: number;
  node_types: string[];
  version_count?: number;
  /** Environments beyond prod this workflow is promoted to (H1) — chips only when non-empty. */
  environments?: string[];
  created_at?: string | null;
  updated_at?: string | null;
}

export interface WorkflowListResponse {
  workflows: WorkflowSummary[];
  total: number;
  has_more: boolean;
  limit: number;
  offset: number;
}

/** One per-environment live pointer (H1): which version this environment runs. */
export interface EnvPointer {
  environment: string;
  version_id: string;
  version_number: number;
}

export interface WorkflowDetailResponse {
  id: string;
  name: string;
  active: boolean;
  nodes: Record<string, unknown>[];
  edges: Record<string, unknown>[];
  /** The displayed version's number (the live version when one is published). */
  current_version?: number;
  /** Save ≠ Live: the version running now (null when nothing is published yet). */
  live_version?: number | null;
  /** The newest saved version on the default branch. latest > live ⇒ unpublished changes. */
  latest_version?: number;
  /** Per-environment live pointers, prod first (H1). live_version mirrors the prod entry. */
  env_pointers?: EnvPointer[];
  created_at?: string | null;
  updated_at?: string | null;
}

export interface CredentialRequirement {
  node_name: string;
  node_type: string;
  auth_type: string;
  description: string;
  configured: boolean;
}

export interface WebhookInput {
  name: string;
  description: string;
  example: string;
  required: boolean;
  /** A hint that this field feeds a known resource (e.g. "slack_channel") → the UI shows a picker. */
  resource?: string | null;
}

export interface ConfigurationResponse {
  workflow_id: string;
  credentials: CredentialRequirement[];
  webhook_inputs: WebhookInput[];
  has_webhook_trigger: boolean;
  webhook_path?: string | null;
}

// ─── API Functions ───

export async function deployWorkflow(
  workflow_json: Record<string, unknown>,
  workflow_id?: string,
): Promise<DeployResult> {
  return request("/deploy", {
    method: "POST",
    body: JSON.stringify({ workflow_json, workflow_id }),
  });
}

export interface RunSample {
  run_id: string;
  finished_at: string | null;
  /** `trigger` + one key per executed step — the roots `{{ref}}`s resolve against. */
  outputs: Record<string, unknown>;
}

/** The caller's latest completed run of a workflow, as editor sample data (W3). */
export async function getRunSamples(
  workflowId: string,
): Promise<{ sample: RunSample | null }> {
  return request(`/runs/samples?workflow_id=${encodeURIComponent(workflowId)}`);
}

export interface CatchHandle {
  catch_id: string;
  /** Service-relative intake path; make it absolute with `absoluteApiUrl`. */
  path: string;
  expires_at: string;
}

export async function createCatch(): Promise<CatchHandle> {
  return request("/catch", { method: "POST" });
}

export async function getCatch(
  catchId: string,
): Promise<{ received: boolean; payload: unknown }> {
  return request(`/catch/${encodeURIComponent(catchId)}`);
}

/** Absolute URL on the API host for a service-relative path like `/api/hooks/catch/:id`. */
export function absoluteApiUrl(path: string): string {
  return API_BASE.replace(/\/api$/, "") + path;
}

// ─── Dashboard API Functions ───

export async function listWorkflows(params?: {
  limit?: number;
  offset?: number;
}): Promise<WorkflowListResponse> {
  const limit = params?.limit ?? 50;
  const offset = params?.offset ?? 0;
  return request(`/workflows?limit=${limit}&offset=${offset}`);
}

/** One argument a callable workflow declares. */
export interface CallableWorkflowInput {
  name: string;
  type: "string" | "number" | "boolean" | "object";
  description: string;
  required: boolean;
}

/** A workflow that declared itself callable, with what it expects to be sent. */
export interface CallableWorkflow {
  workflow_id: string;
  name: string;
  description: string;
  inputs: CallableWorkflowInput[];
}

/** The workflows another workflow may call — those whose production-live version declares a contract. */
export async function listCallableWorkflows(): Promise<{ workflows: CallableWorkflow[] }> {
  return request(`/workflows/callable`);
}

export async function getWorkflow(id: string): Promise<WorkflowDetailResponse> {
  return request(`/workflows/${id}`);
}

export async function updateWorkflow(
  id: string,
  data: { name?: string; description?: string },
): Promise<WorkflowDetailResponse> {
  return request(`/workflows/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function deleteWorkflow(id: string): Promise<{ status: string }> {
  return request(`/workflows/${id}`, { method: "DELETE" });
}

export async function getWorkflowConfig(
  id: string,
): Promise<ConfigurationResponse> {
  return request(`/workflows/${id}/config`);
}

export async function executeWorkflowWithInputs(
  workflow_id: string,
  inputs?: Record<string, unknown>,
): Promise<ExecuteResult> {
  return request("/execute", {
    method: "POST",
    body: JSON.stringify({ workflow_id, inputs }),
  });
}

// ─── Node Icons API ───

export async function getNodeIconsBatch(
  nodeTypes: string[],
): Promise<Record<string, string | null>> {
  const data = await request<{ icons: Record<string, string | null> }>(
    "/node-icons/batch",
    {
      method: "POST",
      body: JSON.stringify({ node_types: nodeTypes }),
    },
  );
  return data.icons;
}

// ─── Version Types & API ───

export interface WorkflowVersionSummary {
  id: string;
  version_number: number;
  ref_warnings?: string[];
  /** True when the save matched the head exactly — nothing was minted. */
  no_changes?: boolean;
  workflow_json: Record<string, unknown>;
  workflow_ir?: Record<string, unknown> | null;
  diff?: string | null;
  ir_diff?: Record<string, unknown> | null;
  commit_message?: string | null;
  author?: string | null;
  branch_name?: string | null;
  parent_id?: string | null;
  created_at?: string | null;
  tags?: string[];
  inactive_tags?: string[];
  is_fork_point?: boolean;
  fork_source_branch?: string | null;
}

export interface WorkflowVersionListResponse {
  workflow_id: string;
  active_version_id?: string | null;
  /** Per-environment live pointers, prod first (H1) — env badges' data source. */
  env_pointers?: EnvPointer[];
  versions: WorkflowVersionSummary[];
}

export async function listVersions(
  workflowId: string,
  branch?: string,
): Promise<WorkflowVersionListResponse> {
  const params = branch ? `?branch=${encodeURIComponent(branch)}` : "";
  return request(`/workflows/${workflowId}/versions${params}`);
}

// ─── Branch Types & API ───

export interface BranchSummary {
  id: string;
  name: string;
  head_version_id?: string | null;
  is_default: boolean;
  is_protected: boolean;
  created_at?: string | null;
}

export interface BranchListResponse {
  workflow_id: string;
  branches: BranchSummary[];
}

/** One unresolved point in a three-way merge; `kind` decides which `choice` values are legal. */
export interface ConflictInfo {
  node_id: string;
  node_name: string;
  /** `field` = changed on both sides; `edit_delete` = edited on one branch, deleted on the other. */
  kind: "field" | "edit_delete";
  /** The conflicting field's path (e.g. "parameters.texts"); null for edit_delete. */
  field_path: string | null;
  /** edit_delete only: which side deleted the node. */
  deleted_on?: "source" | "target";
  source_value?: unknown;
  target_value?: unknown;
  ancestor_value?: unknown;
}

/** One decision per conflict, re-POSTed to the merge endpoint; `field_path` must equal the conflict's. */
export interface MergeResolution {
  node_id: string;
  field_path: string | null;
  choice: "source" | "target" | "custom" | "keep" | "delete";
  value?: unknown;
}

export interface MergeResultResponse {
  status: "merged" | "conflicts";
  merged_version_id?: string | null;
  conflicts?: ConflictInfo[];
}

/** Layout is presentation, not history: PATCH the branch head's node positions in place. */
export async function patchWorkflowLayout(
  workflowId: string,
  branch: string | undefined,
  positions: Record<string, { x: number; y: number }>,
): Promise<{ updated: number }> {
  return request(`/workflows/${workflowId}/layout`, {
    method: "PATCH",
    body: JSON.stringify({
      ...(branch && branch !== "main" ? { branch } : {}),
      positions,
    }),
  });
}

export async function listBranches(
  workflowId: string,
): Promise<BranchListResponse> {
  return request(`/workflows/${workflowId}/branches`);
}

export async function createBranch(
  workflowId: string,
  name: string,
  fromVersionId?: string,
): Promise<BranchSummary> {
  return request(`/workflows/${workflowId}/branches`, {
    method: "POST",
    body: JSON.stringify({ name, from_version_id: fromVersionId }),
  });
}

export async function deleteBranch(
  workflowId: string,
  branchName: string,
): Promise<void> {
  return request(
    `/workflows/${workflowId}/branches/${encodeURIComponent(branchName)}`,
    {
      method: "DELETE",
    },
  );
}

/** Protect/unprotect a branch; a protected branch only accepts merges through an approved review. */
export async function setBranchProtection(
  workflowId: string,
  branchName: string,
  isProtected: boolean,
): Promise<BranchSummary> {
  return request(
    `/workflows/${workflowId}/branches/${encodeURIComponent(branchName)}/protection`,
    {
      method: "PATCH",
      body: JSON.stringify({ is_protected: isProtected }),
    },
  );
}

/** Merge a branch; a first call may return `status:'conflicts'` — re-call with one resolution per conflict. */
export async function mergeBranch(
  workflowId: string,
  sourceBranch: string,
  targetBranch: string = "main",
  resolutions?: MergeResolution[],
): Promise<MergeResultResponse> {
  return request(
    `/workflows/${workflowId}/branches/${encodeURIComponent(sourceBranch)}/merge`,
    {
      method: "POST",
      body: JSON.stringify({ target_branch: targetBranch, resolutions }),
    },
  );
}

export async function commitVersion(
  workflowId: string,
  data: {
    workflow_json?: Record<string, unknown>;
    workflow_ir?: Record<string, unknown>;
    branch?: string;
    commit_message?: string;
    author?: string;
    /** Optimistic-concurrency base (ADR 0034 B5): a moved branch head rejects with 409 `branch_moved`. */
    base_version_id?: string | null;
  },
): Promise<WorkflowVersionSummary> {
  return request(`/workflows/${workflowId}/commit`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

/** The 409 body (on `ApiError.body`) when the branch head advanced past `base_version_id`. */
export interface BranchMoved {
  code: "branch_moved";
  detail?: string;
  current_head_version_id: string;
  current_head_version_number: number;
  base_version_id: string | null;
}

/** Narrow an ApiError's body to the branch_moved 409 payload (null if it isn't one). */
export function asBranchMoved(err: unknown): BranchMoved | null {
  if (!(err instanceof ApiError) || err.status !== 409 || err.code !== "branch_moved") {
    return null;
  }
  const b = err.body;
  if (
    b &&
    typeof b === "object" &&
    typeof (b as BranchMoved).current_head_version_id === "string" &&
    typeof (b as BranchMoved).current_head_version_number === "number"
  ) {
    return b as BranchMoved;
  }
  return null;
}

// ─── Diff Types & API ───

export interface DiffEntry {
  operation: string;
  target_id: string;
  target_name?: string | null;
  path?: string | null;
  old_value?: unknown;
  new_value?: unknown;
}

export interface RenamePair {
  old_name: string;
  new_name: string;
}

export interface DiffResponse {
  from_version: number;
  to_version: number;
  /** The branch each side actually resolved to — the only truthful label when the sides differ. */
  from_branch?: string | null;
  to_branch?: string | null;
  from_version_id?: string;
  to_version_id?: string;
  entries: DiffEntry[];
  summary: string;
  renames?: RenamePair[];
}

/** Version numbers are per-branch, so each side needs an id or a branch — the service 400s a bare ambiguous number. */
export async function getVersionDiff(
  workflowId: string,
  fromVersion: number,
  toVersion: number,
  opts?: {
    branch?: string;
    fromBranch?: string;
    toBranch?: string;
    fromVersionId?: string | null;
    toVersionId?: string | null;
  },
): Promise<DiffResponse> {
  const params = new URLSearchParams({
    from_version: String(fromVersion),
    to_version: String(toVersion),
  });
  if (opts?.branch) params.set("branch", opts.branch);
  if (opts?.fromBranch) params.set("from_branch", opts.fromBranch);
  if (opts?.toBranch) params.set("to_branch", opts.toBranch);
  // An id wins over the number+branch pair server-side, so sending both is a safe fallback.
  if (opts?.fromVersionId) params.set("from_version_id", opts.fromVersionId);
  if (opts?.toVersionId) params.set("to_version_id", opts.toVersionId);
  return request(`/workflows/${workflowId}/diff?${params}`);
}

// ─── Review Types & API ───

export interface ReviewSummary {
  id: string;
  title: string;
  status: string;
  source_branch: string;
  target_branch: string;
  author_name?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  comment_count: number;
  approval_count: number;
}

export interface ReviewComment {
  id: string;
  author_name?: string | null;
  body: string;
  node_id?: string | null;
  created_at?: string | null;
}

export interface ReviewApproval {
  id: string;
  reviewer_name?: string | null;
  decision: string;
  comment?: string | null;
  created_at?: string | null;
}

// ─── Pre-merge "Test this branch" (ADR 0015) ───
// One test really replays both sides: `base` = target branch, `head` = source. RED = head errors, baseline passed.

/** One side of a test replay — a real run and how it landed. */
export interface ReviewTestRun {
  run_id: string;
  status: "completed" | "error";
  error: string | null;
}

/** A single changed output field between baseline and head. */
export interface ReviewTestChange {
  node_id: string;
  path: string;
  before: unknown;
  after: unknown;
  /** Set when the row collapses a contiguous run of added/removed array entries: how many. */
  count?: number;
}

/** Field-level output delta head-vs-baseline (node ids for whole add/remove). */
export interface ReviewTestRegression {
  changed: ReviewTestChange[];
  added: string[];
  removed: string[];
}

/** The result of a pre-merge test — also persisted as a review's `last_test`. */
export interface ReviewTestSummary {
  verdict: "green" | "red";
  tested_at: string;
  environment_id: string | null;
  source_version_id: string | null;
  target_version_id: string | null;
  base: ReviewTestRun;
  head: ReviewTestRun;
  regression: ReviewTestRegression;
}

export interface ReviewDetail extends ReviewSummary {
  description?: string | null;
  comments: ReviewComment[];
  approvals: ReviewApproval[];
  /** The most recent pre-merge test (ADR 0015), or null if never tested. */
  last_test?: ReviewTestSummary | null;
}

export interface ReviewListResponse {
  workflow_id: string;
  reviews: ReviewSummary[];
}

export async function listReviews(
  workflowId: string,
  status?: string,
): Promise<ReviewListResponse> {
  const params = status ? `?status=${encodeURIComponent(status)}` : "";
  return request(`/workflows/${workflowId}/reviews${params}`);
}

export async function createReview(
  workflowId: string,
  data: {
    source_branch: string;
    target_branch?: string;
    title: string;
    description?: string;
  },
): Promise<ReviewSummary> {
  return request(`/workflows/${workflowId}/reviews`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function getReview(
  workflowId: string,
  reviewId: string,
): Promise<ReviewDetail> {
  return request(`/workflows/${workflowId}/reviews/${reviewId}`);
}

export async function addReviewComment(
  workflowId: string,
  reviewId: string,
  body: string,
  nodeId?: string,
): Promise<ReviewComment> {
  return request(`/workflows/${workflowId}/reviews/${reviewId}/comments`, {
    method: "POST",
    body: JSON.stringify({ body, node_id: nodeId }),
  });
}

export async function approveReview(
  workflowId: string,
  reviewId: string,
  decision: string,
  comment?: string,
): Promise<ReviewApproval> {
  return request(`/workflows/${workflowId}/reviews/${reviewId}/approve`, {
    method: "POST",
    body: JSON.stringify({ decision, comment }),
  });
}

/** Merge an approved review; like mergeBranch, a `conflicts` result is re-called with `resolutions`. */
export async function mergeReview(
  workflowId: string,
  reviewId: string,
  resolutions?: MergeResolution[],
): Promise<MergeResultResponse> {
  return request(`/workflows/${workflowId}/reviews/${reviewId}/merge`, {
    method: "POST",
    body: JSON.stringify({ resolutions }),
  });
}

export async function closeReview(
  workflowId: string,
  reviewId: string,
): Promise<{ status: string }> {
  return request(`/workflows/${workflowId}/reviews/${reviewId}/close`, {
    method: "POST",
  });
}

/** Pre-merge test (ADR 0015). REALLY executes both branches — confirm live effects before calling. */
export async function testReviewBranch(
  workflowId: string,
  reviewId: string,
  body: {
    environment_id?: string;
    environment_name?: string;
    trigger_payload?: unknown;
  } = {},
): Promise<ReviewTestSummary> {
  return request(`/workflows/${workflowId}/reviews/${reviewId}/test`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ── Built-in engine runs (the Sarati runtime) ──

/** One executed step in a sync run's trace; `nodeId` includes the loop/branch path when inside one. */
export interface RunTraceEntry {
  nodeId: string;
  output: unknown;
  /** Non-fatal honesty notes: inputs the rail ignored, or `{{refs}}` that resolved to nothing. */
  warnings?: string[];
}

/** The sync run response — it resolves only once the run has finished. */
export interface RunIrResult {
  outputs?: Record<string, unknown>;
  /** Ordered per-step log with each step's output + non-fatal honesty warnings. */
  trace?: RunTraceEntry[];
  error?: string | null;
  run_id?: string;
  status?: string;
}

export interface RunIrOptions {
  /** Attach the run to a workflow so it lands in that workflow's run history. */
  workflowId?: string;
  /** Client-chosen run id — lets the caller poll GET /runs/:id while the sync call is in flight. */
  runId?: string;
  /** True pinning (ADR 0021): `{ [nodeId]: output }` a step REPLAYS instead of executing (no provider hit). */
  pins?: Record<string, unknown>;
}

/** Run a WorkflowIR document synchronously on the built-in runtime. */
export async function runWorkflowIr(
  workflowIr: Record<string, unknown>,
  triggerPayload?: Record<string, unknown>,
  opts?: RunIrOptions,
): Promise<RunIrResult> {
  return request(`/runs/from-ir`, {
    method: "POST",
    body: JSON.stringify({
      workflow_ir: workflowIr,
      trigger_payload: triggerPayload ?? {},
      workflow_id: opts?.workflowId,
      run_id: opts?.runId,
      pins: opts?.pins,
    }),
  });
}

/** Start a durable (async) WorkflowIR run and return immediately; poll getRun() for the outcome. */
export async function runWorkflowIrAsync(
  workflowIr: Record<string, unknown>,
  triggerPayload?: Record<string, unknown>,
  opts?: RunIrOptions,
): Promise<{ run_id: string; status: string }> {
  return request(`/runs/from-ir/async`, {
    method: "POST",
    body: JSON.stringify({
      workflow_ir: workflowIr,
      trigger_payload: triggerPayload ?? {},
      workflow_id: opts?.workflowId,
      run_id: opts?.runId,
      pins: opts?.pins,
    }),
  });
}

/** The single IR node the editor sends to test one step in isolation. */
export interface TestStepNode {
  id: string;
  node_type: string;
  name?: string;
  parameters?: Record<string, unknown>;
}

/**
 * Run ONE step for real and return `outputs[node.id]`; `sampleScope` seeds `{{stepId.path}}` refs
 * from previously observed step samples (keyed by node id, plus `trigger`).
 */
export async function testStep(
  node: TestStepNode,
  sampleScope?: Record<string, unknown>,
): Promise<{ outputs: Record<string, unknown>; trace?: RunTraceEntry[] }> {
  return request(`/runs/test-step`, {
    method: "POST",
    body: JSON.stringify({ node, sample_scope: sampleScope ?? {} }),
  });
}

/** Pseudo-env a "Test this agent" run streams under — must stay in lockstep with the service's AGENT_TEST_ENV. */
export const AGENT_TEST_ENV = "draft";

/**
 * Test ONE agent node with its real tools: the FULL draft doc is sent (tool edges are lost in a
 * single-node doc). With `workflow_id` + `session_id` it streams to chat-events — subscribe BEFORE posting.
 */
export async function testAgentStep(body: {
  workflow_ir: Record<string, unknown>;
  node_id: string;
  input?: string;
  sample_scope?: Record<string, unknown>;
  workflow_id?: string;
  session_id?: string;
}): Promise<{ outputs: Record<string, unknown> }> {
  return request(`/runs/test-agent`, { method: "POST", body: JSON.stringify(body) });
}

// ─── Run history & approvals (built-in runtime) ───

export type RunStatus = "completed" | "failed" | "running" | "waiting";

export interface RunSummary {
  run_id: string;
  workflow_id: string | null;
  workflow_name: string | null;
  status: RunStatus;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  error: string | null;
  /** How the run started — e.g. "manual", "trigger", "webhook". */
  source: string | null;
  /** Environment the run executed under — null = Default (the user's own connections). */
  environment?: string | null;
  /** Workflow version the run executed — absent until the service reports it. */
  version_number?: number | null;
}

export interface RunStepInfo {
  node_id: string;
  /** Display name when the plan carries one; fall back to node_id. */
  name?: string | null;
  status: string;
  started_at?: string | null;
  finished_at?: string | null;
  /** Truncated step output — string preview or a small JSON value. */
  output_preview?: unknown;
  /** Set when the output was too large to store whole: `output_preview` is its head. */
  output_truncated?: { size_chars: number; max_chars: number } | null;
  error?: string | null;
  /** Non-fatal honesty warnings: inputs the action ignored, or `{{refs}}` that resolved to nothing. */
  warnings?: string[] | null;
}

/** One end of a sub-workflow call — the run that called this one, or one it called. */
export interface SubWorkflowRunLink {
  run_id: string;
  /** The calling step's key in the parent run. */
  step_key: string | null;
  workflow_id: string | null;
  workflow_name: string | null;
  status: string;
}

export interface RunDetail extends RunSummary {
  steps: RunStepInfo[];
  outputs?: Record<string, unknown> | null;
  /** Who resolved a waitForEvent (approve/reject), and when — null if none. */
  decided_by?: { id: string; name: string | null; email: string | null } | null;
  decided_at?: string | null;
  /** The run that called this one, when another workflow started it. */
  called_by?: SubWorkflowRunLink | null;
  /** The runs this one started by calling other workflows. */
  calls?: SubWorkflowRunLink[];
}

export interface WaitingRun {
  /** Unique run handle (`<owner>:<run>`) — echo this back to resume/view. */
  id: string;
  run_id: string;
  workflow_id: string | null;
  workflow_name: string | null;
  node_id: string;
  topic: string;
  waiting_since: string | null;
  timeout_at: string | null;
  /** Who kicked off the run — approvals are org-wide, so this may not be you. */
  triggered_by: { id: string; email: string | null; name: string | null };
}

export async function listRuns(params?: {
  workflowId?: string;
  limit?: number;
}): Promise<{ runs: RunSummary[] }> {
  const q = new URLSearchParams();
  if (params?.workflowId) q.set("workflow_id", params.workflowId);
  if (params?.limit != null) q.set("limit", String(params.limit));
  const qs = q.toString();
  return request(`/runs${qs ? `?${qs}` : ""}`);
}

export async function getRun(runId: string): Promise<RunDetail> {
  return request(`/runs/${encodeURIComponent(runId)}`);
}

/** Runs parked on a wait-for-event node (approvals inbox), oldest first. */
export async function listWaitingRuns(
  workflowId?: string,
): Promise<{ runs: WaitingRun[] }> {
  const q = workflowId ? `?workflow_id=${encodeURIComponent(workflowId)}` : "";
  return request(`/runs/waiting${q}`);
}

/** Deliver an event to a waiting run (e.g. an approval decision) — resumes it. */
export async function sendRunEvent(
  runId: string,
  body: { topic: string; payload?: unknown },
): Promise<void> {
  await request(`/runs/${encodeURIComponent(runId)}/events`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function rollbackVersion(
  workflowId: string,
  versionNumber: number,
  branch?: string,
): Promise<{
  status: string;
  new_version_number: number;
  rolled_back_to: number;
}> {
  const params = branch ? `?branch=${encodeURIComponent(branch)}` : "";
  return request(
    `/workflows/${workflowId}/versions/${versionNumber}/rollback${params}`,
    {
      method: "POST",
    },
  );
}

// ─── Publish / Restore (Save ≠ Live) ───
// Save (commit) advances `latest` but never what runs; publish/restore move the live POINTER, minting no version.

/** A3 co-editing reconciliation: field-level three-way merge (user-wins provisional). */
export interface ComposerMergeConflict {
  node_id: string;
  node_name: string;
  kind: "field" | "edit_delete";
  field_path: string | null;
  ours: unknown;
  theirs: unknown;
  base: unknown;
}

export async function composeMerge(
  base: Record<string, unknown>,
  ours: Record<string, unknown>,
  theirs: Record<string, unknown>,
): Promise<{
  merged: Record<string, unknown>;
  conflicts: ComposerMergeConflict[];
}> {
  return request("/compose/merge", {
    method: "POST",
    body: JSON.stringify({ base, ours, theirs }),
  });
}

/** Move the live pointer to a version (default: head). Returns the now-live number. */
export async function publishWorkflow(
  workflowId: string,
  versionNumber?: number,
): Promise<{ status: string; workflow_id: string; live_version: number }> {
  return request(`/workflows/${workflowId}/publish`, {
    method: "POST",
    body: JSON.stringify(
      versionNumber != null ? { version_number: versionNumber } : {},
    ),
  });
}

/** Point an environment at a version (publish ≡ promote-to-prod). Idempotent. */
export async function promoteToEnvironment(
  workflowId: string,
  environment: string,
  versionId: string,
): Promise<{
  status: string;
  workflow_id: string;
  environment: string;
  version_id: string;
  version_number: number;
  /** What the env ran before this call (equals version_number on a re-promote). */
  previous_version_number: number | null;
}> {
  return request(`/workflows/${workflowId}/promote`, {
    method: "POST",
    body: JSON.stringify({ environment, version_id: versionId }),
  });
}

// ─── Node catalog & credentials ───

export interface NodeParamSchema {
  type: string;
  /** SDK-authored display label (e.g. "System prompt"); falls back to a humanized key. */
  label?: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  /** Catalog default under an alternate key (some entries emit `defaultValue` instead of `default`). */
  defaultValue?: unknown;
  /** Static dropdown choices, inlined by the catalog: `[{ label, value }]`. */
  options?: unknown[];
  /** Array element schema (catalog `items`) — sharpens the JSON textarea's example placeholder. */
  items?: { type?: string; enum?: unknown[] };
  /** Catalog-published numeric bounds; absent → the inspector falls back to a per-field default band. */
  min?: number;
  max?: number;
  step?: number;
}

/** One choice in a dropdown/enum param — from the manifest or the live loader. */
export interface DropdownOption {
  label: string;
  value: unknown;
}

/** Result of the live options loader (`POST /node-types/:type/options`). */
export interface NodeTypeOptions {
  options: DropdownOption[];
  /** True when options can't be loaded yet (e.g. no connection) — render text. */
  disabled: boolean;
  placeholder?: string;
}

/** Derived support tier for a built-in-engine app/action (H7): how ready it is to run. */
export interface NodeTypeSupport {
  tier: "instant" | "needs_setup" | "limited";
  reason?: string;
}

/** The app's auth SHAPE (ADR 0042), driving the BYO-credentials form; SDK rows only — Composio rows carry none. */
export type AuthScheme =
  | { type: "apiKey"; in: "header" | "query"; name: string; prefix: string }
  | { type: "oauth2"; authUrl?: string; tokenUrl?: string; scopes: string[] }
  | { type: "basic" }
  | { type: "custom" }
  | { type: "none" };

export interface NodeTypeEntry {
  name: string;
  type: string;
  category: string;
  description: string;
  auth: string;
  parameters: Record<string, NodeParamSchema>;
  example_config?: Record<string, unknown>;
  /** Support tier for this action, when the catalog publishes one. */
  support?: NodeTypeSupport;
  /** BYO-authable scheme (BYO-auth) — absent on Composio (managed-only) rows. */
  authScheme?: AuthScheme;
}

export async function listNodeTypes(
  engine?: string,
): Promise<{ node_types: NodeTypeEntry[] }> {
  return request(
    `/node-types${engine ? `?engine=${encodeURIComponent(engine)}` : ""}`,
  );
}

/** Live dropdown options; only SDK action types have a loader — a non-SDK type 404s and the caller falls back to text. */
export async function loadNodeTypeOptions(
  nodeType: string,
  body: { prop: string; connection_id?: string; search?: string },
): Promise<NodeTypeOptions> {
  return request(`/node-types/${encodeURIComponent(nodeType)}/options`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ─── Integration connections ───
// Service-stored app accounts attached to steps by id (`parameters.connectionId`); secrets never reach the client.
// Minted by two flows: managed/Composio (hosted popup + status polling) and BYO OAuth (authorize → consent → callback).

/** A provider with a configured OAuth app — GET /connections/oauth/providers. */
export interface IntegrationProvider {
  provider: string;
  scopes: string[];
}

/** Secret-free view of a stored connection — GET /connections. */
export interface Connection {
  id: string;
  provider: string;
  display_name: string | null;
  auth_type: string;
  /** Managed rows start `pending`; any row can later flip to expired/failed on a renewal or health-check failure. */
  status?: "pending" | "active" | "expired" | "failed";
  /** Plain-language reason when the connection is expired/failed; null otherwise. */
  status_reason?: string | null;
  /** ISO time health was last verified (Test button, connect poll, or a run-time renewal). */
  last_checked_at?: string | null;
  created_at?: string | null;
}

export async function listIntegrationProviders(): Promise<{
  providers: IntegrationProvider[];
}> {
  // The service returns a bare array; wrap for call-site uniformity.
  const providers = await request<IntegrationProvider[]>(
    "/connections/oauth/providers",
  );
  return { providers };
}

export async function listConnections(): Promise<{
  connections: Connection[];
}> {
  const connections = await request<Connection[]>("/connections");
  return { connections };
}

/** Whether the managed rail is configured here — the managed-first vs BYO-only switch for the connect UI. */
export async function getConnectionCapabilities(): Promise<{ managed_available: boolean }> {
  return request("/connections/capabilities");
}

/** Store a BYO credential (API key, bearer token, or `{ username, password }`); write-only — never read back. */
export async function createTokenConnection(body: {
  provider: string;
  credential: unknown;
  display_name?: string;
}): Promise<Connection> {
  return request("/connections", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** A user-supplied ("bring your own") OAuth app — ADR 0042 A2. */
export interface ByoOAuthClient {
  client_id: string;
  client_secret: string;
  auth_url: string;
  token_url: string;
  scopes?: string[];
  use_pkce?: boolean;
}

/** Rename a personal connection — the label that tells two accounts apart. */
export async function renameConnection(
  id: string,
  displayName: string | null,
): Promise<Connection> {
  return request(`/connections/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ display_name: displayName ?? "" }),
  });
}

/**
 * Start the OAuth flow; redirect the browser to the returned consent URL. `oauthClient` runs it against
 * the user's OWN app — its secret is sent once, stored encrypted keyed by `state`, and never returned.
 */
export async function startIntegrationOAuth(
  provider: string,
  oauthClient?: ByoOAuthClient,
): Promise<{ authorize_url: string; state: string }> {
  return request("/connections/oauth/authorize", {
    method: "POST",
    body: JSON.stringify(oauthClient ? { provider, oauth_client: oauthClient } : { provider }),
  });
}

/** Finish the OAuth flow with the `?code=&state=` the provider redirected back. */
export async function completeIntegrationOAuth(
  code: string,
  state: string,
): Promise<{ status: string; connection: Connection }> {
  return request("/connections/oauth/callback", {
    method: "POST",
    body: JSON.stringify({ code, state }),
  });
}

export async function deleteConnection(
  id: string,
): Promise<{ status: string }> {
  return request(`/connections/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/** Outcome of the liveness probe — POST /connections/:id/test. */
export interface ConnectionTestResult {
  ok: boolean;
  /** The connection's (possibly updated) status after the probe. */
  status: string;
  /** Plain language: what broke, or how deep the check actually went. */
  detail?: string;
}

/** Check a connection's health now; the service persists status/reason/last-checked. */
export async function testConnection(
  id: string,
): Promise<ConnectionTestResult> {
  return request(`/connections/${encodeURIComponent(id)}/test`, {
    method: "POST",
  });
}

// ─── Managed connections (hosted OAuth — no client secrets to bring) ───
// Rows land in GET /connections with auth_type "managed" and provider = the app slug.

/** An app connectable through Sarati's hosted OAuth — GET /connections/managed/apps. */
export interface ManagedApp {
  slug: string;
  name: string;
  /** `false` = no rail can run this app, so the picker hides it. Absent → treat as executable. */
  executable?: boolean;
}

export async function listManagedApps(
  q?: string,
): Promise<{ apps: ManagedApp[] }> {
  const qs = q?.trim() ? `?q=${encodeURIComponent(q.trim())}` : "";
  return request(`/connections/managed/apps${qs}`);
}

/** Start a hosted-OAuth link; open `redirect_url` and poll the connection's status. */
export async function createManagedLink(
  app: string,
): Promise<{ connection_id: string; redirect_url: string }> {
  return request("/connections/managed/link", {
    method: "POST",
    body: JSON.stringify({ app }),
  });
}

export type ConnectionLinkStatus = "pending" | "active" | "failed";

export async function getConnectionStatus(
  id: string,
): Promise<{ status: ConnectionLinkStatus }> {
  return request(`/connections/${encodeURIComponent(id)}/status`);
}

// ─── Triggers (built-in engine) ───
// Catalog schemas use the same UPPERCASE parameter kinds as the action catalog (NodeParamSchema).

export interface TriggerCatalogEntry {
  name: string;
  type: string; // public type, e.g. "rss.new-item"; "orchestr:webhook" = incoming webhook
  category: string;
  description: string;
  parameters: Record<string, NodeParamSchema>;
  auth: "connection" | "none" | string;
  /** SDK-authored example event payload (C11) — loadable as the trigger's sample. */
  sample?: unknown;
}

export async function listTriggerCatalog(): Promise<{
  triggers: TriggerCatalogEntry[];
}> {
  return request("/triggers/catalog");
}

/** Runtime health per live canvas-trigger activation (ADR 0018) — poll cursor + last error. */
export interface TriggerActivationHealth {
  /** The promoted env the activation runs under — canonical name (e.g. "production"). */
  environment: string;
  environment_id: string;
  trigger_type: string;
  /** webhook | registered_webhook | polling | schedule. */
  kind: string;
  /** false only when an operator paused it (desired-present but not firing). */
  active: boolean;
  status: "paused" | "error" | "ok" | "idle";
  last_polled_at: string | null;
  last_error: string | null;
  updated_at: string | null;
}

export async function listTriggerActivations(
  workflowId: string,
): Promise<{ activations: TriggerActivationHealth[] }> {
  return request(
    `/triggers/activations?workflow_id=${encodeURIComponent(workflowId)}`,
  );
}

// ─── Platform API keys (per user, or per organization) ───
// The two optional platform credentials for the ACTIVE context: a real org's keys when acting in
// one, your own otherwise. Write-only: the API reports presence, never the value.

/** The two names the server accepts; anything else is a 404 by design. */
export type PlatformKeyName = "composio_api_key" | "composio_webhook_secret" | "anthropic_api_key";

export interface PlatformKeyState {
  present: boolean;
  updated_at: string | null;
}

export interface PlatformKeysResponse {
  keys: Record<PlatformKeyName, PlatformKeyState>;
  /** Whose keys these are: the active organization's, or the caller's own. */
  scope: "user" | "org";
  /** Whether THIS caller may change them — false for a plain member of the active org. */
  can_manage: boolean;
}

export async function listPlatformKeys(): Promise<PlatformKeysResponse> {
  return request("/platform-keys");
}

export async function setPlatformKey(
  name: PlatformKeyName,
  value: string,
): Promise<{ secret_present: boolean }> {
  return request(`/platform-keys/${name}`, { method: "PUT", body: JSON.stringify({ value }) });
}

export async function clearPlatformKey(name: PlatformKeyName): Promise<{ secret_present: boolean }> {
  return request(`/platform-keys/${name}`, { method: "DELETE" });
}

// ─── Webhook signing secret (native HMAC verification, ADR 0030) ───
// Env-scoped and stored OUT of the version doc, so it never enters a save/diff/review. Write-only: no read-back.

/** Set the env-scoped signing secret for a webhook trigger node. */
export async function setWebhookSecret(
  workflowId: string,
  body: { node_id: string; secret: string; environment?: string },
): Promise<{ status: string }> {
  return request(`/workflows/${encodeURIComponent(workflowId)}/webhook-secret`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

/** Presence-only read-back behind the editor's "verification active" indicator, so Verify can't silently fail open. */
export async function getWebhookSecretStatus(
  workflowId: string,
  nodeId: string,
  environment?: string,
): Promise<{ secret_present: boolean }> {
  const qs = new URLSearchParams({ node_id: nodeId });
  if (environment) qs.set("environment", environment);
  return request(
    `/workflows/${encodeURIComponent(workflowId)}/webhook-secret?${qs.toString()}`,
    { method: "GET" },
  );
}

/** Clear the signing secret for a webhook trigger node — returns `cleared` or `absent`. */
export async function clearWebhookSecret(
  workflowId: string,
  nodeId: string,
  environment?: string,
): Promise<{ status: string }> {
  const qs = new URLSearchParams({ node_id: nodeId });
  if (environment) qs.set("environment", environment);
  return request(
    `/workflows/${encodeURIComponent(workflowId)}/webhook-secret?${qs.toString()}`,
    { method: "DELETE" },
  );
}

// ─── Chat trigger intake (orchestr:chat, ADR 0045) ───
// Synchronous front door: POST a message, the run executes, the terminal node's output returns as `reply`.
// The server mints a session id when the caller omits one; thread it across turns.

export interface ChatTurnResponse {
  run_id: string;
  session_id: string;
  /** The terminal node's output — shape is workflow-defined (e.g. an LLM node's `{ text }`). */
  reply: unknown;
  outputs: Record<string, unknown>;
}

/** Send one chat message to a workflow's chat endpoint and await its reply. */
export async function postChatMessage(
  workflowId: string,
  environment: string,
  body: { chatInput: string; sessionId?: string },
): Promise<ChatTurnResponse> {
  const payload: { chatInput: string; sessionId?: string } = { chatInput: body.chatInput };
  if (body.sessionId) payload.sessionId = body.sessionId;
  return request(
    `/chat/${encodeURIComponent(workflowId)}/${encodeURIComponent(environment)}`,
    { method: "POST", body: JSON.stringify(payload) },
  );
}

// ─── Live agent step stream (ADR 0045) ───
// SSE frames keyed by session id: subscribe FIRST, then POST the chat message with the SAME session id.

/** One agent step as it happens: a model turn, a tool call, or the final answer. */
export interface AgentStep {
  step_index: number;
  kind: "model" | "tool" | "final";
  /** Tool calls only — the tool (action) the agent invoked. */
  tool?: string;
  /** Tool calls only — the arguments the agent passed. */
  input?: unknown;
  /** Tool calls only — what the tool returned. */
  output?: unknown;
  /** Model / final turns — the text the model produced. */
  text?: string;
}

/**
 * Stream agent steps for `sessionId`, deduped by SSE frame id (a resumed stream replays seen ids).
 * The caller owns the returned handle and MUST `.close()` it, or EventSource auto-reconnects.
 */
export function streamChatEvents(
  workflowId: string,
  environment: string,
  sessionId: string,
  onStep: (step: AgentStep) => void,
): EventSource {
  const url = `${API_BASE}/chat/${encodeURIComponent(workflowId)}/${encodeURIComponent(
    environment,
  )}/events?session_id=${encodeURIComponent(sessionId)}`;
  const es = new EventSource(url);
  const seen = new Set<string>();
  es.onmessage = (evt: MessageEvent) => {
    const frameId = evt.lastEventId || "";
    if (frameId) {
      if (seen.has(frameId)) return;
      seen.add(frameId);
    }
    try {
      onStep(JSON.parse(evt.data) as AgentStep);
    } catch {
      // A malformed frame is skipped rather than tearing down the stream.
    }
  };
  return es;
}
