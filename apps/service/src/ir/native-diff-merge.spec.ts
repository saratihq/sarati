import { applyDiff, computeDiff, type IRDiff, type IRDiffEntry } from './diff';
import { deepEqual, type IREdge, type IRNode, type WorkflowIR } from './models';
import { threeWayMerge } from './merge';

/**
 * The source-of-truth regression guard for the version-control engine (`ir/diff.ts` + `ir/merge.ts`).
 * Every assertion states the CORRECT behaviour of a constitution invariant
 * (`src/domain/README.md`) in human terms — never an opaque byte-snapshot of what the code emits.
 * A red test here means either a regression or a deliberate amendment that says so.
 */

// ── Native IR builders ────────────────────────────────────────────────────────

function node(id: string, nodeType: string, parameters: Record<string, unknown> = {}, name?: string): IRNode {
  return {
    id, // caller-assigned STABLE id — identity, independent of `name` (native model)
    name: name ?? id,
    node_type: nodeType,
    type_version: 1,
    parameters,
    position: { x: 0, y: 0 },
    credentials: null, // the canonical stored dump carries every field (incl. credentials: null)
    metadata: {},
  };
}

function edge(
  source: string,
  target: string,
  opts: { port?: number; portType?: string; targetPort?: number; id?: string } = {},
): IREdge {
  const port = opts.port ?? 0;
  const portType = opts.portType ?? 'main';
  return {
    id: opts.id ?? `e-${source}-${port}-${portType}-${target}`,
    source_node_id: source,
    source_port: port,
    target_node_id: target,
    target_port: opts.targetPort ?? 0,
    port_type: portType,
  };
}

function ir(nodes: IRNode[], edges: IREdge[] = []): WorkflowIR {
  return {
    version: '1',
    name: 'native-wf',
    description: '',
    nodes,
    edges,
    settings: { execution_order: 'v1', extra: {} },
    metadata: { engine: 'orchestr' },
  };
}

const findEntry = (d: IRDiff, pred: (e: IRDiffEntry) => boolean): IRDiffEntry | undefined =>
  d.entries.find(pred);
const opsOf = (d: IRDiff): string[] => d.entries.map((e) => e.operation);

// A canonical 3-node native workflow: webhook trigger → format → notify.
function baseline(): WorkflowIR {
  return ir(
    [
      node('trigger', 'orchestr:webhook', { path: 'orders' }, 'Order webhook'),
      node('format', 'text.concat', { texts: ['Hello'], separator: ' ' }, 'Format message'),
      node('notify', 'slack.send_message', { channel: '#ops', text: '{{format.body.result}}' }, 'Notify'),
    ],
    [edge('trigger', 'format'), edge('format', 'notify')],
  );
}

// ── computeDiff — node adds / edits / deletes ─────────────────────────────────

describe('computeDiff (native) — node operations', () => {
  it('an unchanged document diffs to nothing (underpins the no-diff-mints-nothing invariant)', () => {
    const d = computeDiff(baseline(), baseline());
    expect(d.entries).toEqual([]);
    expect(d.summary).toBe('No changes');
  });

  it('adding a node emits one add_node carrying the full node dump', () => {
    const before = baseline();
    const after = ir(
      [...before.nodes, node('log', 'http.send_request', { method: 'POST', url: 'http://x/log' }, 'Log')],
      before.edges,
    );
    const d = computeDiff(before, after);
    expect(opsOf(d)).toEqual(['add_node']);
    const add = d.entries[0]!;
    expect(add.target_id).toBe('log');
    expect(add.target_name).toBe('Log');
    expect(add.old_value).toBeNull();
    expect(add.new_value).toMatchObject({ id: 'log', node_type: 'http.send_request', name: 'Log' });
    expect(d.summary).toContain('1 node(s) added');
  });

  it('editing a node parameter emits one modify_node at the dotted path with old+new', () => {
    const before = baseline();
    const after = structuredIr(before, (nodes) => {
      nodes.get('format')!.parameters = { texts: ['Goodbye'], separator: ' ' };
    });
    const d = computeDiff(before, after);
    expect(opsOf(d)).toEqual(['modify_node']);
    expect(d.entries[0]).toMatchObject({
      operation: 'modify_node',
      target_id: 'format',
      path: 'parameters.texts',
      old_value: ['Hello'],
      new_value: ['Goodbye'],
    });
  });

  it('deleting a node emits remove_node (and the diff is asymmetric to adding it back)', () => {
    const before = baseline();
    const after = ir(
      before.nodes.filter((n) => n.id !== 'notify'),
      before.edges.filter((e) => e.target_node_id !== 'notify'),
    );
    const d = computeDiff(before, after);
    expect(opsOf(d)).toContain('remove_node');
    const rem = findEntry(d, (e) => e.operation === 'remove_node')!;
    expect(rem.target_id).toBe('notify');
    expect(rem.new_value).toBeNull();
    expect(rem.old_value).toMatchObject({ id: 'notify', node_type: 'slack.send_message' });
    // the edge into notify is removed too
    expect(findEntry(d, (e) => e.operation === 'remove_edge')).toBeDefined();
  });

  it('adds are sorted by id and precede removes (deterministic entry order)', () => {
    const before = ir([node('b', 'text.concat'), node('c', 'text.concat')]);
    const after = ir([node('a', 'text.concat'), node('z', 'text.concat')]);
    const d = computeDiff(before, after);
    // add a, add z (sorted), then remove b, remove c (sorted).
    expect(d.entries.map((e) => `${e.operation}:${e.target_id}`)).toEqual([
      'add_node:a',
      'add_node:z',
      'remove_node:b',
      'remove_node:c',
    ]);
  });
});

