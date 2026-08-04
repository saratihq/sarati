import { lintDataRefs } from './ref-lint';

function doc(nodes: Array<Record<string, unknown>>): Record<string, unknown> {
  return { version: '1.0', name: 'wf', nodes, edges: [], settings: {}, metadata: {} };
}

function node(
  id: string,
  name: string,
  nodeType: string,
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    name,
    node_type: nodeType,
    type_version: 1,
    parameters,
    position: { x: 0, y: 0 },
    metadata: {},
  };
}

describe('lintDataRefs', () => {
  it('accepts refs to trigger, upstream actions, and wait_for_event outputs', () => {
    const ir = doc([
      node('trig1', 'Form trigger', 'orchestr:webhook_trigger', {}),
      node('aaa', 'Fetch row', 'sheets.get_row', { row: '{{trigger.row_id}}' }),
      node('www', 'Approval', 'orchestr:wait_for_event', { topic: 'ok' }),
      node('bbb', 'Notify', 'slack.send_message', {
        text: 'row {{aaa.body.id}} approved by {{www.approver}}',
      }),
    ]);
    expect(lintDataRefs(ir)).toEqual([]);
  });

  it('flags a ref whose root step does not exist', () => {
    const ir = doc([node('aaa', 'Notify', 'slack.send_message', { text: '{{ghost.field}}' })]);
    const warnings = lintDataRefs(ir);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"Notify"');
    expect(warnings[0]).toContain('{{ghost.field}}');
    expect(warnings[0]).toContain('no step "ghost" exists');
  });

  it('finds refs nested in arrays and objects, deduped per step+root', () => {
    const ir = doc([
      node('aaa', 'Notify', 'slack.send_message', {
        blocks: [{ text: '{{ghost.a}}' }, { text: '{{ghost.b}}' }],
        other: { deep: 'x-{{ghost.c}}-y' },
      }),
    ]);
    expect(lintDataRefs(ir)).toHaveLength(1);
  });

  it('flags refs to steps that produce no output (IF)', () => {
    const ir = doc([
      node('iff', 'Route it', 'orchestr:if', { left: '{{trigger.x}}', op: 'truthy' }),
      node('aaa', 'Notify', 'slack.send_message', { text: '{{iff.result}}' }),
    ]);
    const warnings = lintDataRefs(ir);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"Route it"');
    expect(warnings[0]).toContain('produces no output');
  });

  it('suggests {{trigger.…}} when a ref points at the trigger node by id', () => {
    const ir = doc([
      node('trig1', 'Form trigger', 'orchestr:webhook', {}),
      node('aaa', 'Notify', 'slack.send_message', { text: '{{trig1.email}}' }),
    ]);
    const warnings = lintDataRefs(ir);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('{{trigger.…}}');
  });

  it('flags a self-reference', () => {
    const ir = doc([node('aaa', 'Notify', 'slack.send_message', { text: '{{aaa.text}}' })]);
    const warnings = lintDataRefs(ir);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('its own output');
  });

  it('skips reserved and non-native syntax instead of crying wolf', () => {
    const ir = doc([
      node('aaa', 'Call API', 'http.send_request', {
        auth: '{{$auth.token}}',
        legacy: '{{ $json.a.b }}',
        legacyNode: '{{ $node["Other"].json.x }}',
        js: '{{ 1 + 2 }}',
        quoted: '{{ "not a ref" }}',
        empty: '{{}}',
      }),
    ]);
    expect(lintDataRefs(ir)).toEqual([]);
  });

  it('ignores trigger-node parameters and malformed docs', () => {
    const ir = doc([node('trig1', 'Poller', 'sheets.new_row_trigger', { note: '{{ghost.x}}' })]);
    expect(lintDataRefs(ir)).toEqual([]);
    expect(lintDataRefs({})).toEqual([]);
    expect(lintDataRefs({ nodes: 'nope' })).toEqual([]);
    expect(lintDataRefs({ nodes: [{ id: 1 }] })).toEqual([]);
  });

  it('accepts a loop body ref to the item variable and its index (items mode)', () => {
    const ir = doc([
      node('lp', 'Loop', 'orchestr:loop', { mode: 'items', items: '{{trigger.rows}}', item_var: 'item' }),
      node('bbb', 'Notify', 'slack.send_message', { text: '{{item.name}} at #{{itemIndex}}' }),
    ]);
    expect(lintDataRefs(ir)).toEqual([]);
  });

  it('accepts a while-loop body ref to loopRound / loopPrev', () => {
    const ir = doc([
      node('lp', 'Loop', 'orchestr:loop', {
        mode: 'while',
        condition: { left: '{{loopRound}}', op: 'lt', right: '5' },
        max_iterations: 100,
      }),
      node('bbb', 'Notify', 'slack.send_message', { text: 'round {{loopRound}} prev {{loopPrev.value}}' }),
    ]);
    expect(lintDataRefs(ir)).toEqual([]);
  });

  it('accepts a custom item_var and its Index alias', () => {
    const ir = doc([
      node('lp', 'Loop', 'orchestr:loop', { mode: 'items', items: '{{trigger.rows}}', item_var: 'row' }),
      node('bbb', 'Notify', 'slack.send_message', { text: '{{row.id}} #{{rowIndex}}' }),
    ]);
    expect(lintDataRefs(ir)).toEqual([]);
  });

  it('accepts a ref to the loop node output (its per-round array)', () => {
    const ir = doc([
      node('lp', 'Loop', 'orchestr:loop', { mode: 'items', items: '{{trigger.rows}}', item_var: 'item' }),
      node('bbb', 'Notify', 'slack.send_message', { text: '{{lp.length}} rounds' }),
    ]);
    expect(lintDataRefs(ir)).toEqual([]);
  });

  it('flags a ref to a switch, which routes and produces no output', () => {
    const ir = doc([
      node('sw', 'Route', 'orchestr:switch', { cases: [{ left: '{{trigger.x}}', op: 'eq', right: '1' }] }),
      node('bbb', 'Notify', 'slack.send_message', { text: '{{sw.result}}' }),
    ]);
    const warnings = lintDataRefs(ir);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"Route"');
    expect(warnings[0]).toContain('produces no output');
  });

  it('still flags a genuine unknown-step typo even when a loop exists', () => {
    const ir = doc([
      node('lp', 'Loop', 'orchestr:loop', { mode: 'items', items: '{{trigger.rows}}', item_var: 'item' }),
      node('bbb', 'Notify', 'slack.send_message', { text: '{{ghost.field}}' }),
    ]);
    const warnings = lintDataRefs(ir);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('no step "ghost" exists');
  });
});
