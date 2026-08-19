"use client";

import { create } from "zustand";

/**
 * Live single-step samples: a step's REAL output, keyed by node id (and `trigger`). Ephemeral and
 * session-only — never persisted into the document. `pinned` is deliberately a SEPARATE set, so the
 * background seeding of every step from the last run can't freeze the whole workflow into replay.
 */
interface StepSamplesState {
  /** Identity of the workflow the current samples belong to; a new scope drops samples AND pins. */
  scopeKey: string | null;
  /** node id (or `trigger`) → the step's last observed output. */
  samples: Record<string, unknown>;
  /** node ids the user EXPLICITLY pinned — a Run replays their captured output. */
  pinned: Record<string, true>;
  /** Record a step's real output, rescoping (and clearing) when the workflow changed. */
  setSample: (scopeKey: string, nodeId: string, output: unknown) => void;
  /** Drop one step's sample (and unpin it) — e.g. the user clears it in the inspector. */
  clearSample: (nodeId: string) => void;
  /** Pin a step so a Run REPLAYS its captured output (no-op without a sample to replay). */
  pinStep: (nodeId: string) => void;
  /** Unpin a step — a Run executes it against the real provider again. */
  unpinStep: (nodeId: string) => void;
  /** Seed samples from the last real run; this-session samples win, and nothing is pinned. */
  seedBackground: (scopeKey: string, seeded: Record<string, unknown>) => void;
  /** Forget every sample and pin (e.g. on leaving the editor). */
  clear: () => void;
}

export const useStepSamples = create<StepSamplesState>((set) => ({
  scopeKey: null,
  samples: {},
  pinned: {},
  setSample: (scopeKey, nodeId, output) =>
    set((s) => {
      const sameScope = s.scopeKey === scopeKey;
      return {
        scopeKey,
        samples: sameScope ? { ...s.samples, [nodeId]: output } : { [nodeId]: output },
        pinned: sameScope ? s.pinned : {},
      };
    }),
  clearSample: (nodeId) =>
    set((s) => {
      const hadSample = Object.prototype.hasOwnProperty.call(s.samples, nodeId);
      const wasPinned = Object.prototype.hasOwnProperty.call(s.pinned, nodeId);
      if (!hadSample && !wasPinned) return s;
      const samples = { ...s.samples };
      delete samples[nodeId];
      const pinned = { ...s.pinned };
      delete pinned[nodeId];
      return { samples, pinned };
    }),
  pinStep: (nodeId) =>
    set((s) => {
      // You pin CAPTURED data — pinning a step with no sample would replay nothing.
      if (!Object.prototype.hasOwnProperty.call(s.samples, nodeId) || s.pinned[nodeId]) return s;
      return { pinned: { ...s.pinned, [nodeId]: true } };
    }),
  unpinStep: (nodeId) =>
    set((s) => {
      if (!Object.prototype.hasOwnProperty.call(s.pinned, nodeId)) return s;
      const pinned = { ...s.pinned };
      delete pinned[nodeId];
      return { pinned };
    }),
  seedBackground: (scopeKey, seeded) =>
    set((s) => {
      const sameScope = s.scopeKey === scopeKey;
      return {
        scopeKey,
        samples: sameScope ? { ...seeded, ...s.samples } : { ...seeded },
        pinned: sameScope ? s.pinned : {},
      };
    }),
  clear: () => set({ scopeKey: null, samples: {}, pinned: {} }),
}));

/** The run-request pin map: captured output per EXPLICITLY pinned step; nothing else overrides execution. */
export function runPinsFor(
  state: Pick<StepSamplesState, "pinned" | "samples">,
): Record<string, unknown> {
  const pins: Record<string, unknown> = {};
  for (const id of Object.keys(state.pinned)) {
    if (Object.prototype.hasOwnProperty.call(state.samples, id)) pins[id] = state.samples[id];
  }
  return pins;
}
