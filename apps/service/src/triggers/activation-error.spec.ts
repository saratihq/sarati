import { activationError } from './activation-error';

describe('activationError', () => {
  it('drops the error class the SDK glues on with String(err)', () => {
    // What a user actually read before this existed: "TypeError: fetch failed".
    expect(activationError(new Error('ActionError: HTTP 401 invalid credentials'))).toBe(
      'HTTP 401 invalid credentials',
    );
  });

  it('turns a bare transport failure into something the user can act on', () => {
    expect(activationError(new TypeError('fetch failed'))).toBe(
      "Couldn't reach it — check the address is right and reachable from the internet.",
    );
    expect(activationError(new Error('TypeError: fetch failed'))).toBe(
      "Couldn't reach it — check the address is right and reachable from the internet.",
    );
  });

  it('leaves a message that already says what to do alone', () => {
    const ssrf =
      'refusing to send a request to a private/internal address (feed.local → 127.0.0.1). Set ORCHESTR_HTTP_ALLOWED_HOSTS to allow it.';
    expect(activationError(new Error(ssrf))).toBe(ssrf);
  });

  it('keeps a lowercase word that merely looks like a class prefix', () => {
    expect(activationError(new Error('rss: the feed returned no items'))).toBe(
      'rss: the feed returned no items',
    );
  });

  it('bounds the stored message', () => {
    expect(activationError(new Error('x'.repeat(2000)))).toHaveLength(1000);
  });

  it('survives a non-Error throw', () => {
    expect(activationError('polling is off')).toBe('polling is off');
  });
});
