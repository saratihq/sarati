import { emptySettings, type IREdge, type IRNode, type WorkflowIR } from '../ir/models';
import type { RunResult } from '../runtime/run-plan';
import { extractChatReply } from '../runtime/terminal-output';

/**
 * The deterministic chat-reply rule (ADR 0045 addendum): reply = the future respond
 * node's output if present, else the unique terminal leaf, else the LAST-EXECUTED leaf
 * (never an arbitrary output key). These pure-function tests pin that contract.
 */
function node(id: string, nodeType = 'text.concat'): IRNode {
  return {
    id,
    name: id,
    node_type: nodeType,
    type_version: 1,
    parameters: {},
    position: { x: 0, y: 0 },
    metadata: {},
  };
}
function edge(source: string, target: string): IREdge {
  return {
    id: `${source}->${target}`,
    source_node_id: source,
    source_port: 0,
    target_node_id: target,
    target_port: 0,
    port_type: 'main',
  };
}
function ir(nodes: IRNode[], edges: IREdge[]): WorkflowIR {
  return {
    version: '1',
    name: 'chat',
    description: '',
    nodes,
    edges,
    settings: emptySettings(),
    metadata: {},
  };
}
function result(outputs: Record<string, unknown>, order: string[]): RunResult {
  return { planId: 'p', outputs, trace: order.map((nodeId) => ({ nodeId, output: outputs[nodeId] })) };
}

describe('extractChatReply — the deterministic terminal-node rule (ADR 0045 addendum)', () => {
  it('a single leaf downstream of the chat trigger is the reply', () => {
    const doc = ir(
      [node('chat', 'orchestr:chat'), node('step'), node('sink')],
      [edge('chat', 'step'), edge('step', 'sink')],
    );
    const reply = extractChatReply(doc, result({ step: '[hi]', sink: 'reply=[hi]' }, ['step', 'sink']));
    expect(reply).toBe('reply=[hi]');
  });

  it('the chat trigger itself is never treated as a leaf', () => {
    // A lone chat node with a single step: the step (not the trigger) is the leaf.
    const doc = ir([node('chat', 'orchestr:chat'), node('only')], [edge('chat', 'only')]);
    expect(extractChatReply(doc, result({ only: 'answer' }, ['only']))).toBe('answer');
  });

  it('multiple leaves: the LAST-EXECUTED leaf wins (via the ordered trace), not an arbitrary key', () => {
    // chat → a → leafA ; chat → b → leafB. Both leafA and leafB are terminal leaves.
    const doc = ir(
      [node('chat', 'orchestr:chat'), node('a'), node('b'), node('leafA'), node('leafB')],
      [edge('chat', 'a'), edge('chat', 'b'), edge('a', 'leafA'), edge('b', 'leafB')],
    );
    const outputs = { a: '1', b: '2', leafA: 'A', leafB: 'B' };
    // leafB executed last → it is the reply.
    expect(extractChatReply(doc, result(outputs, ['a', 'b', 'leafA', 'leafB']))).toBe('B');
    // Flip the execution order → leafA is now last.
    expect(extractChatReply(doc, result(outputs, ['b', 'a', 'leafB', 'leafA']))).toBe('A');
  });

  it('SEAM: a future first-class orchestr:respond node takes precedence over the leaf rule', () => {
    const doc = ir(
      [node('chat', 'orchestr:chat'), node('respond', 'orchestr:respond'), node('sink')],
      [edge('chat', 'respond'), edge('respond', 'sink')],
    );
    // Even though `sink` is the leaf, the respond node's output is the reply.
    expect(
      extractChatReply(doc, result({ respond: 'the answer', sink: 'ignored' }, ['respond', 'sink'])),
    ).toBe('the answer');
  });

  it('no leaf (defensive) → null', () => {
    const doc = ir([node('chat', 'orchestr:chat')], []);
    expect(extractChatReply(doc, result({}, []))).toBeNull();
  });

  // A stored document may omit `port_type`, and `edgePortType` says absent = main. Reading it as a
  // lane of its own makes every upstream node a false leaf, so a flow that stops short answers with
  // an INTERNAL node's output instead of the terminal one.
  it('an edge that omits port_type rides the main lane, exactly like an explicit one', () => {
    const laneless = (source: string, target: string): IREdge => {
      const bare: Record<string, unknown> = { ...edge(source, target) };
      delete bare.port_type;
      return bare as unknown as IREdge;
    };
    const nodes = [node('chat', 'orchestr:chat'), node('gate', 'orchestr:if'), node('leaf')];
    // The guard sent the run down the other branch, so `leaf` never produced an output.
    const stoppedShort = result({ gate: 'internal state' }, ['gate']);

    const explicit = extractChatReply(ir(nodes, [edge('chat', 'gate'), edge('gate', 'leaf')]), stoppedShort);
    const omitted = extractChatReply(
      ir(nodes, [laneless('chat', 'gate'), laneless('gate', 'leaf')]),
      stoppedShort,
    );

    expect(omitted).toEqual(explicit);
    expect(omitted).toBeUndefined();
  });
});
