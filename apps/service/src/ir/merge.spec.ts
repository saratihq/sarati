import { DomainError } from '../common/domain-error';
import type { IRNode, WorkflowIR } from './models';
import { threeWayMerge, type MergeResolution } from './merge';

/**
 * The resolution-aware merge paths: field conflicts resolved by source/target/custom, edit_delete
 * keep/delete, partial resolutions, both-delete cleanliness, and illegal choices. Base diff/merge
 * behaviour is locked in native-diff-merge.spec.ts.
 */

function node(id: string, text: string, extra: Partial<IRNode> = {}): IRNode {
  return {
    id,
    name: id === 'trigger' ? 'Trigger' : `Step ${id.toUpperCase()}`,
    node_type: id === 'trigger' ? 'orchestr:trigger' : 'text.concat',
    type_version: 1,
    parameters: { texts: [text], separator: '' },
    position: { x: 100, y: 100 },
    metadata: {},
    ...extra,
  };
}

function edge(id: string, from: string, to: string) {
  return { id, source_node_id: from, source_port: 0, target_node_id: to, target_port: 0, port_type: 'main' };
}

// trigger → a → b, all present. `a`/`b` carry the given texts.
function ir(aText: string, bText: string, opts: { dropB?: boolean } = {}): WorkflowIR {
  const nodes: IRNode[] = [node('trigger', ''), node('a', aText)];
  const edges = [edge('e1', 'trigger', 'a')];
  if (!opts.dropB) {
    nodes.push(node('b', bText));
    edges.push(edge('e2', 'a', 'b'));
  }
  return {
    version: '1',
    name: 'merge-spec',
    description: '',
    nodes,
    edges,
    settings: { execution_order: 'v1', extra: {} },
    metadata: {},
  };
}

const textOf = (m: WorkflowIR, id: string): unknown =>
  (m.nodes.find((n) => n.id === id)?.parameters as { texts?: unknown[] } | undefined)?.texts?.[0];
const hasNode = (m: WorkflowIR, id: string): boolean => m.nodes.some((n) => n.id === id);
const edgesTouching = (m: WorkflowIR, id: string) =>
  m.edges.filter((e) => e.source_node_id === id || e.target_node_id === id);

describe('threeWayMerge — resolution-aware field conflicts', () => {
  // ancestor a='base'; source a='src'; target a='tgt' — the conflict path is `parameters.texts`,
  // since diffDicts diffs an array as a whole value.
  const ancestor = ir('base', 'keep');
  const source = ir('src', 'keep');
  const target = ir('tgt', 'keep');

  it('detects a field conflict and blocks with no resolutions (kind:field)', () => {
    const r = threeWayMerge(ancestor, source, target);
    expect(r.success).toBe(false);
    expect(r.merged).toBeNull();
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toMatchObject({ node_id: 'a', kind: 'field', field_path: 'parameters.texts' });
  });

  it('resolves a field conflict by source', () => {
    const resolutions: MergeResolution[] = [
      { node_id: 'a', field_path: 'parameters.texts', choice: 'source' },
    ];
    const r = threeWayMerge(ancestor, source, target, resolutions);
    expect(r.success).toBe(true);
    expect(textOf(r.merged!, 'a')).toBe('src');
  });

  it('resolves a field conflict by target', () => {
    const resolutions: MergeResolution[] = [
      { node_id: 'a', field_path: 'parameters.texts', choice: 'target' },
    ];
    const r = threeWayMerge(ancestor, source, target, resolutions);
    expect(r.success).toBe(true);
    expect(textOf(r.merged!, 'a')).toBe('tgt');
  });

  it('resolves a field conflict by custom value', () => {
    const resolutions: MergeResolution[] = [
      { node_id: 'a', field_path: 'parameters.texts', choice: 'custom', value: ['operator-authored'] },
    ];
    const r = threeWayMerge(ancestor, source, target, resolutions);
    expect(r.success).toBe(true);
    expect(textOf(r.merged!, 'a')).toBe('operator-authored');
  });

  it('rejects an illegal choice for a field conflict (keep) with a DomainError', () => {
    const resolutions: MergeResolution[] = [{ node_id: 'a', field_path: 'parameters.texts', choice: 'keep' }];
    expect(() => threeWayMerge(ancestor, source, target, resolutions)).toThrow(DomainError);
  });

  it('keeps non-conflicting changes from both sides while resolving the conflict', () => {
    // source also edits b; target leaves b — non-overlapping, should survive.
    const src = ir('src', 'src-edited-b');
    const r = threeWayMerge(ancestor, src, target, [
      { node_id: 'a', field_path: 'parameters.texts', choice: 'target' },
    ]);
    expect(r.success).toBe(true);
    expect(textOf(r.merged!, 'a')).toBe('tgt'); // resolved
    expect(textOf(r.merged!, 'b')).toBe('src-edited-b'); // source's non-conflicting edit landed
  });
});

