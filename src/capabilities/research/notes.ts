export interface ResearchFinding {
  source: string;
  summary: string;
}

export class ResearchNotes {
  private readonly sources = new Set<string>();
  private readonly findings: ResearchFinding[] = [];

  observe(result: unknown): void {
    if (!result || typeof result !== 'object') return;
    const record = result as { url?: unknown; path?: unknown };
    const source = record.url || record.path;
    if (typeof source === 'string' && source.length <= 2000)
      this.sources.add(source);
  }

  add(source: string, summary: string): void {
    if (!this.sources.has(source)) throw new Error('Source has not been read.');
    if (this.findings.length >= 12) throw new Error('Finding limit reached.');
    this.findings.push({ source, summary: summary.slice(0, 1500) });
  }

  snapshot(): ResearchFinding[] {
    return this.findings.map((finding) => ({ ...finding }));
  }

  serialize(): string {
    // JSON prevents page text from impersonating notes headings/control metadata.
    return JSON.stringify(
      {
        untrusted: true,
        observed_sources: [...this.sources],
        findings: this.findings,
      },
      null,
      2,
    );
  }
}
