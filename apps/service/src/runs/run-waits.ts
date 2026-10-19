import type { EntityManager } from 'typeorm';

import { DomainError } from '../common/domain-error';
import { RuntimeRunStepEntity } from '../database/entities/runtime-run.entity';
import { CLEAR_CLAIM, isParkedStep, PARKED_STEP, parkedStep } from '../runtime/run-recorder.service';
import { isTimerWait } from '../runtime/timer-wait';

/** Someone who decided a wait. */
export interface Decider {
  id: string;
  name: string | null;
  email: string | null;
}

/** What a parked run is waiting for: its own clock (`timer`), a person (`event`), or a decision on its way to it (`decided`). */
export interface RunWaiting {
  kind: 'timer' | 'event' | 'decided';
  /** When a timer wakes, or when an event wait times out. */
  until: string | null;
  /** Who made the decision the run has yet to take — only on `decided`. */
  decided_by?: Decider | null;
}

/** A decision this close to its wait's deadline could reach the run only after it has given up. */
export const DECISION_MARGIN_SECONDS = 2;
/** A decision claimed this long ago that the run has not taken yet is sent again — never handed to someone else. */
export const RESEND_AFTER_SECONDS = 30;

const RANK: Record<RunWaiting['kind'], number> = { event: 0, decided: 1, timer: 2 };

export function stepWaitingOf(step: RuntimeRunStepEntity, deciders: Map<string, Decider>): RunWaiting | null {
  if (!isParkedStep(step)) return null;
  const until = step.waitingTimeoutAt?.toISOString() ?? null;
  if (isTimerWait(step.waitingTopic)) return { kind: 'timer', until };
  if (step.claimedBy === null) return { kind: 'event', until };
  return { kind: 'decided', until, decided_by: deciders.get(step.claimedBy) ?? null };
}

/** A person's decision outranks one already made, which outranks a timer; then whichever is due first. */
export function runWaitingOf(
  status: string,
  steps: RuntimeRunStepEntity[],
  deciders: Map<string, Decider>,
): RunWaiting | null {
  if (status !== 'waiting') return null;
  const due = (w: RunWaiting): number => (w.until ? Date.parse(w.until) : Infinity);
  const waits = steps.map((s) => stepWaitingOf(s, deciders)).filter((w): w is RunWaiting => w !== null);
  return waits.sort((a, b) => RANK[a.kind] - RANK[b.kind] || due(a) - due(b))[0] ?? null;
}

/** Who made each decision on a run — taken, or still on its way — by user id; a removed account keeps its id. */
export async function decidersOf(
  em: EntityManager,
  steps: RuntimeRunStepEntity[],
  runDecider: string | null = null,
): Promise<Map<string, Decider>> {
  const ids = [
    ...new Set(
      [runDecider, ...steps.flatMap((s) => [isParkedStep(s) ? s.claimedBy : null, s.decidedBy])].filter(
        (id) => id !== null,
      ),
    ),
  ];
  if (ids.length === 0) return new Map();
  const rows = await em.query<Decider[]>(`SELECT id, name, email FROM users WHERE id = ANY($1)`, [ids]);
  const found = new Map(rows.map((r) => [r.id, { id: r.id, name: r.name, email: r.email }]));
  return new Map(ids.map((id) => [id, found.get(id) ?? { id, name: null, email: null }]));
}

export function parkedSteps(em: EntityManager, scoped: string): Promise<RuntimeRunStepEntity[]> {
  return em.find(RuntimeRunStepEntity, { where: { runId: scoped, ...PARKED_STEP } });
}

function byAge(a: RuntimeRunStepEntity, b: RuntimeRunStepEntity): number {
  const since = (s: RuntimeRunStepEntity): number => s.waitingSince?.getTime() ?? 0;
  return since(a) - since(b) || a.stepKey.localeCompare(b.stepKey);
}

/** The receive a parked wait takes its event on: its own, or its run's topic, which every wait there without one shares. */
export function receiveKey(
  runId: string,
  stepKey: string,
  waitingTopic: string,
  deliveryTopic: string | null,
): string {
  return deliveryTopic === null && !isTimerWait(waitingTopic)
    ? `${runId}|topic|${waitingTopic}`
    : `${runId}|step|${stepKey}`;
}

function receiveOf(s: RuntimeRunStepEntity): string {
  return receiveKey(s.runId, s.stepKey, s.waitingTopic ?? '', s.deliveryTopic);
}

/** The parked waits sharing `wait`'s receive, oldest first — more than one only in a run from before waits were routed by step. */
export function receiveMates(
  parked: RuntimeRunStepEntity[],
  wait: RuntimeRunStepEntity,
): RuntimeRunStepEntity[] {
  return parked.filter((s) => receiveOf(s) === receiveOf(wait)).sort(byAge);
}

