import { BlockList, isIP } from 'node:net';

/**
 * Non-global / reserved ranges rejected for remote spec fetch (SSRF defense).
 * Covers loopback, private, link-local, metadata, multicast, unspecified,
 * documentation, and other reserved IPv4/IPv6 blocks.
 */
const NON_GLOBAL_ADDRESSES = new BlockList();

for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
] as const) {
  NON_GLOBAL_ADDRESSES.addSubnet(address, prefix, 'ipv4');
}

for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001:2::', 48],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8]
] as const) {
  NON_GLOBAL_ADDRESSES.addSubnet(address, prefix, 'ipv6');
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'metadata.goog'
]);

export function normalizedHostname(parsed: URL): string {
  return parsed.hostname.toLowerCase().replace(/^\[([^\]]+)\]$/, '$1');
}

export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[([^\]]+)\]$/, '$1');
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }
  // AWS / cloud metadata common names
  if (host === '169.254.169.254' || host.endsWith('.metadata.google.internal')) {
    return true;
  }
  return false;
}

export function isNonGlobalAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0] ?? '';
  const family = isIP(normalized);
  if (family === 4) return NON_GLOBAL_ADDRESSES.check(normalized, 'ipv4');
  if (family !== 6) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return isNonGlobalAddress(mapped);
  return NON_GLOBAL_ADDRESSES.check(normalized, 'ipv6');
}

export function isBlockedAddress(address: string): boolean {
  return isNonGlobalAddress(address);
}
