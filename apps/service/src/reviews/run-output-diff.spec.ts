import { diffRunOutputs } from './run-output-diff';

describe('diffRunOutputs', () => {
  it('reports no changes for identical outputs', () => {
    const out = { trigger: {}, a: { body: { text: 'hi' } } };
    expect(diffRunOutputs(out, out)).toEqual({ changed: [], added: [], removed: [] });
  });

  it('is order-insensitive on object keys', () => {
    const base = { a: { x: 1, y: 2 } };
    const head = { a: { y: 2, x: 1 } };
    expect(diffRunOutputs(base, head)).toEqual({ changed: [], added: [], removed: [] });
  });

  it('reports a changed leaf with node id, dotted path, and before/after', () => {
    const base = { announce: { body: { text: 'Deploy done' } } };
    const head = { announce: { body: { text: 'Deploy failed' } } };
    const { changed, added, removed } = diffRunOutputs(base, head);
    expect(added).toEqual([]);
    expect(removed).toEqual([]);
    expect(changed).toEqual([
      { node_id: 'announce', path: 'body.text', before: 'Deploy done', after: 'Deploy failed' },
    ]);
  });

  it('reports a changed array element by index', () => {
    const base = { fetch: { rows: [1, 2, 3] } };
    const head = { fetch: { rows: [1, 9, 3] } };
    expect(diffRunOutputs(base, head).changed).toEqual([
      { node_id: 'fetch', path: 'rows[1]', before: 2, after: 9 },
    ]);
  });

  it('reports added and removed nodes', () => {
    const base = { a: 1, b: 2 };
    const head = { a: 1, c: 3 };
    expect(diffRunOutputs(base, head)).toEqual({ changed: [], added: ['c'], removed: ['b'] });
  });

  it('treats a scalar↔object shape change as one change at the boundary', () => {
    const base = { a: { v: 'x' } };
    const head = { a: { v: { nested: true } } };
    const { changed } = diffRunOutputs(base, head);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ node_id: 'a', path: 'v' });
  });

  it('records a top-level scalar node change as the "(value)" path', () => {
    const base = { a: 'before' };
    const head = { a: 'after' };
    expect(diffRunOutputs(base, head).changed).toEqual([
      { node_id: 'a', path: '(value)', before: 'before', after: 'after' },
    ]);
  });
});
