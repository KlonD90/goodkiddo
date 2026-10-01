/**
 * Credential proxy for reviewer container isolation.
 * Containers connect here instead of directly to AI APIs.
 * The proxy injects real credentials so containers never see them.
 *
 * Routing is provider-aware rather than vendor-hardcoded:
 *   - explicit provider via x-goodkiddo-provider
 *   - inferred provider via x-goodkiddo-model
 *   - path-based fallback
 *   - registry default fallback
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import {
  buildCredentialProviderRegistry,
  detectProviderAuthMode,
  resolveProviderAuth,
  resolveProviderIdForRequest,
  type ProviderAuthMode,
} from '../providers/credential-providers.js';
import { logger } from '../config/logger.js';

export type AuthMode = Exclude<ProviderAuthMode, 'none'>;

function getHeaderValue(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function removeHeader(
  headers: Record<string, string | number | string[] | undefined>,
  name: string,
): void {
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) {
      delete headers[key];
    }
  }
}

function buildProxyHeaders(
  req: import('http').IncomingMessage,
  body: Buffer,
): Record<string, string | number | string[] | undefined> {
  const headers: Record<string, string | number | string[] | undefined> = {
    ...(req.headers as Record<string, string>),
    'content-length': body.length,
  };

  for (const name of [
    'connection',
    'keep-alive',
    'transfer-encoding',
    'x-goodkiddo-provider',
    'x-goodkiddo-model',
  ]) {
    removeHeader(headers, name);
  }

  return headers;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const registry = buildCredentialProviderRegistry();
  const defaultProviderId = registry.defaultProviderId;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const providerId = resolveProviderIdForRequest({
          providerId: getHeaderValue(req.headers['x-goodkiddo-provider']),
          model: getHeaderValue(req.headers['x-goodkiddo-model']),
          path: req.url || '/',
          registry,
        });
        const provider = providerId
          ? registry.providers.get(providerId)
          : undefined;

        if (!provider) {
          logger.error(
            {
              providerId,
              url: req.url,
              availableProviders: Array.from(registry.providers.keys()),
            },
            'Credential proxy could not resolve upstream provider',
          );
          res.writeHead(502);
          res.end('Bad Gateway');
          return;
        }

        proxyToProvider(provider, req, res, body);
      });
    });

    server.listen(port, host, () => {
      logger.info(
        {
          port,
          host,
          defaultProviderId,
          providers: Array.from(registry.providers.keys()),
        },
        'Credential proxy started',
      );
      resolve(server);
    });

    server.on('error', reject);
  });
}

function proxyToProvider(
  provider: ReturnType<
    typeof buildCredentialProviderRegistry
  >['providers'] extends Map<string, infer T>
    ? T
    : never,
  req: import('http').IncomingMessage,
  res: import('http').ServerResponse,
  body: Buffer,
): void {
  const upstreamBaseUrl = new URL(provider.baseUrl);
  const upstreamUrl = new URL(req.url || '/', upstreamBaseUrl);
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;
  const headers = buildProxyHeaders(req, body);

  headers.host = upstreamUrl.host;

  const auth = resolveProviderAuth(provider);
  if (auth) {
    removeHeader(headers, auth.headerName);
    headers[auth.headerName] = auth.scheme
      ? `${auth.scheme} ${auth.token}`
      : auth.token;
  }

  const upstream = makeRequest(
    {
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || (isHttps ? 443 : 80),
      path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
      method: req.method,
      headers,
    } as RequestOptions,
    (upRes) => {
      res.writeHead(upRes.statusCode!, upRes.headers);
      upRes.pipe(res);
    },
  );

  upstream.on('error', (err) => {
    logger.error(
      {
        err,
        providerId: provider.id,
        url: req.url,
        upstream: provider.baseUrl,
      },
      'Credential proxy upstream error',
    );
    if (!res.headersSent) {
      res.writeHead(502);
      res.end('Bad Gateway');
    }
  });

  upstream.write(body);
  upstream.end();
}

export function detectAuthMode(): AuthMode {
  const mode = detectProviderAuthMode('anthropic');
  return mode === 'none' ? 'oauth' : mode;
}
