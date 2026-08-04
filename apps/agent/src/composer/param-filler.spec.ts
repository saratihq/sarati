import { fillParams, validateParams } from './param-filler';
import type { CatalogEntry } from './workflow-client';

/**
 * The code half of the param sub-chain: whatever the focused completion
 * returns is validated against the ONE action's real schema — unknown keys
 * rejected, required keys enforced, basic type sanity. Trust lives here,
 * not in the model.
 */

const SCHEMA: Record<string, unknown> = {
  channel: { type: 'SHORT_TEXT', required: true, description: 'Channel name' },
  text: { type: 'LONG_TEXT', required: true },
  thread_ts: { type: 'SHORT_TEXT', required: false },
  link_names: { type: 'CHECKBOX', required: false },
  retry_count: { type: 'NUMBER', required: false },
  info: { type: 'MARKDOWN', required: true, description: 'Read the docs' },
};

const ENTRY: CatalogEntry = {
  type: 'slack.send_channel_message',
  name: 'Send message to channel',
  category: 'communication',
  description: '',
  auth: 'oauth2',
  parameters: SCHEMA,
};

describe('validateParams', () => {
  it('accepts a complete, well-typed fill (MARKDOWN never required)', () => {
    const verdict = validateParams(SCHEMA, {
      channel: '#expense-review',
      text: 'Expense: {{trigger.amount}}',
      link_names: true,
      retry_count: 3,
    });
    expect(verdict).toEqual({ ok: true, errors: [] });
  });

  it('rejects unknown keys — the schema is the boundary', () => {
    const verdict = validateParams(SCHEMA, { channel: '#x', text: 'hi', chanel: 'typo' });
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join(' ')).toContain('unknown parameter "chanel"');
  });

  it('rejects missing/empty required keys', () => {
    const verdict = validateParams(SCHEMA, { channel: '#x', text: '' });
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join(' ')).toContain('required parameter "text" is missing');
  });

  it('enforces NUMBER and CHECKBOX types but lets {{refs}} through anywhere', () => {
    const bad = validateParams(SCHEMA, {
      channel: '#x',
      text: 'hi',
      retry_count: 'three',
      link_names: 'yes',
    });
    expect(bad.errors).toHaveLength(2);
    const refs = validateParams(SCHEMA, { channel: '#x', text: 'hi', retry_count: '{{trigger.retries}}' });
    expect(refs.ok).toBe(true);
  });

  it('rejects setting informational (MARKDOWN) fields', () => {
    const verdict = validateParams(SCHEMA, { channel: '#x', text: 'hi', info: 'note' });
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join(' ')).toContain('informational');
  });
});

describe('fillParams (bounded retry over the completion seam)', () => {
  it('strips markdown fences and returns validated params first try', async () => {
    const complete = jest.fn().mockResolvedValue('```json\n{"channel": "#x", "text": "hi"}\n```');
    const result = await fillParams(complete, ENTRY, 'post to #x', {});
    expect(result).toEqual({ ok: true, params: { channel: '#x', text: 'hi' } });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]![1]).toContain('post to #x');
  });

  it('retries ONCE with the rejection folded in, then succeeds', async () => {
    const complete = jest
      .fn()
      .mockResolvedValueOnce('not json at all')
      .mockResolvedValueOnce('{"channel": "#x", "text": "hi"}');
    const result = await fillParams(complete, ENTRY, 'post to #x', {});
    expect(result.ok).toBe(true);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1]![1]).toContain('not a parseable JSON object');
  });

  it('gives up after two attempts with the last validation errors', async () => {
    const complete = jest.fn().mockResolvedValue('{"chanel": "#typo"}');
    const result = await fillParams(complete, ENTRY, 'post', {});
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.detail).toContain('unknown parameter "chanel"');
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('passes current values through so an edit-fill keeps context', async () => {
    const complete = jest.fn().mockResolvedValue('{"channel": "#y", "text": "hi"}');
    await fillParams(complete, ENTRY, 'switch to #y', { channel: '#x', text: 'hi' });
    expect(complete.mock.calls[0]![1]).toContain('Current values');
    expect(complete.mock.calls[0]![1]).toContain('"channel":"#x"');
  });
});
