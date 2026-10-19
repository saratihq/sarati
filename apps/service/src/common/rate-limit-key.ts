import { isIPv6 } from 'node:net';

/** /96 prefixes whose last 32 bits are one IPv4 client: mapped, NAT64 well-known, IPv4-translated. */
const EMBEDDED_IPV4_PREFIXES = [
  [0, 0, 0, 0, 0, 0xffff],
  [0x64, 0xff9b, 0, 0, 0, 0],
  [0, 0, 0, 0, 0xffff, 0],
];

/** The eight 16-bit groups of a valid IPv6 address, `::` and a trailing dotted IPv4 expanded. */
function hextets(address: string): number[] {
  let text = address.toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const gap = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array<string>(gap).fill('0'), ...right].map((group) => parseInt(group, 16));
}

/** What a rate limit counts against: an IPv4 address, or the /64 an IPv6 one sits in — one subscriber holds a whole /64. */
export function rateLimitKey(address: string | undefined): string {
  if (!address) return 'unknown';
  const bare = address.split('%')[0] ?? address;
  if (!isIPv6(bare)) return address;
  const groups = hextets(bare);
  if (EMBEDDED_IPV4_PREFIXES.some((prefix) => prefix.every((group, i) => groups[i] === group))) {
    const [high = 0, low = 0] = groups.slice(6);
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':')}::/64`;
}