// ── Native node IDENTITY: a rename is a first-class rename_node on a STABLE id ──

describe('computeDiff (native) — node identity & rename', () => {
  it('renaming a node keeps its stable id → one rename_node op, NOT an add+remove pair', () => {
    const before = baseline();
    const after = structuredIr(before, (nodes) => {
      nodes.get('notify')!.name = 'Alert on-call';
    });
    const d = computeDiff(before, after);
    // The id is unchanged, so identity is preserved: this is a rename, not a churn.
    expect(opsOf(d)).toEqual(['rename_node']);
    expect(d.entries[0]).toMatchObject({
      operation: 'rename_node',
      target_id: 'notify',
      path: 'name',
      old_value: 'Notify',
      new_value: 'Alert on-call',
    });
  });

  it('the rename-detection heuristic (a delete+add of the same type) is presentational and OFF by default', () => {
    // Swap one node for a fresh id of the same type at the same slot — a plausible "rename".
    const before = ir([node('old', 'text.concat', { texts: ['x'] }, 'Step')]);
    const after = ir([node('new', 'text.concat', { texts: ['x'] }, 'Step renamed')]);

    const plain = computeDiff(before, after);
    expect(opsOf(plain).sort()).toEqual(['add_node', 'remove_node']);
    expect(plain.renames).toEqual([]);

    const presentational = computeDiff(before, after, { detectRenames: true });
    // WITH detection the pair collapses to a rename — but only for DISPLAY.
    expect(presentational.renames).toEqual([{ old_name: 'Step', new_name: 'Step renamed' }]);
    expect(opsOf(presentational)).toContain('rename_node');
    expect(opsOf(presentational)).not.toContain('add_node');
  });
});

// ── Edge diffs: endpoint tuple (incl. port_type & source_port) is the identity ─

