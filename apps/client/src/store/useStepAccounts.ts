"use client";

import { useCallback, useEffect, useMemo } from "react";
import { create } from "zustand";
import * as api from "@/api/client";
import type { StepAccount } from "@/api/client";
import { isAppTriggerNode } from "@/lib/constants";
import { useWorkflow } from "@/store/useWorkflow";

const SETTLE_MS = 300;

interface CanvasNode {
  id?: unknown;
  name?: unknown;
  node_type?: unknown;
  parameters?: Record<string, unknown>;
  metadata?: unknown;
}

interface AskedStep {
  id: string;
  name: string;
  node_type: unknown;
  metadata?: { trigger: true };
  parameters: { connectionId?: unknown; model?: unknown };
}

interface Answer {
  facts: string;
  step: StepAccount | null;
}

interface StepAccountsStore {
  /** node id → the facts that decide its account, as the canvas holds them now. */
  canvas: Record<string, string>;
  /** node id → the service's answer, current only while its facts still match the canvas. */
  answers: Record<string, Answer>;
  /** node id of each app trigger on the canvas, whose account is its environment's, not this rule's. */
  appTriggers: Record<string, true>;
  error: string | null;
}

const EMPTY: StepAccountsStore = { canvas: {}, answers: {}, appTriggers: {}, error: null };

const useStore = create<StepAccountsStore>(() => EMPTY);

let users = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let issued = 0;
let applied = 0;
let latest: AskedStep[] = [];

function askedStep(node: CanvasNode): AskedStep | null {
  if (typeof node.id !== "string") return null;
  const trigger = (node.metadata as { trigger?: unknown } | undefined)?.trigger === true;
  return {
    id: node.id,
    name: typeof node.name === "string" && node.name !== "" ? node.name : node.id,
    node_type: node.node_type,
    ...(trigger ? { metadata: { trigger: true as const } } : {}),
    parameters: { connectionId: node.parameters?.connectionId, model: node.parameters?.model },
  };
}

// The name only words the messages, so it never makes the canvas ask again.
function factsOf({ name: _name, ...facts }: AskedStep): string {
  return JSON.stringify(facts);
}

