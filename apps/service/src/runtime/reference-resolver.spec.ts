import { resolveReferences } from './reference-resolver';

describe('resolveReferences', () => {
  const outputs = {
    fetch: { body: { id: 42, name: 'widget', tags: ['a', 'b'], meta: { sku: 'X-1' } }, status: 200 },
    flag: { body: true },
  };

  it('preserves the value type when a string is exactly one reference', () => {
    const out = resolveReferences(
      {
        id: '{{fetch.body.id}}',
        obj: '{{fetch.body.meta}}',
        arr: '{{fetch.body.tags}}',
        bool: '{{flag.body}}',
      },
      outputs,
    );
    expect(out.id).toBe(42); // number, not "42"
    expect(out.obj).toEqual({ sku: 'X-1' }); // object survives
    expect(out.arr).toEqual(['a', 'b']);
    expect(out.bool).toBe(true);
  });

  it('interpolates references embedded in surrounding text', () => {
    const out = resolveReferences({ label: 'item-{{fetch.body.name}}-{{fetch.status}}' }, outputs);
    expect(out.label).toBe('item-widget-200');
  });

  it('JSON-stringifies an object referenced inside interpolated text', () => {
    const out = resolveReferences({ note: 'meta=<{{fetch.body.meta}}>' }, outputs);
    expect(out.note).toBe('meta=<{"sku":"X-1"}>');
  });

  it('resolves references nested inside objects and arrays', () => {
    const out = resolveReferences(
      { body: { itemId: '{{fetch.body.id}}', items: ['{{fetch.body.name}}', 'literal'] } },
      outputs,
    );
    expect(out.body).toEqual({ itemId: 42, items: ['widget', 'literal'] });
  });

  it('indexes into arrays with numeric path segments', () => {
    const out = resolveReferences({ first: '{{fetch.body.tags.0}}' }, outputs);
    expect(out.first).toBe('a');
  });

  it('leaves non-reference strings untouched', () => {
    const out = resolveReferences({ url: 'https://example.com/x', n: 7 }, outputs);
    expect(out.url).toBe('https://example.com/x');
    expect(out.n).toBe(7);
  });

  it('throws on a reference to an unknown step', () => {
    expect(() => resolveReferences({ x: '{{nope.body}}' }, outputs)).toThrow(/unknown step "nope"/);
  });

  it('resolves a path that runs off the end of the data to undefined', () => {
    const out = resolveReferences({ x: '{{fetch.body.missing.deep}}' }, outputs);
    expect(out.x).toBeUndefined();
  });

  it('leaves reserved $-refs untouched (they are filled later, e.g. $auth by the provider)', () => {
    const out = resolveReferences(
      { whole: '{{$auth.token}}', embedded: 'Bearer {{$auth.token}}', bare: '{{ $auth }}' },
      outputs,
    );
    expect(out.whole).toBe('{{$auth.token}}');
    expect(out.embedded).toBe('Bearer {{$auth.token}}');
    expect(out.bare).toBe('{{ $auth }}');
  });

  it('does not throw on a $-ref even though no such step exists', () => {
    expect(() => resolveReferences({ x: '{{$auth.token}}' }, outputs)).not.toThrow();
  });

  describe('unresolved-ref sink (ROOT-B honesty)', () => {
    const withNull = { fetch: { body: { id: 42 }, missing: null } } as Record<string, unknown>;

    it('fires for a FULL-STRING ref that resolves to nothing (a wrong path)', () => {
      const unresolved: string[] = [];
      const out = resolveReferences({ x: '{{fetch.body.nope}}' }, withNull, (ref) => unresolved.push(ref));
      expect(out.x).toBeUndefined();
      expect(unresolved).toEqual(['fetch.body.nope']);
    });

    it('does NOT fire for an EMBEDDED ref that resolves to nothing (empty can be intentional)', () => {
      const unresolved: string[] = [];
      const out = resolveReferences({ label: 'item-{{fetch.body.nope}}' }, withNull, (ref) =>
        unresolved.push(ref),
      );
      expect(out.label).toBe('item-');
      expect(unresolved).toEqual([]);
    });

    it('does NOT fire when a full-string ref resolves to a real value (incl. null)', () => {
      const unresolved: string[] = [];
      const out = resolveReferences({ id: '{{fetch.body.id}}', n: '{{fetch.missing}}' }, withNull, (ref) =>
        unresolved.push(ref),
      );
      expect(out.id).toBe(42);
      expect(out.n).toBeNull(); // a real null is a value, not a miss
      expect(unresolved).toEqual([]);
    });

    it('does NOT fire for a reserved $-ref', () => {
      const unresolved: string[] = [];
      resolveReferences({ x: '{{$auth.token}}' }, withNull, (ref) => unresolved.push(ref));
      expect(unresolved).toEqual([]);
    });

    it('still fails fast on an unknown ROOT — the sink is never reached', () => {
      const unresolved: string[] = [];
      expect(() =>
        resolveReferences({ x: '{{nope.body}}' }, withNull, (ref) => unresolved.push(ref)),
      ).toThrow(/unknown step "nope"/);
      expect(unresolved).toEqual([]);
    });

    it('reports each distinct unresolved ref across nested props', () => {
      const unresolved: string[] = [];
      resolveReferences({ a: '{{fetch.body.x}}', arr: ['lit', '{{fetch.body.y}}'] }, withNull, (ref) =>
        unresolved.push(ref),
      );
      expect(unresolved).toEqual(['fetch.body.x', 'fetch.body.y']);
    });
  });
});
