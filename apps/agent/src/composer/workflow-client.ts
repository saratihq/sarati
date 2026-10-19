import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvConfig } from '../config/env.config';
import type { CallerContext } from '../config/platform-keys.client';
import type { DropdownOption } from './dropdown-values';
import type { ComposeOp, WorkflowIr } from './protocol';

/**
 * Typed service client for workflow-service — the tools are thin wrappers
 * over these calls, authenticated with the configured ork_ API key.
 */

const REQUEST_TIMEOUT_MS = 15_000;

export interface CatalogEntry {
  name: string;
  type: string;
  category: string;
  description: string;
  auth: string;
  /** `action`, `trigger` or `control`. */
  kind?: string;
  parameters: Record<string, unknown>;
}

/** A trigger catalog row — the agent's find_trigger surface. */
export interface TriggerCatalogEntry {
  type: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type ApplyOpsResult = { ok: true; ir: WorkflowIr } | { ok: false; detail: string };

/** A run/test outcome: `ok:false` is a RUN failure (a product signal), not a transport error. */
export type RunOutcome = { ok: true; outputs: Record<string, unknown> } | { ok: false; detail: string };

export interface RunRecord {
  run_id: string;
  status: string;
  error: string | null;
  steps: Array<{ node_id: string | null; status: string; error: string | null }>;
}

export interface TestStepNode {
  id: string;
  node_type: string;
  name?: string;
  parameters?: Record<string, unknown>;
}

export interface WorkflowRead {
  id: string;
  name: string;
  /** Main-branch HEAD document (the committed IR graph), null when uncommitted. */
  ir: WorkflowIr | null;
}

export class WorkflowServiceError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'WorkflowServiceError';
  }
}

interface HttpReply {
  status: number;
  body: unknown;
}

@Injectable()
export class WorkflowServiceClient {
  private readonly base: string;
  private readonly fallbackKey: string | null;

  constructor(@Inject(ConfigService) config: ConfigService<{ env: EnvConfig }, true>) {
    const env = config.get('env', { infer: true });
    this.base = env.workflowServiceUrl;
    // Defense-in-depth: the shared ork_ key may substitute for a caller token
    // ONLY under MOCK_AUTH. With real auth a null token is a bug upstream —
    // failing beats silently escalating to the service identity.
    this.fallbackKey = env.mockAuth ? env.workflowServiceApiKey : null;
  }

  async searchCatalog(query: string, topK: number, caller: CallerContext): Promise<CatalogEntry[]> {
    const q = new URLSearchParams({ q: query, top_k: String(topK) });
    const { status, body } = await this.request('GET', `/api/compose/catalog?${q.toString()}`, caller);
    if (status !== 200) throw this.asError('catalog search', status, body);
    const results = (body as { results?: unknown }).results;
    return Array.isArray(results) ? (results as CatalogEntry[]) : [];
  }

  /** Exact-type lookup with the FULL parameter schema (A1). Null when the type is unknown. */
  async getActionSchema(type: string, caller: CallerContext): Promise<CatalogEntry | null> {
    const q = new URLSearchParams({ type });
    const { status, body } = await this.request('GET', `/api/compose/catalog?${q.toString()}`, caller);
    if (status === 404) return null;
    if (status !== 200) throw this.asError('action schema lookup', status, body);
    const entry = (body as { entry?: unknown }).entry;
    return entry && typeof entry === 'object' ? (entry as CatalogEntry) : null;
  }

  /**
   * Apply a batch against a draft. Validation rejections (422) come back as
   * `ok: false` with the agent-facing detail — the agent self-corrects on
   * them, they are not transport failures.
   */
  async applyOps(ir: WorkflowIr | null, ops: ComposeOp[], caller: CallerContext): Promise<ApplyOpsResult> {
    const { status, body } = await this.request('POST', '/api/compose/apply-ops', caller, { ir, ops });
    if (status === 201 || status === 200) {
      const doc = (body as { ir?: unknown }).ir;
      if (!doc || typeof doc !== 'object') {
        throw new WorkflowServiceError('apply-ops returned no ir document', status);
      }
      return { ok: true, ir: doc as WorkflowIr };
    }
    if (status === 422 || status === 400) {
      return { ok: false, detail: detailOf(body) ?? `apply-ops rejected the batch (${status})` };
    }
    throw this.asError('apply-ops', status, body);
  }