describe('threeWayMerge — partial resolutions', () => {
  it('returns the still-unresolved conflicts when not every conflict is resolved', () => {
    // two field conflicts: node a AND node b, both edited differently on each side.
    const ancestor = ir('base-a', 'base-b');
    const source = ir('src-a', 'src-b');
    const target = ir('tgt-a', 'tgt-b');
    const both = threeWayMerge(ancestor, source, target);
    expect(both.conflicts).toHaveLength(2);

    const partial = threeWayMerge(ancestor, source, target, [
      { node_id: 'a', field_path: 'parameters.texts', choice: 'source' },
    ]);
    expect(partial.success).toBe(false);
    expect(partial.merged).toBeNull();
    expect(partial.conflicts).toHaveLength(1);
    expect(partial.conflicts[0]!.node_id).toBe('b');
  });
});

describe('threeWayMerge — edit_delete conflicts', () => {
  const ancestor = ir('base', 'base-b'); // trigger → a → b
  // source edits b; target deletes b.
  const sourceEditsB = ir('base', 'b-edited');
  const targetDeletesB = ir('base', '', { dropB: true });

  it('surfaces edit_delete (no silent delete-wins) with deleted_on and node dumps', () => {
    const r = threeWayMerge(ancestor, sourceEditsB, targetDeletesB);
    expect(r.success).toBe(false);
    expect(r.conflicts).toHaveLength(1);
    const c = r.conflicts[0]!;
    expect(c).toMatchObject({ node_id: 'b', kind: 'edit_delete', field_path: null, deleted_on: 'target' });
    // editing side (source) carries the node dump; deleting side (target) is null.
    expect(c.source_value).not.toBeNull();
    expect(c.target_value).toBeNull();
    expect(c.ancestor_value).not.toBeNull();
  });

  it('keep restores the edited node AND its incident edges from the editing side', () => {
    const r = threeWayMerge(ancestor, sourceEditsB, targetDeletesB, [
      { node_id: 'b', field_path: null, choice: 'keep' },
    ]);
    expect(r.success).toBe(true);
    expect(hasNode(r.merged!, 'b')).toBe(true);
    expect(textOf(r.merged!, 'b')).toBe('b-edited'); // the EDITED value, not ancestor
    expect(edgesTouching(r.merged!, 'b').map((e) => e.id)).toEqual(['e2']); // incident edge restored
  });

  it('delete removes the node AND its incident edges', () => {
    const r = threeWayMerge(ancestor, sourceEditsB, targetDeletesB, [
      { node_id: 'b', field_path: null, choice: 'delete' },
    ]);
    expect(r.success).toBe(true);
    expect(hasNode(r.merged!, 'b')).toBe(false);
    expect(edgesTouching(r.merged!, 'b')).toHaveLength(0);
  });

  it('works symmetrically when the SOURCE deletes and the TARGET edits', () => {
    const r = threeWayMerge(ancestor, targetDeletesB, sourceEditsB); // swap sides
    expect(r.success).toBe(false);
    const c = r.conflicts[0]!;
    expect(c).toMatchObject({ node_id: 'b', kind: 'edit_delete', deleted_on: 'source' });
    expect(c.target_value).not.toBeNull(); // target is the editing side here
    expect(c.source_value).toBeNull();

    const keep = threeWayMerge(ancestor, targetDeletesB, sourceEditsB, [
      { node_id: 'b', field_path: null, choice: 'keep' },
    ]);
    expect(hasNode(keep.merged!, 'b')).toBe(true);
    expect(textOf(keep.merged!, 'b')).toBe('b-edited');
  });

  it('rejects an illegal choice for an edit_delete conflict (source) with a DomainError', () => {
    expect(() =>
      threeWayMerge(ancestor, sourceEditsB, targetDeletesB, [
        { node_id: 'b', field_path: null, choice: 'source' },
      ]),
    ).toThrow(DomainError);
  });
});

describe('threeWayMerge — clean / both-delete invariants', () => {
  it('both-delete of the same node stays clean (C5) — no conflict, node gone', () => {
    const ancestor = ir('base', 'base-b');
    const bothDrop = ir('base', '', { dropB: true });
    const r = threeWayMerge(ancestor, bothDrop, bothDrop);
    expect(r.success).toBe(true);
    expect(r.conflicts).toHaveLength(0);
    expect(hasNode(r.merged!, 'b')).toBe(false);
  });

  it('a clean non-overlapping merge succeeds with empty resolutions', () => {
    const ancestor = ir('base-a', 'base-b');
    const source = ir('src-a', 'base-b'); // edits a
    const target = ir('base-a', 'tgt-b'); // edits b (non-overlapping)
    const r = threeWayMerge(ancestor, source, target, []);
    expect(r.success).toBe(true);
    expect(r.conflicts).toHaveLength(0);
    expect(textOf(r.merged!, 'a')).toBe('src-a');
    expect(textOf(r.merged!, 'b')).toBe('tgt-b');
  });

  it('a clean merge ignores irrelevant resolutions (lenient) and still merges', () => {
    const ancestor = ir('base-a', 'base-b');
    const source = ir('src-a', 'base-b');
    const target = ir('base-a', 'tgt-b');
    const r = threeWayMerge(ancestor, source, target, [
      { node_id: 'zzz', field_path: 'parameters.texts', choice: 'source' },
    ]);
    expect(r.success).toBe(true);
    expect(textOf(r.merged!, 'a')).toBe('src-a');
    expect(textOf(r.merged!, 'b')).toBe('tgt-b');
  });
});
