export interface SearchResult {
  title: string;
  url: string;
  description: string;
}
export async function searchWeb(
  key: string,
  query: string,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', '5');
  const response = await fetch(url, {
    headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
  if (!response.ok) throw new Error('Поиск сейчас недоступен.');
  const payload = (await response.json()) as {
    web?: { results?: SearchResult[] };
  };
  return (payload.web?.results || []).slice(0, 5).map((result) => ({
    title: result.title.slice(0, 300),
    url: result.url,
    description: result.description.slice(0, 1800),
  }));
}
