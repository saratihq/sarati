import { appsRequiringSlot } from './env-slot-preflight';

/** The set must match what the runtime resolves — a step naming no connection resolves no slot. */
describe('apps a version needs a slot for', () => {
  const node = (type: string, parameters: Record<string, unknown>): Record<string, unknown> => ({
    id: type,
    node_type: type,
    parameters,
  });

  it('reads the real monitor: a github step, an agent and the slack/sheets legs', () => {
    const document = {
      nodes: [
        node('orchestr:schedule', { interval_minutes: 15 }),
        node('github.list_issues', { owner: 'saratihq', connectionId: 'c1' }),
        node('orchestr:code', { code: 'return 1' }),
        node('orchestr:agent', { connectionId: 'c2', model: { provider: 'claude', model: 'x' } }),
        node('slack.send_channel_message', { connectionId: 'c3' }),
        node('sheets.insert_row', { connectionId: 'c4' }),
      ],
    };
    expect(appsRequiringSlot(document)).toEqual(['claude', 'github', 'sheets', 'slack']);
  });

  it('an agent resolves under its MODEL provider, not a node-type slug', () => {
    const document = {
      nodes: [node('orchestr:agent', { connectionId: 'c', model: { provider: 'openai', model: 'x' } })],
    };
    expect(appsRequiringSlot(document)).toEqual(['openai']);
  });

  it('an agent needs its slot even with NO connectionId — the model call resolves one regardless', () => {
    const document = {
      nodes: [node('orchestr:agent', { model: { provider: 'claude', model: 'x' } })],
    };
    expect(appsRequiringSlot(document)).toEqual(['claude']);
  });

  it('ignores a step that names no connection — the runtime resolves no slot for it either', () => {
    const document = {
      nodes: [
        node('http.send_request', { url: 'https://example.com' }),
        node('hackernews.fetch_top_stories', {}),
        node('slack.send_channel_message', { connectionId: '' }),
      ],
    };
    expect(appsRequiringSlot(document)).toEqual([]);
  });

  it('survives a document that is not one', () => {
    for (const junk of [null, 'a string', 42, {}, { nodes: 'no' }, { nodes: [null, 7] }]) {
      expect(appsRequiringSlot(junk)).toEqual([]);
    }
  });
});
