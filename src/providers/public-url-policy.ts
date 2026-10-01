import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

export class PublicUrlError extends Error {}
export type Address = { address: string; family: number };
export type Resolver = (hostname: string) => Promise<Address[]>;

export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  const parsed = ipaddr.process(address);
  return parsed.range() === 'unicast';
}

export function publicUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new PublicUrlError('Некорректный URL.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new PublicUrlError(
      'Разрешены только публичные HTTP/HTTPS URL без пароля.',
    );
  if (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80'))
    throw new PublicUrlError('Нестандартные порты не разрешены.');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    host === 'localhost' ||
    (!host.includes('.') && !isIP(host)) ||
    /\.(localhost|local|internal|test|invalid|onion)$/.test(host)
  )
    throw new PublicUrlError('Локальные адреса не разрешены.');
  if (isIP(host) && !isPublicAddress(host))
    throw new PublicUrlError('Непубличный IP-адрес не разрешён.');
  url.hash = '';
  return url;
}

export async function resolvePublicUrl(
  url: URL,
  resolve: Resolver = (host) => lookup(host, { all: true, verbatim: true }),
): Promise<Address> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await resolve(host);
  if (
    !addresses.length ||
    addresses.some((item) => !isPublicAddress(item.address))
  )
    throw new PublicUrlError('DNS ведёт к непубличному адресу.');
  return addresses[0];
}