  async readWorkflow(workflowId: string, caller: CallerContext): Promise<WorkflowRead> {
    const detail = await this.request('GET', `/api/workflows/${encodeURIComponent(workflowId)}`, caller);
    if (detail.status !== 200) throw this.asError('read workflow', detail.status, detail.body);
    const wf = detail.body as { name?: unknown };

    const versions = await this.request(
      'GET',
      `/api/workflows/${encodeURIComponent(workflowId)}/versions?branch=main`,
      caller,
    );
    if (versions.status !== 200) throw this.asError('read workflow versions', versions.status, versions.body);
    const list = (versions.body as { versions?: Array<{ version_number?: number; workflow_json?: unknown }> })
      .versions;
    const head =
      Array.isArray(list) && list.length > 0
        ? list.reduce((a, b) => ((b.version_number ?? 0) > (a.version_number ?? 0) ? b : a))
        : null;

    return {
      id: workflowId,
      name: typeof wf.name === 'string' ? wf.name : workflowId,
      ir:
        head?.workflow_json && typeof head.workflow_json === 'object'
          ? (head.workflow_json as WorkflowIr)
          : null,
    };
  }

  /** Run ONE step in isolation (transient — not recorded in run history). */
  async testStep(
    node: TestStepNode,
    sampleScope: Record<string, unknown>,
    caller: CallerContext,
  ): Promise<RunOutcome> {
    const { status, body } = await this.request('POST', '/api/runs/test-step', caller, {
      node,
      sample_scope: sampleScope,
    });
    return this.asRunOutcome('test-step', status, body);
  }

  /** Run the whole draft IR uncommitted; the caller supplies run_id so the record is readable after. */
  async runFromIr(
    args: {
      ir: WorkflowIr;
      runId: string;
      workflowId?: string | null;
      triggerPayload?: Record<string, unknown>;
    },
    caller: CallerContext,
  ): Promise<RunOutcome> {
    const { status, body } = await this.request('POST', '/api/runs/from-ir', caller, {
      workflow_ir: args.ir,
      run_id: args.runId,
      ...(args.workflowId ? { workflow_id: args.workflowId } : {}),
      ...(args.triggerPayload ? { trigger_payload: args.triggerPayload } : {}),
    });
    return this.asRunOutcome('run draft', status, body);
  }

  /**
   * The trigger catalog — the two native kinds (orchestr:webhook, orchestr:schedule)
   * plus every app/polling trigger — for the agent's find_trigger tool. The agent
   * copies a "type" and applies it to the canvas trigger node via apply_ops
   * ; there is no separate trigger row anymore.
   */
  async listTriggerCatalog(caller: CallerContext): Promise<TriggerCatalogEntry[]> {
    const { status, body } = await this.request('GET', '/api/triggers/catalog', caller);
    if (status !== 200) throw this.asError('list trigger catalog', status, body);
    // The endpoint wraps the list as { triggers: [...] }.
    const rows = Array.isArray(body)
      ? (body as Array<Record<string, unknown>>)
      : Array.isArray((body as { triggers?: unknown })?.triggers)
        ? (body as { triggers: Array<Record<string, unknown>> }).triggers
        : [];
    return rows
      .filter((r) => typeof r.type === 'string')
      .map((r) => ({
        type: r.type as string,
        name: typeof r.name === 'string' ? r.name : (r.type as string),
        description: typeof r.description === 'string' ? r.description : '',
        parameters: (r.parameters as Record<string, unknown>) ?? {},
      }));
  }

