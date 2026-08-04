import { coerceWebhookBody } from './triggers.service';

/**
 * The webhook trigger scope must be shape-INDEPENDENT: `{{trigger.body}}` is always the whole
 * raw payload, and an object body ALSO spreads its keys so `{{trigger.<field>}}` works.
 */
describe('coerceWebhookBody', () => {
  it('OBJECT body: sets `body` to the whole payload AND spreads its keys', () => {
    const payload = { marker: 'HELLO', nested: { a: 1 } };
    const scope = coerceWebhookBody(payload);
    // `{{trigger.body}}` = the whole raw payload …
    expect(scope.body).toEqual(payload);
    // … and `{{trigger.body.marker}}` / `{{trigger.marker}}` both resolve.
    expect((scope.body as Record<string, unknown>).marker).toBe('HELLO');
    expect(scope.marker).toBe('HELLO');
    expect(scope.nested).toEqual({ a: 1 });
  });

  it('ARRAY body: `{{trigger.body}}` is the whole array (no spread)', () => {
    const payload = [1, 2, 3];
    const scope = coerceWebhookBody(payload);
    expect(scope.body).toEqual([1, 2, 3]);
  });

  it('SCALAR body: `{{trigger.body}}` is the scalar', () => {
    expect(coerceWebhookBody('ping').body).toBe('ping');
    expect(coerceWebhookBody(42).body).toBe(42);
    expect(coerceWebhookBody(true).body).toBe(true);
  });

  it('NULL body: `{{trigger.body}}` is null (wrapped, never spread)', () => {
    expect(coerceWebhookBody(null)).toEqual({ body: null });
  });

  it('a payload with its OWN `body` key: the raw payload wins at `.body`, the key stays at `.body.body`', () => {
    const payload = { body: 'inner', marker: 'x' };
    const scope = coerceWebhookBody(payload);
    // The guarantee wins: `{{trigger.body}}` is the whole payload …
    expect(scope.body).toEqual({ body: 'inner', marker: 'x' });
    // … so the payload's own `body` is reachable at `{{trigger.body.body}}`.
    expect((scope.body as Record<string, unknown>).body).toBe('inner');
    expect(scope.marker).toBe('x');
  });
});
