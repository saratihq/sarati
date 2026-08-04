import { MAX_RESULT_BYTES, capPayload, toToolError, toToolResult } from './result';

const filler = (n: number): { id: string; text: string }[] =>
  Array.from({ length: n }, (_, i) => ({ id: `row-${i}`, text: 'x'.repeat(200) }));

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

describe('MCP result presentation', () => {
  it('leaves a payload under the cap untouched', () => {
    const payload = { items: filler(2), total: 2 };
    expect(capPayload(payload)).toEqual({ payload, notes: [] });
  });

  it('trims lists until the payload fits and says what it dropped', () => {
    const { payload, notes } = capPayload({ items: filler(500), total: 500 });
    expect(bytes(payload)).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect((payload as { items: unknown[] }).items.length).toBeLessThan(500);
    expect(notes[0]).toMatch(/of 500 items omitted/);
  });

  it('trims the longest list, not merely the first one it finds', () => {
    const { payload } = capPayload({ few: filler(3), many: filler(500) });
    const trimmed = payload as { few: unknown[]; many: unknown[] };
    expect(trimmed.few).toHaveLength(3);
    expect(trimmed.many.length).toBeLessThan(500);
  });

  /** A note inside structuredContent is rejected by a conforming client: outputSchema is additionalProperties:false. */
  it('never adds a key to structuredContent — the note rides the text block and _meta', () => {
    const result = toToolResult({ items: filler(500), total: 500 });
    expect(Object.keys(result.structuredContent ?? {}).sort()).toEqual(['items', 'total']);
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect((result.content[0] as { text: string }).text).toMatch(/omitted to stay within/);
    expect(result._meta?.['orchestr/truncation']).toBeDefined();
  });

  it('carries no truncation _meta when nothing was dropped', () => {
    expect(toToolResult({ items: filler(1) })._meta).toBeUndefined();
  });

  it('says so plainly when a single oversized object cannot be trimmed', () => {
    const { notes } = capPayload({ schema: 'y'.repeat(MAX_RESULT_BYTES + 1) });
    expect(notes).toEqual(['This result was truncated.']);
  });
});

describe('MCP tool failures', () => {
  it('reaches the agent as data: a machine code and the error details, not prose to parse', () => {
    const result = toToolError('An open review already exists', 'review_already_open', {
      review_id: 'rev-1',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: 'An open review already exists',
      code: 'review_already_open',
      review_id: 'rev-1',
    });
    expect((result.content[0] as { text: string }).text).toContain('review_already_open');
  });

  it('carries no code when the failure has none', () => {
    expect(toToolError('plain failure').structuredContent).toEqual({ error: 'plain failure' });
  });
});
