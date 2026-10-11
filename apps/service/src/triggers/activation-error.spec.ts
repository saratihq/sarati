import { ActionError } from '@sarati/actions-sdk';

import { activationError } from './activation-error';

describe('activationError', () => {
  it('drops the error class the SDK glues on with String(err)', () => {
    expect(activationError(new Error('ActionError: HTTP 401 invalid credentials'))).toBe(
      'HTTP 401 invalid credentials',
    );
  });

  it('leaves a message that already says what to do alone', () => {
    const ssrf =
      'refusing to send a request to a private/internal address (feed.local). An operator can allow it by adding feed.local to ORCHESTR_HTTP_ALLOWED_HOSTS.';
    expect(activationError(new Error(ssrf))).toBe(ssrf);
  });

  it("says where the SDK could not get to and why, from its error's detail rather than its wording", () => {
    const unreachable = new ActionError({
      code: 'transport_unreachable',
      message: 'could not reach https://feed.example: getaddrinfo ENOTFOUND feed.example',
      detail: { origin: 'https://feed.example', reason: 'getaddrinfo ENOTFOUND feed.example' },
    });
    expect(activationError(unreachable)).toBe(
      "Couldn't reach https://feed.example (getaddrinfo ENOTFOUND feed.example) — check the address, and any egress proxy in between.",
    );
  });

  it('keeps a proxy refusal pointing at the proxy as well as the address', () => {
    const refused = new ActionError({
      code: 'transport_unreachable',
      message: 'the egress proxy refused the tunnel to https://api.github.com (403)',
      detail: { origin: 'https://api.github.com', reason: 'the egress proxy refused the tunnel (403)' },
    });
    expect(activationError(refused)).toBe(
      "Couldn't reach https://api.github.com (the egress proxy refused the tunnel (403)) — check the address, and any egress proxy in between.",
    );
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
