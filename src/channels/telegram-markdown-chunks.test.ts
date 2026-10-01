import { describe, expect, it } from 'vitest';
import {
  splitTelegramMarkdown,
  tableCells,
} from './telegram-markdown-chunks.js';
describe('Telegram Markdown splitting', () => {
  it('keeps short native tables intact and repeats headers for long tables', () => {
    const header = '| Item | Value |\n|---|---|';
    const rows = Array.from(
      { length: 150 },
      (_, i) => `| Item ${i} | ${'x'.repeat(50)} |`,
    );
    const chunks = splitTelegramMarkdown(header + '\n' + rows.join('\n'));
    expect(chunks.length).toBeGreaterThan(1);
    expect(
      chunks.every(
        (chunk) => [...chunk].length <= 3500 && chunk.startsWith(header),
      ),
    ).toBe(true);
    for (const row of rows)
      expect(chunks.filter((chunk) => chunk.includes(row)).length).toBe(1);
  });
  it('balances long and unfinished code fences and preserves emoji', () => {
    const body = '🚀'.repeat(6000);
    const chunks = splitTelegramMarkdown('```text\n' + body);
    expect(
      chunks.every(
        (chunk) =>
          chunk.startsWith('```text\n') &&
          chunk.endsWith('\n```') &&
          [...chunk].length <= 3500,
      ),
    ).toBe(true);
    expect(chunks.join('').match(/🚀/gu)?.length).toBe(6000);
  });
  it('renders oversized tables as complete field prose', () => {
    const headers = Array.from({ length: 21 }, (_, i) => 'Field ' + i);
    const result = splitTelegramMarkdown(
      '| ' +
        headers.join(' | ') +
        ' |\n| ' +
        headers.map(() => '---').join(' | ') +
        ' |\n| ' +
        headers.map((_, i) => 'Value ' + i).join(' | ') +
        ' |',
    ).join('\n');
    for (let i = 0; i < 21; i++)
      expect(result).toContain(`Field ${i}: Value ${i}`);
  });
  it('recognizes escaped and code pipes and stays below block limits', () => {
    expect(tableCells('| a\\|b | `c|d` |')).toEqual(['a\\|b', '`c|d`']);
    const chunks = splitTelegramMarkdown(
      Array.from({ length: 1000 }, () => '# Heading').join('\n\n'),
    );
    expect(chunks.every((chunk) => chunk.split('\n').length < 500)).toBe(true);
  });
});
