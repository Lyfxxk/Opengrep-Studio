const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function normalizeHost(value: string): string {
  return value.replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '').toLowerCase();
}

export function isAllowedHost(hostname: string, localAddress: string | undefined): boolean {
  const host = normalizeHost(hostname);
  if (host === '') return false;
  if (LOOPBACK_HOSTS.has(host)) return true;
  if (!localAddress) return false;
  return host === normalizeHost(localAddress);
}
