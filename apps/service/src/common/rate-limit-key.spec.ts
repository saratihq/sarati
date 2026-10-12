import { rateLimitKey } from './rate-limit-key';

describe('rateLimitKey', () => {
  it('counts an IPv4 address on its own', () => {
    expect(rateLimitKey('203.0.113.7')).toBe('203.0.113.7');
  });

  it.each([
    ['2001:db8:a:b::1', '2001:db8:a:b::/64'],
    ['2001:db8:a:b:ffff:ffff:ffff:ffff', '2001:db8:a:b::/64'],
    ['2001:0DB8:000A:000B:0:0:0:1', '2001:db8:a:b::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['fe80::1%en0', 'fe80:0:0:0::/64'],
    ['64:ff9b::192.0.2.1', '64:ff9b:0:0::/64'],
  ])('counts IPv6 %s by its /64', (address, key) => {
    expect(rateLimitKey(address)).toBe(key);
  });

  it('counts an IPv4-mapped IPv6 address as the IPv4 address it carries', () => {
    expect(rateLimitKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitKey('::ffff:cb00:7107')).toBe('203.0.113.7');
  });

  it('keeps anything that is not an IP address as given, and names a missing one', () => {
    expect(rateLimitKey('garbage')).toBe('garbage');
    expect(rateLimitKey(undefined)).toBe('unknown');
  });
});