/** The waits one event answers — the step named, else the oldest undecided wait on the topic — with every wait sharing its receive. */
export function waitFor(
  parked: RuntimeRunStepEntity[],
  topic: string,
  stepKey: string | undefined,
): RuntimeRunStepEntity[] | undefined {
  if (isTimerWait(topic)) return undefined;
  const candidates = parked
    .filter(
      (s) => s.waitingTopic === topic && (stepKey === undefined ? stillInTime(s) : s.stepKey === stepKey),
    )
    .sort(byAge);
  for (const candidate of candidates) {
    const mates = receiveMates(parked, candidate);
    if (stepKey !== undefined && mates.length > 1) return undefined;
    if (mates.every((m) => m.claimedAt === null)) return mates;
  }
  return undefined;
}

/** The idempotency key a claimed decision is sent with, every time: the lead wait's step and when it parked. */
export function claimKey(scoped: string, lead: RuntimeRunStepEntity): string {
  return `${scoped}|${lead.stepKey}|${lead.waitingSince?.toISOString()}`;
}

/** Stores the decision with every wait it answers, under one timestamp; null when the run can no longer take it in time. */
export async function claimWaits(
  em: EntityManager,
  scoped: string,
  waits: RuntimeRunStepEntity[],
  deciderId: string,
  payload: unknown,
): Promise<Date | null> {
  const [claimed]: [Array<{ claimed_at: Date }>, number] = await em.query(
    `WITH t AS (SELECT date_trunc('milliseconds', clock_timestamp()) AS at)
     UPDATE runtime_run_steps s
        SET claimed_at = t.at, claimed_by = $4, claimed_payload = CAST($5 AS json)
       FROM t
      WHERE s.run_id = $1 AND s.step_key = ANY($2) AND ${parkedStep('s')} AND s.claimed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM runtime_run_steps d
                         WHERE d.run_id = $1 AND d.step_key = ANY($2)
                           AND d.waiting_timeout_at <= clock_timestamp() + make_interval(secs => $3))
        AND EXISTS (SELECT 1 FROM runtime_runs r WHERE r.id = s.run_id AND r.status = 'waiting')
      RETURNING s.claimed_at`,
    [
      scoped,
      waits.map((w) => w.stepKey),
      DECISION_MARGIN_SECONDS,
      deciderId,
      JSON.stringify(payload ?? null),
    ],
  );
  return claimed[0]?.claimed_at ?? null;
}

export async function unclaimWaits(
  em: EntityManager,
  scoped: string,
  waits: RuntimeRunStepEntity[],
  claimedAt: Date,
): Promise<void> {
  await em.query(
    `UPDATE runtime_run_steps SET ${CLEAR_CLAIM} WHERE run_id = $1 AND step_key = ANY($2) AND claimed_at = $3`,
    [scoped, waits.map((w) => w.stepKey), claimedAt],
  );
}

/** Each claimed decision once, by the wait it was sent for: waits sharing a receive were claimed together. */
export function claimLeads(claimed: RuntimeRunStepEntity[]): RuntimeRunStepEntity[] {
  const groups = new Map<string, RuntimeRunStepEntity[]>();
  for (const step of claimed) {
    const key = `${receiveOf(step)}|${step.claimedAt?.toISOString()}`;
    groups.set(key, [...(groups.get(key) ?? []), step]);
  }
  return [...groups.values()].map((g) => g.sort(byAge)[0]!);
}

/** Whether a decision sent now still reaches the wait before it gives up — later, a copy would answer the next wait on the topic. */
export function stillInTime(wait: RuntimeRunStepEntity): boolean {
  const due = wait.waitingTimeoutAt?.getTime();
  return due === undefined || due > Date.now() + DECISION_MARGIN_SECONDS * 1000;
}

function timerWaitRefusal(message: string): DomainError {
  return new DomainError(message, 409, { code: 'timer_wait' });
}

function timedStepRefusal(runId: string, stepKey: string): DomainError {
  return timerWaitRefusal(`Step "${stepKey}" of run ${runId} is a timed wait; it can't be sent to`);
}

export function timerTopicRefusal(topic: string): DomainError {
  return timerWaitRefusal(`Topic "${topic}" belongs to a timed wait and can't be sent to`);
}

function parkedTimerRefusal(runId: string, wakesAt: Date | null): DomainError {
  if (wakesAt && wakesAt.getTime() <= Date.now()) {
    return timerWaitRefusal(
      `Run ${runId} was due at ${wakesAt.toISOString()}, not waiting for an event — it resumes on its own`,
    );
  }
  const until = wakesAt ? ` until ${wakesAt.toISOString()}` : '';
  return timerWaitRefusal(`Run ${runId} is waiting${until}, not for an event — it resumes on its own`);
}

