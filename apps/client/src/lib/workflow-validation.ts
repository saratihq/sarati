"use client";

import { useEffect, useMemo, useState } from "react";
import { catalogEntryFor } from "@/components/NodeCatalogPanel";
import { isNativeOrTriggerType, opDropsRight } from "@/lib/constants";
import type { NodeParamSchema } from "@/api/client";

// Pre-deploy required-field validation: walks the IR against each node's catalog schema so the
// Create/Deploy action can block on empty required inputs instead of failing at run time.

export interface MissingField {
  nodeId: string;
  nodeName: string;
  /** Raw param key; humanize for display. */
  field: string;
  /** A ready-to-show sentence, set only where the raw `field` key can't explain the requirement. */
  message?: string;
}

interface IrNodeShape {
  id: string;
  name?: string;
  node_type?: string;
  parameters?: Record<string, unknown>;
  /** App triggers carry `metadata.trigger`, so their null catalog lookup isn't mis-flagged. */
  metadata?: Record<string, unknown>;
}

/** Empty = nothing a run could use: unset, blank string, or an empty array. */
export function isEmpty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

/** Required inputs the user must fill. MARKDOWN params are instructions, not inputs. */
function requiredKeys(params: Record<string, NodeParamSchema>): string[] {
  return Object.entries(params)
    .filter(([, spec]) => spec.required && (spec.type ?? "").toUpperCase() !== "MARKDOWN")
    .map(([key]) => key);
}

function irNodes(ir: Record<string, unknown> | null): IrNodeShape[] {
  const nodes = (ir?.nodes as IrNodeShape[]) ?? [];
  return Array.isArray(nodes) ? nodes : [];
}

/**
 * Mode-/shape-dependent requirements a flat `schema.required` can't express, in ONE place beside the
 * flat check. Must mirror the inspector editors exactly, or the deploy gate and the inline warnings
 * disagree about what "complete" means.
 */
function nodeTypeMissing(node: IrNodeShape, nodeName: string): MissingField[] {
  const type = node.node_type;
  const params = node.parameters ?? {};
  const out: MissingField[] = [];
  const add = (field: string, message: string) =>
    out.push({ nodeId: node.id, nodeName, field, message });

  if (type === "orchestr:loop") {
    // Default mode (loops predating `mode`) is items — mirror LoopEditor.
    if (params.mode === "while") {
      const condition = (params.condition ?? {}) as Record<string, unknown>;
      if (isEmpty(condition.left)) {
        add("condition", `${nodeName}: set the condition the loop repeats while true.`);
      }
      // The infinite-loop guard: the service rejects a missing / ≤0 / non-integer cap.
      const cap = params.max_iterations;
      if (!(typeof cap === "number" && Number.isInteger(cap) && cap >= 1)) {
        add("max_iterations", `${nodeName}: max iterations must be a whole number ≥ 1.`);
      }
    } else if (isEmpty(params.items)) {
      add("items", `${nodeName}: set the Items collection to loop over.`);
    }
  } else if (type === "orchestr:switch") {
    const cases = Array.isArray(params.cases) ? params.cases : [];
    if (cases.length === 0) {
      add("cases", `${nodeName}: add at least one case to route on.`);
    } else {
      cases.forEach((raw, i) => {
        const c = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        const label = `${nodeName}: case ${i + 1}`;
        if (isEmpty(c.left)) add(`cases.${i}.left`, `${label} needs a value to test.`);
        // The engine drops `right` for the unary ops, so require it only for binary ones.
        if (isEmpty(c.op)) add(`cases.${i}.op`, `${label} needs an operator.`);
        else if (!opDropsRight(String(c.op)) && isEmpty(c.right)) {
          add(`cases.${i}.right`, `${label} needs a value to compare against.`);
        }
      });
    }
  } else if (type === "orchestr:if") {
    // `right` is catalog `required:false` because its required-ness flips on the operator, so only this
    // hook flags an incomplete binary IF. Mirror IfEditor: `op` defaults to the binary "eq" when unset.
    const op = typeof params.op === "string" ? params.op : "eq";
    if (!opDropsRight(op) && isEmpty(params.right)) {
      add("right", `${nodeName}: set the value this condition compares against.`);
    }
  } else if (type === "orchestr:schedule") {
    // The service only parses schedule props at ACTIVATION, where a bad shape means the trigger silently
    // never fires — so this is the author-time net for composer/API/merge-produced docs.
    const hasCron = params.cron !== undefined;
    const hasInterval = params.interval_minutes !== undefined;
    if (hasCron && hasInterval) {
      add("cron", `${nodeName}: set an interval OR a cron, not both — the engine refuses the pair.`);
    } else if (hasCron) {
      const cron = typeof params.cron === "string" ? params.cron.trim() : "";
      if (cron === "" || !/^\S+(\s+\S+){4}$/.test(cron)) {
        add("cron", `${nodeName}: the cron needs 5 fields (minute hour day-of-month month day-of-week).`);
      }
    } else {
      const interval = params.interval_minutes;
      // 525600 = the service's MAX_INTERVAL_MINUTES (one year, schedule.ts).
      if (!(typeof interval === "number" && Number.isInteger(interval) && interval >= 1 && interval <= 525_600)) {
        add(
          "interval_minutes",
          `${nodeName}: set how often it runs (a whole number of minutes, 1 to 525600).`,
        );
      }
    }
  }
  return out;
}