describe('computeDiff (native) — edge identity', () => {
  it('adding and removing an edge emit add_edge / remove_edge with the full edge dump', () => {
    const a = ir([node('x', 'text.concat'), node('y', 'text.concat')], [edge('x', 'y')]);
    const b = ir([node('x', 'text.concat'), node('y', 'text.concat')], []);
    const removed = computeDiff(a, b);
    expect(opsOf(removed)).toEqual(['remove_edge']);
    expect(removed.entries[0]!.old_value).toMatchObject({ source_node_id: 'x', target_node_id: 'y' });

    const added = computeDiff(b, a);
    expect(opsOf(added)).toEqual(['add_edge']);
    expect(added.entries[0]!.new_value).toMatchObject({ source_node_id: 'x', target_node_id: 'y' });
  });

  it('a main edge and an error edge between the SAME nodes are structurally DISTINCT (port_type in the key, invariant 12)', () => {
    // before: only a main edge x→y. after: main edge unchanged, PLUS an error edge x→y.
    const before = ir([node('x', 'http.send_request'), node('y', 'slack.send_message')], [edge('x', 'y')]);
    const after = ir(
      [node('x', 'http.send_request'), node('y', 'slack.send_message')],
      [edge('x', 'y'), edge('x', 'y', { portType: 'error' })],
    );
    const d = computeDiff(before, after);
    // The main edge is untouched; ONLY the error edge is added — they never collapse.
    expect(opsOf(d)).toEqual(['add_edge']);
    expect(d.entries[0]!.new_value).toMatchObject({
      port_type: 'error',
      source_node_id: 'x',
      target_node_id: 'y',
    });
  });

  it('a tool edge binds a tool, distinct from a main edge between the same nodes (invariant 14)', () => {
    // An agent already wired to a `search` node on `main` gains a `tool` edge to it: the
    // `tool` edge is a FIRST-CLASS added edge, and the `main` edge is untouched — they never
    // collapse (the endpoint tuple keys `port_type`). Adding/removing a tool is a reviewable diff.
    const before = ir(
      [node('agent', 'orchestr:agent'), node('search', 'slack.send_message')],
      [edge('agent', 'search')],
    );
    const after = ir(
      [node('agent', 'orchestr:agent'), node('search', 'slack.send_message')],
      [edge('agent', 'search'), edge('agent', 'search', { portType: 'tool' })],
    );
    const added = computeDiff(before, after);
    expect(opsOf(added)).toEqual(['add_edge']);
    expect(added.entries[0]!.new_value).toMatchObject({
      port_type: 'tool',
      source_node_id: 'agent',
      target_node_id: 'search',
    });
    // Removing ONLY the main edge leaves the tool edge intact (tuple identity, applyDiff).
    const roundTripped = applyDiff(before, computeDiff(before, after));
    expect(
      roundTripped.edges.map((e) => `${e.source_node_id}->${e.target_node_id}:${e.port_type}`).sort(),
    ).toEqual(['agent->search:main', 'agent->search:tool']);
    const droppedMain = ir(after.nodes, [edge('agent', 'search', { portType: 'tool' })]);
    const removeMain = computeDiff(after, droppedMain);
    expect(opsOf(removeMain)).toEqual(['remove_edge']);
    expect(removeMain.entries[0]!.old_value).toMatchObject({ port_type: 'main' });
  });

  it('an IF/switch/loop branch edge is keyed by source_port — port 0 and port 1 are different edges', () => {
    // before: check→a on port 0. after: keep port-0 edge, add a port-1 (else) edge to a different node.
    const before = ir(
      [node('check', 'orchestr:if', { left: '{{trigger.x}}', op: 'truthy' }), node('a', 'text.concat')],
      [edge('check', 'a', { port: 0 })],
    );
    const after = ir(
      [
        node('check', 'orchestr:if', { left: '{{trigger.x}}', op: 'truthy' }),
        node('a', 'text.concat'),
        node('b', 'text.concat'),
      ],
      [edge('check', 'a', { port: 0 }), edge('check', 'b', { port: 1 })],
    );
    const d = computeDiff(before, after);
    // b is added; the port-1 edge is added; the port-0 edge is untouched.
    expect(opsOf(d).sort()).toEqual(['add_edge', 'add_node']);
    const addEdge = findEntry(d, (e) => e.operation === 'add_edge')!;
    expect(addEdge.new_value).toMatchObject({ source_node_id: 'check', source_port: 1, target_node_id: 'b' });
  });
});

// ── modify_settings ───────────────────────────────────────────────────────────

describe('computeDiff (native) — settings', () => {
  it('a settings change emits modify_settings under the settings.* path', () => {
    const before = baseline();
    const after = { ...baseline(), settings: { execution_order: 'v2', extra: {} } };
    const d = computeDiff(before, after);
    expect(opsOf(d)).toEqual(['modify_settings']);
    expect(d.entries[0]).toMatchObject({
      operation: 'modify_settings',
      target_id: 'settings',
      path: 'settings.execution_order',
      old_value: 'v1',
      new_value: 'v2',
    });
  });
});

// ── Stored documents that omit fields ─────────────────────────────────────────

/**
 * `computeDiff` answers "did the content change?" for whatever is IN the database (invariant #4),
 * and a hand-written or legacy version can omit `position`, `parameters`, `metadata` or `settings`.
 * Throwing on one 500s that workflow's diff view forever AND, on the commit path, lets a no-diff
 * commit mint a version (invariant #3).
 */