  /** The workflow's run history, newest first (the evolve flow's entry point). */
  async listRuns(
    workflowId: string,
    limit: number,
    caller: CallerContext,
  ): Promise<Array<{ run_id: string; status: string; error: string | null; started_at: string | null }>> {
    const q = new URLSearchParams({ workflow_id: workflowId, limit: String(limit) });
    const { status, body } = await this.request('GET', `/api/runs?${q.toString()}`, caller);
    if (status !== 200) throw this.asError('list runs', status, body);
    const runs = (body as { runs?: Array<Record<string, unknown>> }).runs;
    return Array.isArray(runs)
      ? runs.map((r) => ({
          run_id: typeof r.run_id === 'string' ? r.run_id : '',
          status: typeof r.status === 'string' ? r.status : 'unknown',
          error: typeof r.error === 'string' ? r.error : null,
          started_at: typeof r.started_at === 'string' ? r.started_at : null,
        }))
      : [];
  }

  /**
   * The live options behind one DROPDOWN prop — the same loader the editor's picker calls, so the
   * agent writes the option VALUES a human would have picked. Null when the loader cannot run
   * (no account, not an option prop), which callers treat as "leave the value alone".
   */
  async loadOptions(
    nodeType: string,
    prop: string,
    connectionId: string | null,
    caller: CallerContext,
  ): Promise<DropdownOption[] | null> {
    const { status, body } = await this.request(
      'POST',
      `/api/node-types/${encodeURIComponent(nodeType)}/options`,
      caller,
      { prop, ...(connectionId ? { connection_id: connectionId } : {}) },
    );
    if (status !== 200 && status !== 201) return null;
    const result = body as { options?: unknown; disabled?: unknown };
    if (result.disabled === true || !Array.isArray(result.options)) return null;
    return result.options
      .filter((o): o is Record<string, unknown> => Boolean(o) && typeof o === 'object')
      .map((o) => ({ label: typeof o.label === 'string' ? o.label : String(o.value), value: o.value }));
  }

  /** The caller's connections (provider + status + which account each is) — read-only credential awareness. */
  async listConnections(caller: CallerContext): Promise<ComposerConnection[]> {
    const { status, body } = await this.request('GET', '/api/connections', caller);
    if (status !== 200) throw this.asError('list connections', status, body);
    const list = Array.isArray(body) ? (body as Array<Record<string, unknown>>) : [];
    return list.map((c) => ({
      id: typeof c.id === 'string' ? c.id : '',
      provider: typeof c.provider === 'string' ? c.provider : 'unknown',
      status: typeof c.status === 'string' ? c.status : 'unknown',
      display_name: typeof c.display_name === 'string' ? c.display_name : null,
      one_click: c.auth_type === 'managed',
      account: accountOf(c.account),
    }));
  }

  /** What each step of a document runs as for the caller on Default — the service's run-as rule, asked dry. */
  async runAs(document: WorkflowIr, caller: CallerContext): Promise<StepRunAs[]> {
    const { status, body } = await this.request('POST', '/api/connections/run-as', caller, {
      workflow_json: document,
    });
    if (status !== 200) throw this.asError('check accounts', status, body);
    const steps = (body as { steps?: unknown }).steps;
    return Array.isArray(steps) ? steps.flatMap(stepRunAsOf) : [];
  }

  /**
   * The caller's latest COMPLETED run scope — `trigger` + one key per step —
   * the same sample source the editor's data picker eats from (W3). Null when
   * the workflow has never completed a run.
   */
  async latestRunSamples(workflowId: string, caller: CallerContext): Promise<Record<string, unknown> | null> {
    const q = new URLSearchParams({ workflow_id: workflowId });
    const { status, body } = await this.request('GET', `/api/runs/samples?${q.toString()}`, caller);
    if (status !== 200) throw this.asError('run samples', status, body);
    const sample = (body as { sample?: { outputs?: unknown } | null }).sample;
    return sample && sample.outputs && typeof sample.outputs === 'object'
      ? (sample.outputs as Record<string, unknown>)
      : null;
  }

