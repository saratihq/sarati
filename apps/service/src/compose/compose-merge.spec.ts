import type { IRNode, WorkflowIR } from '../ir/models';
import { emptySettings } from '../ir/models';

import { composerMerge } from './compose-merge';

function node(id: string, overrides: Partial<IRNode> = {}): IRNode {
  return {
    id,
    name: overrides.name ?? id,
    node_type: overrides.node_type ?? 'http.send_request',
    type_version: 1,
    parameters: overrides.parameters ?? {},
    position: overrides.position ?? { x: 0, y: 0 },
    metadata: {},
  };
}

function doc(nodes: IRNode[], edges: WorkflowIR['edges'] = []): WorkflowIR {
  return {
    version: '1',
    name: 'wf',
    description: '',
    nodes,
    edges,
    settings: emptySettings(),
    metadata: { engine: 'orchestr' },
  };
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('composerMerge', () => {
  it('non-conflicting edits from BOTH sides land (the co-editing moat case)', () => {
    const base = doc([node('trigger', { node_type: 'orchestr:trigger' }), node('fetch')]);
    // User renames + drags fetch…
    const ours = clone(base);
    ours.nodes[1]!.name = 'My fetch';
    ours.nodes[1]!.position = { x: 42, y: 777 };
    // …while the agent adds and wires a new step.
    const theirs = clone(base);
    theirs.nodes.push(node('notify', { node_type: 'slack.send_channel_message' }));
    theirs.edges.push({
      id: 'e-fetch-notify',
      source_node_id: 'fetch',
      source_port: 0,
      target_node_id: 'notify',
      target_port: 0,
      port_type: 'main',
    });

    const { merged, conflicts } = composerMerge(base, ours, theirs);
    expect(conflicts).toEqual([]);
    const byId = new Map(merged.nodes.map((n) => [n.id, n]));
    expect(byId.get('fetch')!.name).toBe('My fetch'); // user's rename survived
    expect(byId.get('fetch')!.position).toEqual({ x: 42, y: 777 }); // user's drag survived
    expect(byId.get('notify')).toBeDefined(); // agent's step survived
    expect(merged.edges).toHaveLength(1);
  });

  it('same node + same field changed differently → ours in merged, conflict reported with both values', () => {
    const base = doc([node('post', { parameters: { channel: '#general', text: 'hi' } })]);
    const ours = clone(base);
    ours.nodes[0]!.parameters = { channel: '#finance', text: 'hi' };
    const theirs = clone(base);
    theirs.nodes[0]!.parameters = { channel: '#alerts', text: 'hi' };

    const { merged, conflicts } = composerMerge(base, ours, theirs);
    expect(merged.nodes[0]!.parameters).toEqual({ channel: '#finance', text: 'hi' }); // user wins provisionally
    expect(conflicts).toHaveLength(1);
    // The core diffs LEAF fields — the conflict names the exact parameter.
    expect(conflicts[0]).toMatchObject({
      node_id: 'post',
      kind: 'field',
      field_path: 'parameters.channel',
      ours: '#finance',
      theirs: '#alerts',
    });
  });

  it('both sides moved the same node → user position wins SILENTLY (never a conflict)', () => {
    const base = doc([node('a')]);
    const ours = clone(base);
    ours.nodes[0]!.position = { x: 100, y: 100 };
    const theirs = clone(base);
    theirs.nodes[0]!.position = { x: 900, y: 900 };

    const { merged, conflicts } = composerMerge(base, ours, theirs);
    expect(conflicts).toEqual([]);
    expect(merged.nodes[0]!.position).toEqual({ x: 100, y: 100 });
  });

  it('agent deletes a node the user edited → node KEPT, edit_delete conflict reported', () => {
    const base = doc([node('a'), node('b', { parameters: { url: 'x' } })]);
    const ours = clone(base);
    ours.nodes[1]!.parameters = { url: 'y' }; // user edited b…
    const theirs = doc([clone(base.nodes[0]!)]); // …agent removed b

    const { merged, conflicts } = composerMerge(base, ours, theirs);
    expect(merged.nodes.map((n) => n.id)).toContain('b'); // no silent data loss
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.kind).toBe('edit_delete');
    expect(conflicts[0]!.node_id).toBe('b');
  });

  it('identical changes on both sides are clean (previously-merged agent ops re-presented as ours)', () => {
    const base = doc([node('a')]);
    const both = clone(base);
    both.nodes.push(node('new_step'));
    const { merged, conflicts } = composerMerge(base, clone(both), clone(both));
    expect(conflicts).toEqual([]);
    expect(merged.nodes.map((n) => n.id)).toEqual(['a', 'new_step']);
  });
});