describe('computeDiff (native) — a stored document missing optional fields', () => {
  const stripped = (drop: string): WorkflowIR => {
    const doc = baseline();
    for (const n of doc.nodes) delete (n as unknown as Record<string, unknown>)[drop];
    return doc;
  };

  it.each(['position', 'parameters', 'metadata', 'credentials'])(
    'diffs a node with no %s instead of throwing',
    (field) => {
      expect(computeDiff(stripped(field), stripped(field)).entries).toEqual([]);
      expect(() => computeDiff(stripped(field), baseline())).not.toThrow();
    },
  );

  it('diffs a document with no settings block instead of throwing', () => {
    const doc = baseline();
    delete (doc as unknown as Record<string, unknown>).settings;
    expect(computeDiff(doc, doc).entries).toEqual([]);
  });

  it('reads an edge with no port_type as the main lane, so it does not churn into add+remove', () => {
    const withLane = ir([node('a', 'text.concat'), node('b', 'text.concat')], [edge('a', 'b')]);
    const laneless = JSON.parse(JSON.stringify(withLane)) as WorkflowIR;
    delete (laneless.edges[0] as unknown as Record<string, unknown>).port_type;
    expect(computeDiff(laneless, withLane).entries).toEqual([]);
  });
});

// ── applyDiff round-trips ──────────────────────────────────────────────────────

describe('applyDiff (native) — round-trips computeDiff', () => {
  const roundTrip = (before: WorkflowIR, after: WorkflowIR): void => {
    const applied = applyDiff(before, computeDiff(before, after));
    expect(deepEqual(applied, after)).toBe(true);
  };

  it('round-trips an add + a param edit + a rename together', () => {
    const before = baseline();
    const after = structuredIr(before, (nodes, w) => {
      nodes.get('format')!.parameters = { texts: ['Hi'], separator: '' };
      nodes.get('notify')!.name = 'Ping';
      w.nodes.push(node('audit', 'http.send_request', { method: 'POST', url: 'http://x/a' }, 'Audit'));
      w.edges.push(edge('notify', 'audit'));
    });
    roundTrip(before, after);
  });

  it('round-trips a node deletion (cascading its incident edges)', () => {
    const before = baseline();
    const after = ir(
      before.nodes.filter((n) => n.id !== 'format'),
      before.edges.filter((e) => e.source_node_id !== 'format' && e.target_node_id !== 'format'),
    );
    roundTrip(before, after);
  });

  it('round-trips an error-edge addition without disturbing the main edge', () => {
    const before = ir([node('x', 'http.send_request'), node('h', 'slack.send_message')], [edge('x', 'h')]);
    const after = ir(
      [node('x', 'http.send_request'), node('h', 'slack.send_message')],
      [edge('x', 'h'), edge('x', 'h', { portType: 'error' })],
    );
    roundTrip(before, after);
  });
});

// ── threeWayMerge — the field-level conflict invariant (constitution row 5) ────