/** Refuses a decision its wait can no longer take in time; `where` names it, as `at step "k"` or `on topic "t"`. */
export function lateRefusal(runId: string, waits: RuntimeRunStepEntity[], where: string): DomainError {
  const lapsed = waits.some((w) => w.waitingTimeoutAt !== null && w.waitingTimeoutAt.getTime() <= Date.now());
  return new DomainError(
    lapsed
      ? `Run ${runId} is no longer waiting ${where} — the wait timed out`
      : `Run ${runId} is no longer taking a decision ${where} — the wait times out within ${DECISION_MARGIN_SECONDS}s`,
    409,
  );
}

/** Where an event was aimed: the step it names, else its topic. */
export function aimedAt(topic: string, stepKey: string | undefined): string {
  return stepKey === undefined ? `on topic "${topic}"` : `at step "${stepKey}"`;
}

/** Why no wait takes an event: what the run waits on instead, or why the wait named can't take it. */
export interface NoWait {
  runId: string;
  topic: string;
  stepKey: string | undefined;
  parked: RuntimeRunStepEntity[];
  /** The step `stepKey` names when no parked wait has it — one that ran, or none. */
  named: RuntimeRunStepEntity | null;
}

const WAIT_KINDS: ReadonlySet<string> = new Set(['waitForEvent', 'delay']);

export function noWaitOn(why: NoWait): DomainError {
  const { runId, topic, stepKey, parked } = why;
  if (parked.length === 0) {
    return isTimerWait(topic)
      ? timerTopicRefusal(topic)
      : new DomainError(`Run ${runId} is not waiting for an event`, 409);
  }
  const events = parked.filter((s) => !isTimerWait(s.waitingTopic));
  if (events.length === 0) {
    const first = Math.min(...parked.map((s) => s.waitingTimeoutAt?.getTime() ?? Infinity));
    return parkedTimerRefusal(runId, Number.isFinite(first) ? new Date(first) : null);
  }
  if (isTimerWait(topic)) return timerTopicRefusal(topic);
  const open = events.filter((s) => s.claimedAt === null);
  return stepKey === undefined ? noWaitOnTopic(runId, topic, events, open) : noWaitAtStep(why, stepKey, open);
}

function quoted(values: Array<string | null>): string {
  return [...new Set(values)]
    .sort()
    .map((v) => `"${v}"`)
    .join(', ');
}

function noWaitOnTopic(
  runId: string,
  topic: string,
  events: RuntimeRunStepEntity[],
  open: RuntimeRunStepEntity[],
): DomainError {
  const late = open.filter((s) => s.waitingTopic === topic && !stillInTime(s));
  if (late.length > 0) return lateRefusal(runId, late, aimedAt(topic, undefined));
  if (events.some((s) => s.waitingTopic === topic)) {
    return new DomainError(`Every wait of run ${runId} on topic "${topic}" is already decided`, 409);
  }
  if (open.length === 0) return new DomainError(`Every wait of run ${runId} is already decided`, 409);
  const topics = new Set(open.map((s) => s.waitingTopic)).size;
  const on = `${topics === 1 ? 'topic' : 'topics'} ${quoted(open.map((s) => s.waitingTopic))}`;
  return new DomainError(`Run ${runId} is waiting on ${on}, not "${topic}"`, 409);
}

function noWaitAtStep(why: NoWait, stepKey: string, open: RuntimeRunStepEntity[]): DomainError {
  const { runId, topic, parked, named } = why;
  const step = parked.find((s) => s.stepKey === stepKey);
  if (!step) return noWaitThere(runId, stepKey, named, open);
  if (isTimerWait(step.waitingTopic)) return timedStepRefusal(runId, stepKey);
  if (step.waitingTopic !== topic) {
    return new DomainError(
      `Step "${stepKey}" of run ${runId} waits on "${step.waitingTopic}", not "${topic}"`,
      409,
    );
  }
  if (receiveMates(parked, step).length > 1) {
    return new DomainError(
      `Step "${stepKey}" of run ${runId} shares one receive with another wait on "${topic}" — the run started ` +
        `before waits were told apart, so send the decision with the topic only`,
      409,
    );
  }
  return new DomainError(`Step "${stepKey}" of run ${runId} is already decided`, 409);
}

function noWaitThere(
  runId: string,
  stepKey: string,
  named: RuntimeRunStepEntity | null,
  open: RuntimeRunStepEntity[],
): DomainError {
  if (named?.kind === 'delay') return timedStepRefusal(runId, stepKey);
  if (named && WAIT_KINDS.has(named.kind) && (named.resumedAt !== null || named.finishedAt !== null)) {
    return new DomainError(`Run ${runId} is no longer waiting at step "${stepKey}"`, 409);
  }
  const elsewhere =
    open.length > 0
      ? `it waits at ${quoted(open.map((s) => s.stepKey))}`
      : 'every wait it has is already decided';
  if (named && !WAIT_KINDS.has(named.kind)) {
    return new DomainError(`Step "${stepKey}" of run ${runId} is not a wait — ${elsewhere}`, 409);
  }
  return new DomainError(`Run ${runId} has no wait at step "${stepKey}" — ${elsewhere}`, 409);
}
