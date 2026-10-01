import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const script = () =>
  readFileSync(
    new URL('../../landing-v2/analytics.js', import.meta.url),
    'utf8',
  );
function browser(
  options: {
    key?: string;
    dnt?: string;
    gpc?: boolean;
    search?: string;
    storageFails?: boolean;
    fetchFails?: boolean;
  } = {},
) {
  const sent: { url: string; options: any }[] = [];
  const listeners = new Map<string, () => void>();
  const nodes = [
    'hero_cta_clicked',
    'hero_add_to_chat_clicked',
    'private-token',
  ].map((name) => ({
    dataset: { phEvent: name },
    addEventListener: (_event: string, callback: () => void) =>
      listeners.set(name, callback),
  }));
  const values = new Map<string, string>();
  let counter = 0;
  const context = {
    window: {
      GOODKIDDO_ANALYTICS: {
        projectKey: options.key ?? 'synthetic-project',
        apiHost: 'https://us.i.posthog.com',
        testMode: true,
      },
      navigator: { doNotTrack: options.dnt, globalPrivacyControl: options.gpc },
      location: { search: options.search ?? '?token=private-token#secret' },
      crypto: {
        randomUUID: () =>
          `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
      },
      localStorage: {
        getItem: (key: string) => {
          if (options.storageFails) throw new Error('denied');
          return values.get(key);
        },
        setItem: (key: string, value: string) => values.set(key, value),
      },
      fetch: (url: string, opts: any) => {
        sent.push({ url, options: opts });
        if (options.fetchFails) throw new Error('offline');
        return Promise.resolve({ ok: true });
      },
    },
    document: { querySelectorAll: () => nodes },
    URLSearchParams,
    Date,
    JSON,
  };
  const run = () => runInNewContext(script(), context);
  return { sent, listeners, values, run };
}
test('landing sends only pageview and allowed CTA metadata, with stable random ID and test marker', () => {
  const s = browser();
  s.run();
  s.listeners.get('hero_cta_clicked')!();
  s.listeners.get('hero_add_to_chat_clicked')!();
  expect(s.listeners.has('private-token')).toBe(false);
  const payloads = s.sent.map((e) => JSON.parse(e.options.body));
  expect(payloads.map((p) => p.event)).toEqual([
    'landing_pageview',
    'landing_cta_clicked',
    'landing_cta_clicked',
  ]);
  expect(payloads[1].properties).toMatchObject({
    source: 'landing_hero',
    destination: 'private',
    cta_location: 'hero',
    is_test: true,
    $process_person_profile: false,
    $geoip_disable: true,
  });
  expect(payloads[2].properties.destination).toBe('group');
  expect(JSON.stringify(payloads)).not.toMatch(
    /private-token|secret|current_url|referrer|username/,
  );
  expect(s.sent[0].options).toMatchObject({
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    keepalive: true,
  });
  s.run();
  expect(JSON.parse(s.sent[3].options.body).properties.distinct_id).toBe(
    payloads[0].properties.distinct_id,
  );
});
test('landing disabled config, DNT, GPC and draft emit nothing and store no identifier', () => {
  for (const options of [
    { key: '' },
    { dnt: '1' },
    { gpc: true },
    { search: '?draft' },
  ]) {
    const s = browser(options);
    s.run();
    expect(s.sent).toHaveLength(0);
    expect(s.values.size).toBe(0);
  }
});
test('landing storage and transport errors do not stop CTA handlers', () => {
  const s = browser({ storageFails: true, fetchFails: true });
  expect(s.run).not.toThrow();
  expect(() => s.listeners.get('hero_cta_clicked')!()).not.toThrow();
});
