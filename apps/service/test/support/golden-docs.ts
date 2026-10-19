/** One IR node at the origin. */
export const irNode = (id: string, node_type: string, parameters: Record<string, unknown>) => ({
  id,
  name: id,
  node_type,
  type_version: 1,
  parameters,
  position: { x: 0, y: 0 },
  metadata: {},
});

/** One IR edge, `main` unless named. */
export const irEdge = (from: string, to: string, port_type = 'main') => ({
  id: `${from}->${to}`,
  source_node_id: from,
  source_port: 0,
  target_node_id: to,
  target_port: 0,
  port_type,
});

/** A workflow document of `nodes` and `edges`. */
export const ir = (nodes: unknown[], edges: unknown[]) => ({
  version: '1.0',
  name: 'golden',
  description: '',
  nodes,
  edges,
  settings: { execution_order: 'v1', extra: {} },
  metadata: {},
});

const callableTrigger = irNode('trigger', 'orchestr:tool_trigger', {
  tool_name: 'echo',
  description: 'Echoes its input',
  inputs: [{ name: 'q', type: 'string', description: 'input', required: false }],
});

/** A workflow another can call that answers with what it was given. */
export const ECHO_CHILD = ir(
  [callableTrigger, irNode('echo', 'text.concat', { texts: ['ECHO:', '{{trigger.q}}'], separator: '' })],
  [irEdge('trigger', 'echo')],
);

/** A workflow another can call whose first step fails into an error lane, which answers. */
export const LANE_CHILD = ir(
  [
    callableTrigger,
    irNode('boom', 'orchestr:code', { language: 'js', code: 'throw new Error("boom failed");' }),
    irNode('h', 'text.concat', { texts: ['HANDLED:', '{{trigger.q}}'], separator: '' }),
  ],
  [irEdge('trigger', 'boom'), irEdge('boom', 'h', 'error')],
);
