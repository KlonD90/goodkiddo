import type { Database } from 'bun:sqlite';
import { checkFileQuota } from './assistant-file-quota.js';
import {
  AssistantFileError,
  DEFAULT_FILE_LIMITS,
  MAX_FILE_OUTPUT_CHARS,
  fileText,
  safeMimeType,
  textBytes,
  virtualPath,
  type AssistantFileLimits,
} from './assistant-file-policy.js';

export interface AssistantFileInfo {
  path: string;
  size: number;
  mime_type: string;
  created_at: string;
  updated_at: string;
  source_date?: string | null;
}
export interface AssistantFile extends AssistantFileInfo {
  content: Uint8Array;
}

export class AssistantFiles {
  constructor(
    private readonly db: Database,
    readonly limits: AssistantFileLimits = DEFAULT_FILE_LIMITS,
  ) {}

  get(chatId: string, input: string): AssistantFile {
    const row = this.db
      .query(
        'SELECT path,content,length(content) AS size,mime_type,created_at,updated_at,source_date FROM assistant_files WHERE chat_id=? AND path=?',
      )
      .get(chatId, virtualPath(input)) as AssistantFile | null;
    if (!row) throw new AssistantFileError('Файл не найден в этом чате.');
    return row;
  }

  private info(file: AssistantFile): AssistantFileInfo {
    const { content: _, ...info } = file;
    return info;
  }

  byOrigin(chatId: string, origin: string): AssistantFileInfo | null {
    return this.db
      .query(
        'SELECT path,length(content) AS size,mime_type,created_at,updated_at,source_date FROM assistant_files WHERE chat_id=? AND origin_id=?',
      )
      .get(chatId, origin) as AssistantFileInfo | null;
  }

  list(chatId: string, directory = '/'): AssistantFileInfo[] {
    const prefix = virtualPath(directory, true);
    return this.db
      .query(
        'SELECT path,length(content) AS size,mime_type,created_at,updated_at,source_date FROM assistant_files WHERE chat_id=? AND substr(path,1,?)=? ORDER BY path',
      )
      .all(chatId, prefix.length, prefix) as AssistantFileInfo[];
  }

  private checkQuota(
    chatId: string,
    bytes: number,
    previousBytes: number,
    adding: boolean,
  ): void {
    if (bytes > this.limits.maxFileBytes)
      throw new AssistantFileError('Файл превышает допустимый размер.');
    const chat = this.db
      .query(
        'SELECT COUNT(*) AS count,COALESCE(SUM(length(content)),0) AS bytes FROM assistant_files WHERE chat_id=?',
      )
      .get(chatId) as { count: number; bytes: number };
    if (adding && chat.count >= this.limits.maxChatFiles)
      throw new AssistantFileError('В этом чате достигнут лимит числа файлов.');
    checkFileQuota(this.db, this.limits, chatId, bytes - previousBytes);
  }

  write(
    chatId: string,
    input: string,
    content: Uint8Array,
    mimeType = 'text/plain',
    origin?: string,
    sourceDate?: string,
  ): AssistantFileInfo {
    const filePath = virtualPath(input);
    return this.db.transaction(() => {
      if (origin) {
        const previous = this.byOrigin(chatId, origin);
        if (previous) return previous;
      }
      const existing = this.db
        .query(
          'SELECT path,content,length(content) AS size,mime_type,created_at,updated_at,source_date FROM assistant_files WHERE chat_id=? AND path=?',
        )
        .get(chatId, filePath) as AssistantFile | null;
      if (existing) {
        if (
          existing.content.length === content.length &&
          existing.content.every((b, i) => b === content[i])
        )
          return this.info(existing);
        throw new AssistantFileError(
          'Файл уже существует. Используйте edit_file или другое имя.',
        );
      }
      this.checkQuota(chatId, content.length, 0, true);
      const now = new Date().toISOString();
      this.db
        .query(
          'INSERT INTO assistant_files(chat_id,path,content,mime_type,origin_id,created_at,updated_at,source_date) VALUES (?,?,?,?,?,?,?,?)',
        )
        .run(
          chatId,
          filePath,
          content,
          safeMimeType(mimeType),
          origin || null,
          now,
          now,
          sourceDate || null,
        );
      return this.info(this.get(chatId, filePath));
    })();
  }