/**
 * The empty required PARAM fields across every configurable step. Missing CONNECTIONS deliberately
 * don't count — a version must be creatable before any account is connected, and an unconnected step
 * fails honestly at run time.
 */
export async function collectMissingRequired(
  ir: Record<string, unknown> | null,
): Promise<MissingField[]> {
  const missing: MissingField[] = [];
  for (const node of irNodes(ir)) {
    const type = node.node_type;
    // Trigger nodes carry no required inputs.
    if (!type || type.startsWith("orchestr:trigger") || type === "orchestr:chat") continue;
    const params = node.parameters ?? {};
    const nodeName = node.name || type;
    // Must run BEFORE the catalog lookup: the schedule trigger has no catalog entry yet still carries a
    // gateable shape. `owned` then suppresses the flat walk, so each missing field is listed once.
    const shapeMissing = nodeTypeMissing(node, nodeName);
    const owned = new Set(shapeMissing.map((m) => m.field));
    missing.push(...shapeMissing);
    const entry = await catalogEntryFor(type);
    if (!entry) {
      // A null lookup here means a removed/renamed action — a phantom step that dies at run time.
      // The shared predicate spares every type whose null entry is expected, and is the same one the
      // inspector's broken-node banner uses, so gate and inspector agree on "unrecognized".
      if (!isNativeOrTriggerType(type, node.metadata)) {
        missing.push({
          nodeId: node.id,
          nodeName,
          field: "node_type",
          message: `${nodeName}: unrecognized type “${type}” — not in the catalog; it can’t run (likely removed or renamed).`,
        });
      }
      continue;
    }
    for (const key of requiredKeys(entry.parameters ?? {})) {
      if (owned.has(key)) continue;
      if (isEmpty(params[key])) missing.push({ nodeId: node.id, nodeName, field: key });
    }
  }
  return missing;
}

/** Live required-field validation for the current document; recomputes on shape/param changes, not drags. */
export function useMissingRequired(ir: Record<string, unknown> | null): MissingField[] {
  const [missing, setMissing] = useState<MissingField[]>([]);
  // Signature over only what validation reads, so a position move can't re-run the walk.
  const signature = useMemo(
    () => JSON.stringify(irNodes(ir).map((n) => [n.id, n.node_type, n.parameters])),
    [ir],
  );
  useEffect(() => {
    let cancelled = false;
    void collectMissingRequired(ir).then((result) => {
      if (!cancelled) setMissing(result);
    });
    return () => {
      cancelled = true;
    };
    // `ir` is intentionally read through the memoized signature.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  return missing;
}
