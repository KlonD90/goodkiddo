const MAX_CHARS = 3500;
const MAX_BLOCKS = 200;

function pieces(text: string, limit: number): string[] {
  const result: string[] = [];
  const chars = [...text];
  while (chars.length > limit) {
    const sample = chars.slice(0, limit).join('');
    const boundary = Math.max(
      sample.lastIndexOf('\n'),
      sample.lastIndexOf(' '),
    );
    const count =
      boundary > limit / 2 ? [...sample.slice(0, boundary + 1)].length : limit;
    result.push(chars.splice(0, count).join(''));
  }
  if (chars.length) result.push(chars.join(''));
  return result;
}
export function tableCells(line: string): string[] {
  const cells: string[] = [];
  let cell = '',
    escaped = false,
    code = false;
  for (const char of line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')) {
    if (escaped) {
      cell += '\\' + char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '`') code = !code;
    if (char === '|' && !code) {
      cells.push(cell.trim());
      cell = '';
    } else cell += char;
  }
  if (escaped) cell += '\\';
  cells.push(cell.trim());
  return cells;
}
function tableParts(lines: string[]): string[] {
  const headers = tableCells(lines[0]);
  const prefix = lines.slice(0, 2).join('\n');
  if (
    headers.length > 20 ||
    [...prefix].length > MAX_CHARS / 2 ||
    lines.some((line) => [...line].length > MAX_CHARS - [...prefix].length - 1)
  ) {
    // Oversized cells/columns remain readable prose instead of an invalid/truncated table.
    return lines.length === 2
      ? headers.flatMap((header) => pieces(header, MAX_CHARS))
      : lines
          .slice(2)
          .flatMap((row) =>
            tableCells(row).flatMap((value, i) =>
              pieces(`${headers[i] || `Поле ${i + 1}`}: ${value}`, MAX_CHARS),
            ),
          );
  }
  const result: string[] = [];
  let chunk = prefix;
  for (const row of lines.slice(2)) {
    if ([...chunk].length + [...row].length + 1 > MAX_CHARS) {
      result.push(chunk);
      chunk = prefix;
    }
    chunk += '\n' + row;
  }
  result.push(chunk);
  return result;
}
function isSeparator(line: string): boolean {
  const cells = tableCells(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}
function markdownBlocks(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; ) {
    if (!lines[i].trim()) {
      i++;
      continue;
    }
    const fence = lines[i].match(/^ {0,3}(`{3,}|~{3,})([^\n]*)$/);
    if (fence) {
      const opening = lines[i++];
      const content: string[] = [];
      const closing = fence[1];
      while (
        i < lines.length &&
        !new RegExp(`^ {0,3}${closing[0]}{${closing.length},}\\s*$`).test(
          lines[i],
        )
      )
        content.push(lines[i++]);
      if (i < lines.length) i++;
      const capacity =
        MAX_CHARS - [...opening].length - [...closing].length - 2;
      if (capacity < 100) {
        blocks.push(...pieces(content.join('\n'), MAX_CHARS));
        continue;
      }
      const chunks = pieces(content.join('\n'), capacity);
      blocks.push(
        ...(chunks.length ? chunks : ['']).map(
          (chunk) => `${opening}\n${chunk}\n${closing}`,
        ),
      );
      continue;
    }
    if (
      i + 1 < lines.length &&
      isSeparator(lines[i + 1]) &&
      tableCells(lines[i]).length > 1
    ) {
      const table = [lines[i++], lines[i++]];
      while (
        i < lines.length &&
        lines[i].trim() &&
        tableCells(lines[i]).length > 1
      )
        table.push(lines[i++]);
      blocks.push(...tableParts(table));
      continue;
    }
    const paragraph = [lines[i++]];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^ {0,3}(`{3,}|~{3,})/.test(lines[i]) &&
      !(i + 1 < lines.length && isSeparator(lines[i + 1]))
    ) {
      if (paragraph.length >= MAX_BLOCKS) break;
      paragraph.push(lines[i++]);
    }
    blocks.push(...pieces(paragraph.join('\n'), MAX_CHARS));
  }
  return blocks;
}
export function splitTelegramMarkdown(text: string): string[] {
  const chunks: string[] = [];
  let chunk = '',
    blocks = 0;
  for (const block of markdownBlocks(text.trim() || 'Готово.')) {
    const count = Math.max(1, block.split('\n').length);
    if (
      chunk &&
      ([...chunk].length + [...block].length + 2 > MAX_CHARS ||
        blocks + count > MAX_BLOCKS)
    ) {
      chunks.push(chunk);
      chunk = '';
      blocks = 0;
    }
    chunk += (chunk ? '\n\n' : '') + block;
    blocks += count;
  }
  if (chunk) chunks.push(chunk);
  return chunks.length ? chunks : ['Готово.'];
}