  read(chatId: string, input: string, offset = 0, limit = 100) {
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200
    )
      throw new AssistantFileError(
        'Нужны offset >= 0 и limit от 1 до 200 строк.',
      );
    const file = this.get(chatId, input);
    const lines = fileText(file.content).split('\n');
    const text = lines
      .slice(offset, offset + limit)
      .map((line, i) => `${offset + i + 1}: ${line}`)
      .join('\n');
    return {
      path: file.path,
      text: text.slice(0, MAX_FILE_OUTPUT_CHARS),
      total_lines: lines.length,
      next_offset: offset + limit < lines.length ? offset + limit : null,
      truncated: text.length > MAX_FILE_OUTPUT_CHARS,
    };
  }

  edit(
    chatId: string,
    input: string,
    oldString: string,
    newString: string,
    replaceAll = false,
  ): AssistantFileInfo {
    if (!oldString)
      throw new AssistantFileError('old_string не может быть пустым.');
    return this.db.transaction(() => {
      const file = this.get(chatId, input);
      const text = fileText(file.content);
      const occurrences = text.split(oldString).length - 1;
      if (!occurrences)
        throw new AssistantFileError('Текст для замены не найден.');
      if (occurrences > 1 && !replaceAll)
        throw new AssistantFileError(
          'Текст встречается несколько раз. Уточните фрагмент или используйте replace_all.',
        );
      const content = textBytes(
        replaceAll
          ? text.split(oldString).join(newString)
          : text.replace(oldString, () => newString),
      );
      this.checkQuota(chatId, content.length, file.size, false);
      this.db
        .query(
          'UPDATE assistant_files SET content=?,updated_at=? WHERE chat_id=? AND path=?',
        )
        .run(content, new Date().toISOString(), chatId, file.path);
      return this.info(this.get(chatId, file.path));
    })();
  }

  glob(chatId: string, pattern: string, directory = '/') {
    if (
      !pattern ||
      pattern.length > 200 ||
      /[\x00-\x1f\\]/.test(pattern) ||
      pattern.split('/').includes('..')
    )
      throw new AssistantFileError('Недопустимый шаблон виртуальных файлов.');
    const prefix = virtualPath(directory, true);
    const glob = new Bun.Glob(pattern.replace(/^\//, ''));
    const matches = this.list(chatId, prefix).filter((file) =>
      glob.match(file.path.slice(prefix.length)),
    );
    return { files: matches.slice(0, 100), truncated: matches.length > 100 };
  }

  grep(chatId: string, pattern: string, directory = '/', caseSensitive = true) {
    if (!pattern || pattern.length > 400)
      throw new AssistantFileError(
        'Нужен непустой текст поиска до 400 символов.',
      );
    const matches: { path: string; line: number; text: string }[] = [];
    const needle = caseSensitive ? pattern : pattern.toLowerCase();
    let outputSize = 0;
    for (const info of this.list(chatId, directory)) {
      let text: string;
      try {
        text = fileText(this.get(chatId, info.path).content);
      } catch (error) {
        if (error instanceof AssistantFileError) continue;
        throw error;
      }
      for (const [i, line] of text.split('\n').entries()) {
        if (!(caseSensitive ? line : line.toLowerCase()).includes(needle))
          continue;
        const excerpt = line.slice(0, 1000);
        outputSize += info.path.length + excerpt.length + 32;
        if (matches.length >= 100 || outputSize > MAX_FILE_OUTPUT_CHARS)
          return { matches, truncated: true };
        matches.push({ path: info.path, line: i + 1, text: excerpt });
      }
    }
    return { matches, truncated: false };
  }
}
