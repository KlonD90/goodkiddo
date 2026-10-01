/**
 * Shared utilities (SSOT).
 *
 * Small helpers that were previously copy-pasted across 10+ files.
 */

import fs from 'fs';

// ── Error handling ──────────────────────────────────────────────

/** Extract a human-readable message from an unknown caught value. */
export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── JSON file I/O ───────────────────────────────────────────────

/** Read and parse a JSON file. Returns null on any failure. */
export function readJsonFile<T = unknown>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

/** Write data as JSON to a file. */
export function writeJsonFile(
  filePath: string,
  data: unknown,
  pretty = false,
): void {
  fs.writeFileSync(
    filePath,
    JSON.stringify(data, null, pretty ? 2 : undefined),
  );
}

// ── Fetch with timeout ──────────────────────────────────────────

/** Wrapper around fetch() that aborts after timeoutMs. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Time formatting ─────────────────────────────────────────────

/** Format milliseconds as Korean elapsed time (e.g. "1시간 2분 30초"). */
export function formatElapsedKorean(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}시간`);
  if (minutes > 0) parts.push(`${minutes}분`);
  parts.push(`${seconds}초`);
  return parts.join(' ');
}