describe('threeWayMerge (native) — field-level within a node', () => {
  it('non-overlapping edits on both branches combine cleanly (no conflict)', () => {
    const ancestor = baseline();
    const source = structuredIr(ancestor, (nodes) => {
      nodes.get('format')!.parameters = { texts: ['from-source'], separator: ' ' };
    });
    const target = structuredIr(ancestor, (nodes) => {
      nodes.get('notify')!.parameters = { channel: '#alerts', text: '{{format.body.result}}' };
    });
    const r = threeWayMerge(ancestor, source, target);
    expect(r.success).toBe(true);
    expect(r.conflicts).toEqual([]);
    // both edits landed
    expect(nodeParams(r.merged!, 'format').texts).toEqual(['from-source']);
    expect(nodeParams(r.merged!, 'notify').channel).toBe('#alerts');
  });

  it('SAME node, SAME path edited differently on both branches → one field conflict, merge blocked', () => {
    const ancestor = baseline();
    const source = structuredIr(ancestor, (nodes) => {
      nodes.get('format')!.parameters = { texts: ['source-wins'], separator: ' ' };
    });
    const target = structuredIr(ancestor, (nodes) => {
      nodes.get('format')!.parameters = { texts: ['target-wins'], separator: ' ' };
    });
    const r = threeWayMerge(ancestor, source, target);
    expect(r.success).toBe(false);
    expect(r.merged).toBeNull();
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toMatchObject({
      node_id: 'format',
      kind: 'field',
      field_path: 'parameters.texts',
      source_value: ['source-wins'],
      target_value: ['target-wins'],
      ancestor_value: ['Hello'],
    });
  });

  it('SAME node, DIFFERENT paths edited on each branch → both apply, NO conflict', () => {
    const ancestor = baseline();
    const source = structuredIr(ancestor, (nodes) => {
      nodes.get('notify')!.parameters.channel = '#src';
    });
    const target = structuredIr(ancestor, (nodes) => {
      nodes.get('notify')!.parameters.text = 'target text';
    });
    const r = threeWayMerge(ancestor, source, target);
    expect(r.success).toBe(true);
    expect(r.conflicts).toEqual([]);
    expect(nodeParams(r.merged!, 'notify').channel).toBe('#src');
    expect(nodeParams(r.merged!, 'notify').text).toBe('target text');
  });

  it('a RENAME on one branch and a PARAM edit to the same node on the other are different paths → both apply, never a conflict', () => {
    // Rename is (node_id, "name"); param edit is (node_id, "parameters.*"): distinct keys.
    const ancestor = baseline();
    const renamer = structuredIr(ancestor, (nodes) => {
      nodes.get('format')!.name = 'Compose';
    });
    const editor = structuredIr(ancestor, (nodes) => {
      nodes.get('format')!.parameters = { texts: ['edited'], separator: ' ' };
    });
    const r = threeWayMerge(ancestor, renamer, editor);
    expect(r.success).toBe(true);
    expect(r.conflicts).toEqual([]);
    const format = r.merged!.nodes.find((n) => n.id === 'format')!;
    expect(format.name).toBe('Compose'); // rename survived
    expect((format.parameters as { texts: string[] }).texts).toEqual(['edited']); // edit survived
  });

  it('merge uses rename-detection OFF: a delete+re-add of the same node type is NOT silently treated as a rename', () => {
    // ancestor has `format`. source edits `format`. target removes `format` and adds a lookalike `format2`.
    const ancestor = baseline();
    const source = structuredIr(ancestor, (nodes) => {
      nodes.get('format')!.parameters = { texts: ['src-edit'], separator: ' ' };
    });
    const target = ir(
      [
        ...ancestor.nodes.filter((n) => n.id !== 'format'),
        node('format2', 'text.concat', { texts: ['Hello'], separator: ' ' }, 'Format message'),
      ],
      ancestor.edges.filter((e) => e.source_node_id !== 'format' && e.target_node_id !== 'format'),
    );
    const r = threeWayMerge(ancestor, source, target);
    // target's delete of `format` vs source's edit of `format` surfaces as edit_delete —
    // NOT collapsed into a rename (which would corrupt the merge). No silent data loss.
    expect(r.success).toBe(false);
    expect(r.conflicts.some((c) => c.node_id === 'format' && c.kind === 'edit_delete')).toBe(true);
  });
});

// ── threeWayMerge — structural (edges) ────────────────────────────────────────

describe('threeWayMerge (native) — structural combine', () => {
  it('a main edge added on one branch and an error edge added on the other both survive (distinct edges)', () => {
    const ancestor = ir(
      [node('a', 'http.send_request'), node('b', 'slack.send_message'), node('h', 'slack.send_message')],
      [edge('a', 'b')],
    );
    const source = ir(ancestor.nodes, [edge('a', 'b'), edge('b', 'h')]); // add a main edge
    const target = ir(ancestor.nodes, [edge('a', 'b'), edge('a', 'h', { portType: 'error' })]); // add an error edge
    const r = threeWayMerge(ancestor, source, target);
    expect(r.success).toBe(true);
    const keys = r.merged!.edges.map((e) => `${e.source_node_id}->${e.target_node_id}:${e.port_type}`).sort();
    expect(keys).toEqual(['a->b:main', 'a->h:error', 'b->h:main']);
  });

  // ── B4 / constitution #12+#13: edge identity is the TUPLE, never the id label ──
  it('removing a main edge on one branch does NOT collapse a SAME-id error edge (edge identity = tuple)', () => {
    // A main + an error edge between the SAME nodes share an id (edgeId omits
    // port_type). Removing the main on one branch must leave the error intact.
    const SHARED = 'e-a-b';
    const ancestor = ir(
      [node('a', 'http.send_request'), node('b', 'slack.send_message')],
      [edge('a', 'b', { id: SHARED }), edge('a', 'b', { id: SHARED, portType: 'error' })],
    );
    const source = ir(ancestor.nodes, [edge('a', 'b', { id: SHARED, portType: 'error' })]); // drop the MAIN edge
    const target = ir(ancestor.nodes, ancestor.edges); // untouched
    const r = threeWayMerge(ancestor, source, target);
    expect(r.success).toBe(true);
    const keys = r.merged!.edges.map((e) => `${e.source_node_id}->${e.target_node_id}:${e.port_type}`).sort();
    // The error edge SURVIVES; only the main is gone. Removing by id would collapse both.
    expect(keys).toEqual(['a->b:error']);
  });

  it('a main edge on one branch and a SAME-node error edge on the other both land (tuple keys never collide)', () => {
    const ancestor = ir([node('a', 'http.send_request'), node('b', 'slack.send_message')], []);
    const source = ir(ancestor.nodes, [edge('a', 'b', { id: 'e-a-b' })]); // add MAIN a→b
    const target = ir(ancestor.nodes, [edge('a', 'b', { id: 'e-a-b', portType: 'error' })]); // add ERROR a→b (same id)
    const r = threeWayMerge(ancestor, source, target);
    expect(r.success).toBe(true);
    const keys = r.merged!.edges.map((e) => `${e.source_node_id}->${e.target_node_id}:${e.port_type}`).sort();
    expect(keys).toEqual(['a->b:error', 'a->b:main']); // both survive; neither drops the other
  });
});

