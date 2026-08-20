import { emptySettings, type WorkflowIR } from '../ir/models';
import { layoutAllNodes, separateOverlappingNodes } from './apply-ops';

/** The node is 244 wide, so anything closer than that overlaps and the chain reads as one block. */
const NODE_WIDTH = 244;

function chain(positions: Array<{ x: number; y: number }>): WorkflowIR {
  const ids = positions.map((_, i) => `n${i}`);
  return {
    version: '1.0',
    name: 'chain',
    description: '',
    nodes: positions.map((position, i) => ({
      id: ids[i]!,
      name: ids[i]!,
      node_type: i === 0 ? 'orchestr:webhook' : 'text.concat',
      type_version: 1,
      position,
      metadata: {},
      parameters: {},
    })),
    edges: ids.slice(1).map((id, i) => ({
      id: `e${i}`,
      source_node_id: ids[i]!,
      source_port: 0,
      target_node_id: id,
      target_port: 0,
      port_type: 'main' as const,
    })),
    settings: emptySettings(),
    metadata: {},
  };
}

const overlaps = (ir: WorkflowIR): boolean =>
  ir.nodes.some((a) =>
    ir.nodes.some(
      (b) =>
        a.id !== b.id && Math.abs(a.position.x - b.position.x) < NODE_WIDTH && a.position.y === b.position.y,
    ),
  );

describe('tidying a document written elsewhere', () => {
  it('separates a chain authored tighter than the node is wide', () => {
    // The real case: hand-authored at a 220 pitch, with two nodes 40 apart.
    const ir = chain([
      { x: 0, y: 0 },
      { x: 220, y: 0 },
      { x: 440, y: 0 },
      { x: 660, y: 0 },
      { x: 700, y: 0 },
    ]);
    expect(overlaps(ir)).toBe(true);

    layoutAllNodes(ir);

    expect(overlaps(ir)).toBe(false);
    const xs = ir.nodes.map((n) => n.position.x).sort((a, b) => a - b);
    expect(xs.every((x, i) => i === 0 || x - xs[i - 1]! >= NODE_WIDTH)).toBe(true);
  });

  it('keeps the chain in its own order — tidying is not reordering', () => {
    const ir = chain([
      { x: 0, y: 0 },
      { x: 220, y: 0 },
      { x: 440, y: 0 },
    ]);
    layoutAllNodes(ir);
    const byId = new Map(ir.nodes.map((n) => [n.id, n.position.x]));
    expect(byId.get('n0')!).toBeLessThan(byId.get('n1')!);
    expect(byId.get('n1')!).toBeLessThan(byId.get('n2')!);
  });

  it('handles a document whose nodes all sit on the same spot', () => {
    const ir = chain([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ]);
    layoutAllNodes(ir);
    expect(overlaps(ir)).toBe(false);
  });
});

describe('repairing a document as it lands', () => {
  it('separates a chain authored tighter than a node is wide', () => {
    const ir = chain([
      { x: 0, y: 0 },
      { x: 220, y: 0 },
      { x: 440, y: 0 },
      { x: 660, y: 0 },
      { x: 700, y: 0 },
    ]);
    expect(separateOverlappingNodes(ir)).toBe(true);
    expect(overlaps(ir)).toBe(false);
  });

  it('leaves a deliberate layout BYTE-IDENTICAL — the content key must not move', () => {
    const ir = chain([
      { x: 0, y: 0 },
      { x: 300, y: 0 },
      { x: 600, y: 0 },
    ]);
    const before = JSON.stringify(ir);
    expect(separateOverlappingNodes(ir)).toBe(false);
    expect(JSON.stringify(ir)).toBe(before);
  });

  it('leaves a wide hand-arranged layout alone, however unusual', () => {
    const ir = chain([
      { x: 0, y: 0 },
      { x: 900, y: 400 },
      { x: 120, y: 800 },
    ]);
    const before = JSON.stringify(ir);
    expect(separateOverlappingNodes(ir)).toBe(false);
    expect(JSON.stringify(ir)).toBe(before);
  });

  it('moves only what clashes, keeping the rest where the author put it', () => {
    const ir = chain([
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1020, y: 0 },
    ]);
    const first = { ...ir.nodes[0]!.position };
    const second = { ...ir.nodes[1]!.position };
    expect(separateOverlappingNodes(ir)).toBe(true);
    expect(ir.nodes[0]!.position).toEqual(first);
    expect(ir.nodes[1]!.position).toEqual(second);
    expect(overlaps(ir)).toBe(false);
  });
});