  /** A run's record: status + per-step log (incl. error details). */
  async readRun(runId: string, caller: CallerContext): Promise<RunRecord> {
    const { status, body } = await this.request('GET', `/api/runs/${encodeURIComponent(runId)}`, caller);
    if (status !== 200) throw this.asError('read run', status, body);
    const rec = body as {
      run_id?: unknown;
      status?: unknown;
      error?: unknown;
      steps?: Array<Record<string, unknown>>;
    };
    return {
      run_id: typeof rec.run_id === 'string' ? rec.run_id : runId,
      status: typeof rec.status === 'string' ? rec.status : 'unknown',
      error: typeof rec.error === 'string' ? rec.error : null,
      steps: Array.isArray(rec.steps)
        ? rec.steps.map((step) => ({
            node_id: typeof step.node_id === 'string' ? step.node_id : null,
            status: typeof step.status === 'string' ? step.status : 'unknown',
            error: typeof step.error === 'string' ? step.error : null,
          }))
        : [],
    };
  }

  private asRunOutcome(what: string, status: number, body: unknown): RunOutcome {
    if (status === 200 || status === 201) {
      const outputs = (body as { outputs?: unknown }).outputs;
      return {
        ok: true,
        outputs: outputs && typeof outputs === 'object' ? (outputs as Record<string, unknown>) : {},
      };
    }
    // 422 = a step failed; 400 = the document can't run (both are run outcomes
    // the agent acts on, with the real message in detail).
    if (status === 422 || status === 400) {
      return { ok: false, detail: detailOf(body) ?? `${what} failed (${status})` };
    }
    throw this.asError(what, status, body);
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    caller: CallerContext,
    jsonBody?: unknown,
  ): Promise<HttpReply> {
    const bearer = caller.token ?? this.fallbackKey;
    if (!bearer) {
      throw new WorkflowServiceError(
        'no credentials for workflow-service — the caller token is missing and no fallback key is configured',
      );
    }
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${bearer}`,
          ...(caller.address ? { 'X-Forwarded-For': caller.address } : {}),
          ...(jsonBody !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new WorkflowServiceError(
        `workflow-service unreachable (${method} ${path}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body };
  }

  private asError(what: string, status: number, body: unknown): WorkflowServiceError {
    return new WorkflowServiceError(`${what} failed (${status}): ${detailOf(body) ?? 'no detail'}`, status);
  }
}

function detailOf(body: unknown): string | null {
  if (body && typeof body === 'object' && 'detail' in body) {
    const d = body.detail;
    if (typeof d === 'string') return d;
  }
  return null;
}

/** Which account a connection is, as its provider said; a `workspace` names only where it is. */
export interface ComposerAccount {
  subject: 'user' | 'workspace';
  name: string | null;
  id: string | null;
  email: string | null;
  handle: string | null;
}

/** What one step runs as for the caller, by the service's run-as rule. */
export interface StepRunAs {
  node_id: string;
  /** How it gets its account (`chosen`, `only`), or why it has none (`none`, `several`, `stale`, `inactive`, `wrong_app`, `needs_managed`). */
  state: string;
  /** The account it runs as; null when it has none. */
  connection_id: string | null;
  /** The caller's active accounts that can run it — what a pick may name. */
  accounts: string[];
  /** What a run would fail with; null when it runs. */
  message: string | null;
}

function stepRunAsOf(raw: unknown): StepRunAs[] {
  if (raw === null || typeof raw !== 'object') return [];
  const s = raw as Record<string, unknown>;
  if (typeof s.node_id !== 'string' || typeof s.state !== 'string') return [];
  return [
    {
      node_id: s.node_id,
      state: s.state,
      connection_id: typeof s.connection_id === 'string' ? s.connection_id : null,
      accounts: Array.isArray(s.accounts)
        ? s.accounts.filter((id): id is string => typeof id === 'string')
        : [],
      message: typeof s.message === 'string' ? s.message : null,
    },
  ];
}

/** One of the caller's connections, as the composer sees it. */
export interface ComposerConnection {
  id: string;
  provider: string;
  status: string;
  display_name: string | null;
  /** Connected with one-click (managed) sign-in, the only kind a step with no SDK action runs on. */
  one_click: boolean;
  /** Null until the provider has said which account this is. */
  account: ComposerAccount | null;
}

function accountOf(raw: unknown): ComposerAccount | null {
  if (raw === null || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  if (a.subject !== 'user' && a.subject !== 'workspace') return null;
  const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
  return {
    subject: a.subject,
    name: text(a.name),
    id: text(a.id),
    email: text(a.email),
    handle: text(a.handle),
  };
}