function stopTimer(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

function askSoon(): void {
  stopTimer();
  timer = setTimeout(ask, SETTLE_MS);
}

function answersFit(canvas: Record<string, string>, answers: Record<string, Answer>): boolean {
  return Object.keys(canvas).every((id) => answers[id]?.facts === canvas[id]);
}

function ask(): void {
  stopTimer();
  const asked = latest;
  const id = ++issued;
  Promise.resolve()
    .then(() => api.runAsAccounts({ nodes: asked }))
    .then(({ steps }) => {
      if (id <= applied || users === 0) return;
      applied = id;
      const byId = new Map(steps.map((s) => [s.node_id, s]));
      const answers: Record<string, Answer> = {};
      for (const step of asked) answers[step.id] = { facts: factsOf(step), step: byId.get(step.id) ?? null };
      useStore.setState({ answers, error: null });
      // An answer for a canvas since changed back needs asking again; one still settling asks on its own.
      if (!timer && !answersFit(useStore.getState().canvas, answers)) askSoon();
    })
    .catch((e: unknown) => {
      if (id !== issued || users === 0) return;
      useStore.setState({ error: e instanceof Error ? e.message : "Couldn't check the accounts" });
    });
}

function report(nodes: CanvasNode[]): void {
  latest = nodes.flatMap((n) => askedStep(n) ?? []);
  const canvas = Object.fromEntries(latest.map((step) => [step.id, factsOf(step)]));
  const { canvas: before, answers } = useStore.getState();
  const ids = Object.keys(canvas);
  if (ids.length === Object.keys(before).length && ids.every((id) => before[id] === canvas[id])) return;
  const appTriggers = Object.fromEntries(
    latest.filter((step) => isAppTriggerNode(step.node_type, step.metadata)).map((step) => [step.id, true as const]),
  );
  useStore.setState({ canvas, appTriggers, error: null });
  if (answersFit(canvas, answers)) return stopTimer();
  askSoon();
}

function retain(): () => void {
  users++;
  return () => {
    users--;
    if (users > 0) return;
    stopTimer();
    applied = issued;
    latest = [];
    useStore.setState(EMPTY);
  };
}

/** Ask again now, e.g. after an account was connected; the canvas didn't change, its answers did. */
export function reloadStepAccounts(): void {
  if (users > 0) ask();
}

function nodesOf(doc: Record<string, unknown> | null): CanvasNode[] {
  return Array.isArray(doc?.nodes) ? (doc.nodes as CanvasNode[]) : [];
}

// One shared, settled ask for the open canvas serves every surface mounted on it.
function useAskWhile(enabled: boolean): void {
  const workflowJson = useWorkflow((s) => s.workflowJson);
  useEffect(() => (enabled ? retain() : undefined), [enabled]);
  useEffect(() => {
    if (enabled) report(nodesOf(workflowJson));
  }, [enabled, workflowJson]);
}

function current(
  { canvas, answers }: Pick<StepAccountsStore, "canvas" | "answers">,
  nodeId: string,
): StepAccount | null | undefined {
  const answer = answers[nodeId];
  return answer && answer.facts === canvas[nodeId] ? answer.step : undefined;
}

// A composer's Connect stands on an app trigger as placed; on a step only while the rule finds it no account to run as, or can't be asked (fail-open).
function composerConnectShows(
  state: Pick<StepAccountsStore, "canvas" | "answers" | "appTriggers" | "error">,
  nodeId: string,
): boolean | undefined {
  if (state.appTriggers[nodeId]) return true;
  const step = current(state, nodeId);
  if (step === undefined) return state.error === null ? undefined : true;
  return step?.state === "none";
}

export interface StepAccounts {
  /** node id → what that step runs as (null: it runs as no account); a step still being asked is absent. */
  steps: Record<string, StepAccount | null>;
  /** node id → whether the composer's Connect ask shows on it (see {@link useComposerConnectShows}); a step still being asked is absent. */
  connecting: Record<string, boolean>;
  error: string | null;
  reload: () => void;
}

/** What each step of the open canvas runs as for you on Default — the service's run-as rule, asked dry, so the canvas never decides one itself. */
export function useStepAccounts(enabled = true): StepAccounts {
  useAskWhile(enabled);
  const canvas = useStore((s) => s.canvas);
  const answers = useStore((s) => s.answers);
  const appTriggers = useStore((s) => s.appTriggers);
  const error = useStore((s) => s.error);
  const steps = useMemo(
    () =>
      Object.fromEntries(
        Object.keys(canvas).flatMap((id) => {
          const step = current({ canvas, answers }, id);
          return step === undefined ? [] : [[id, step]];
        }),
      ),
    [canvas, answers],
  );
  const connecting = useMemo(
    () =>
      Object.fromEntries(
        Object.keys(canvas).flatMap((id) => {
          const shows = composerConnectShows({ canvas, answers, appTriggers, error }, id);
          return shows === undefined ? [] : [[id, shows]];
        }),
      ),
    [canvas, answers, appTriggers, error],
  );
  const reload = useCallback(() => reloadStepAccounts(), []);
  return { steps, connecting, error, reload };
}

/** One step's account as its surface shows it. */
export interface StepAccountView {
  /** What it runs as (null: no account); undefined until first answered. */
  account: StepAccount | null | undefined;
  /** The step changed since `account` was answered, and the new answer is on its way. */
  settling: boolean;
  error: string | null;
  reload: () => void;
}

/** What one step runs as, keeping its last answer on screen while a change to it settles. */
export function useStepAccount(nodeId: string, enabled = true): StepAccountView {
  useAskWhile(enabled);
  const account = useStore((s) => s.answers[nodeId]?.step);
  const settling = useStore((s) => s.answers[nodeId] !== undefined && current(s, nodeId) === undefined);
  const error = useStore((s) => s.error);
  const reload = useCallback(() => reloadStepAccounts(), []);
  return { account, settling, error, reload };
}

/** Whether the composer's Connect ask shows on a node, as last answered for the canvas it is on: on an app trigger always, on a step only while it has no account to run as or that can't be checked. Reads only — a surface that asks keeps it current. */
export function useComposerConnectShows(nodeId: string): boolean | undefined {
  return useStore((s) => composerConnectShows(s, nodeId));
}

/** A refusal in the step's current words: the service named it as it was called when asked. */
export function refusalFor(account: StepAccount, name: string): string | null {
  if (account.message === null) return null;
  return account.message.replace(`"${account.node_name}"`, () => `"${name}"`);
}