// ── threeWayMerge — add/add whole-node conflict (B4 / constitution row 5) ───────

describe('threeWayMerge (native) — add/add whole-node conflict', () => {
  const base = (): WorkflowIR => ir([node('a', 'http.send_request')], []);
  // Both branches add the SAME new node id `n` with DIFFERENT content.
  const withNode = (params: Record<string, unknown>, name: string): WorkflowIR =>
    ir([node('a', 'http.send_request'), node('n', 'text.concat', params, name)], []);

  it('surfaces a WHOLE-NODE conflict (field_path null), not a phantom field conflict', () => {
    const r = threeWayMerge(base(), withNode({ texts: ['S'] }, 'Src'), withNode({ texts: ['T'] }, 'Tgt'));
    expect(r.success).toBe(false);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toMatchObject({ node_id: 'n', kind: 'field', field_path: null });
  });

  it("resolving 'source' lands the SOURCE node — not silently the target's (the B4 bug)", () => {
    const source = withNode({ texts: ['S'] }, 'Src');
    const target = withNode({ texts: ['T'] }, 'Tgt');
    const r = threeWayMerge(base(), source, target, [{ node_id: 'n', field_path: null, choice: 'source' }]);
    expect(r.success).toBe(true);
    const n = r.merged!.nodes.find((x) => x.id === 'n')!;
    expect(n.name).toBe('Src');
    expect((n.parameters as { texts: string[] }).texts).toEqual(['S']); // SOURCE won, as chosen
  });

  it("resolving 'target' lands the TARGET node", () => {
    const r = threeWayMerge(base(), withNode({ texts: ['S'] }, 'Src'), withNode({ texts: ['T'] }, 'Tgt'), [
      { node_id: 'n', field_path: null, choice: 'target' },
    ]);
    expect(r.success).toBe(true);
    const n = r.merged!.nodes.find((x) => x.id === 'n')!;
    expect((n.parameters as { texts: string[] }).texts).toEqual(['T']);
  });

  it('the chosen side keeps its incident edges (node + wiring restored together)', () => {
    // source adds `n` AND a main edge a→n; target adds `n` with no edge.
    const source = ir(
      [node('a', 'http.send_request'), node('n', 'text.concat', { texts: ['S'] }, 'Src')],
      [edge('a', 'n', { id: 'e-a-n' })],
    );
    const target = withNode({ texts: ['T'] }, 'Tgt');
    const r = threeWayMerge(base(), source, target, [{ node_id: 'n', field_path: null, choice: 'source' }]);
    expect(r.success).toBe(true);
    expect(r.merged!.edges.map((e) => `${e.source_node_id}->${e.target_node_id}`)).toEqual(['a->n']);
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Clone `base` and mutate it through a node-id map (readable "edit the doc" test setup). */
function structuredIr(
  base: WorkflowIR,
  mutate: (nodes: Map<string, IRNode>, w: WorkflowIR) => void,
): WorkflowIR {
  const clone: WorkflowIR = JSON.parse(JSON.stringify(base)) as WorkflowIR;
  mutate(new Map(clone.nodes.map((n) => [n.id, n])), clone);
  return clone;
}

function nodeParams(w: WorkflowIR, id: string): Record<string, unknown> {
  return w.nodes.find((n) => n.id === id)!.parameters;
}
