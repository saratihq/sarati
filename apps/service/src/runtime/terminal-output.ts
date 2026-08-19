import { isTriggerNode } from '../compiler/compile-ir';
import { edgePortType, MAIN_PORT_TYPE, type WorkflowIR } from '../ir/models';
import type { RunResult, TraceEntry } from './run-plan';

/** Reply-extraction seam for the deferred first-class respond node; no node carries this type in v1. */
const RESPOND_NODE_TYPE = 'orchestr:respond';

/**
 * A run's TERMINAL OUTPUT by a deterministic rule — the ONE place both the chat
 * intake and the sub-workflow-as-tool runner read a finished run's "answer", so they can't diverge:
 * an `orchestr:respond` node that ran wins, else the unique non-trigger leaf, else (ambiguous
 * multi-leaf flow) the LAST-EXECUTED leaf by trace order — never an arbitrary output key. The
 * node's output is returned in whatever shape it has, never re-shaped.
 */
export function extractChatReply(ir: WorkflowIR, result: RunResult): unknown {
  const respondNode = ir.nodes.find((n) => n.node_type === RESPOND_NODE_TYPE);
  if (respondNode && respondNode.id in result.outputs) return result.outputs[respondNode.id];

  const leaves = terminalLeafIds(ir);
  if (leaves.length === 0) return null;
  if (leaves.length === 1) return result.outputs[leaves[0]!];
  return result.outputs[lastExecutedLeaf(leaves, result.trace)];
}

/** Real (non-trigger) nodes with no outgoing `main` edge — the workflow's terminal leaves. */
function terminalLeafIds(ir: WorkflowIR): string[] {
  const triggerIds = new Set(ir.nodes.filter(isTriggerNode).map((n) => n.id));
  const hasMainOut = new Set(
    ir.edges.filter((e) => edgePortType(e) === MAIN_PORT_TYPE).map((e) => e.source_node_id),
  );
  return ir.nodes.filter((n) => !triggerIds.has(n.id) && !hasMainOut.has(n.id)).map((n) => n.id);
}

/** The leaf that executed LAST (scan the ordered trace from the end); IR-last as the fallback. */
function lastExecutedLeaf(leaves: string[], trace: TraceEntry[]): string {
  const leafSet = new Set(leaves);
  for (let i = trace.length - 1; i >= 0; i--) {
    if (leafSet.has(trace[i]!.nodeId)) return trace[i]!.nodeId;
  }
  return leaves[leaves.length - 1]!;
}
