// ─── Environments API (— one pool, curated named environments) ───
// Environments are curation layers over the flat connection pool: one slot per app, filled by *assigning*
// a pool connection. Slots are references — assignment never moves the connection.

import { apiBaseUrl } from "@/lib/config";
import { ApiError, getActiveOrgId, getAuthToken } from "./client";

const API_BASE = apiBaseUrl + "/api";

/** One assigned slot on an environment: the account `app` resolves to at run time. */
export interface EnvironmentSlot {
  app: string;
  connection_id: string;
  /** Human label of the assigned account (display name or provider fallback). */
  account_label: string;
  /** Whose pool the connection lives in (curation is by reference, not transfer). */
  owner_user_id: string;
  /** The owning member's email — "whose account fills this slot". */
  owner_label: string | null;
  /** Connection health — same vocabulary as the pool list (active/pending/expired/failed). */
  status: string;
}

export interface Environment {
  id: string;
  name: string;
  /** prod is permanent: never renameable, never deletable (the service 409s). */
  is_prod: boolean;
  slots: EnvironmentSlot[];
  /** Version pointers currently aimed at this environment. */
  pointer_count: number;
  /** Triggers scoped to this environment. */
  trigger_count: number;
}

/** An environment slot holding a connection — GET /connections/:id/references. */
export interface ConnectionReference {
  environment_id: string;
  environment: string;
  workflows_affected: number;
}

/** A connection delete 409 — carries the referencing env slots so the caller can warn and retry with force. */
export class ConnectionInUseError extends ApiError {
  readonly references: ConnectionReference[];
  constructor(message: string, references: ConnectionReference[]) {
    super(message, 409);
    this.name = "ConnectionInUseError";
    this.references = references;
  }
}

// Mirrors client.ts's request(), plus the parsed error body this surface needs (the 409 `references` payload).
async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = await getAuthToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options?.headers as Record<string, string>),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const orgId = getActiveOrgId();
  if (orgId) headers["X-Org-Id"] = orgId;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  } catch (e) {
    if (e instanceof TypeError) {
      throw new Error("Can't reach the Sarati server. Check your connection, or try again in a moment.");
    }
    throw e;
  }
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({ detail: res.statusText }));
    throw toApiError(body, res.status);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

function toApiError(body: unknown, status: number): ApiError {
  let message = `API error ${status}`;
  let references: ConnectionReference[] | null = null;
  if (body && typeof body === "object") {
    const b = body as { detail?: unknown; message?: unknown; references?: unknown };
    if (typeof b.detail === "string" && b.detail) message = b.detail;
    else if (typeof b.message === "string" && b.message) message = b.message;
    if (Array.isArray(b.references)) references = b.references as ConnectionReference[];
    // Some stacks nest the payload under detail: {detail: {references: [...]}}.
    else if (b.detail && typeof b.detail === "object" && Array.isArray((b.detail as { references?: unknown }).references)) {
      references = (b.detail as { references: ConnectionReference[] }).references;
    }
  }
  if (status === 409 && references) return new ConnectionInUseError(message, references);
  return new ApiError(message, status);
}

export async function listEnvironments(): Promise<{ environments: Environment[] }> {
  return request("/environments");
}

export async function createEnvironment(name: string): Promise<void> {
  await request("/environments", { method: "POST", body: JSON.stringify({ name }) });
}

/** Rename an environment (label edit — pointers/triggers reference the id). 409 on prod. */
export async function renameEnvironment(id: string, name: string): Promise<void> {
  await request(`/environments/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ name }) });
}

/** Delete an environment — a guarded cascade. 409 on prod. */
export async function deleteEnvironment(id: string): Promise<{ removed_pointers: number; unbound_triggers: number }> {
  return request(`/environments/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Assign a pool connection into the (env, app) slot — replaces any current holder. */
export async function assignSlot(
  environmentId: string,
  app: string,
  connectionId: string,
): Promise<{ replaced_connection_id: string | null; also_in_environments: string[] }> {
  return request(`/environments/${encodeURIComponent(environmentId)}/slots/${encodeURIComponent(app)}`, {
    method: "PUT",
    body: JSON.stringify({ connection_id: connectionId }),
  });
}

/** Empty the (env, app) slot — scoped runs then fail honestly on that app (no Default fallback). */
export async function emptySlot(environmentId: string, app: string): Promise<void> {
  await request(`/environments/${encodeURIComponent(environmentId)}/slots/${encodeURIComponent(app)}`, {
    method: "DELETE",
  });
}

/** Delete a pool connection; throws ConnectionInUseError when env slots reference it — pass force to override. */
export async function deleteConnection(connectionId: string, force = false): Promise<void> {
  const qs = force ? "?force=true" : "";
  await request(`/connections/${encodeURIComponent(connectionId)}${qs}`, { method: "DELETE" });
}

/** Alias used by the promote/trigger surfaces. */
export type EnvironmentSummary = Environment;

/** Un-promote: drop this workflow's pointer for an environment. Allowed on prod — the workflow goes dark. */
export async function removeEnvPointer(
  workflowId: string,
  environmentId: string,
): Promise<{ removed: boolean; environment: string }> {
  return request(
    `/workflows/${encodeURIComponent(workflowId)}/pointers/${encodeURIComponent(environmentId)}`,
    { method: "DELETE" },
  );
}
