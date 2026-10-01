import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export function acquireAssistantLock(databasePath: string): () => void {
  const file = `${databasePath}.lock`;
  mkdirSync(path.dirname(file), { recursive: true });
  if (existsSync(file)) {
    const pid = Number(readFileSync(file, 'utf8'));
    let live = true;
    try {
      if (!Number.isSafeInteger(pid) || pid < 1)
        throw new Error('Invalid lock file');
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') live = false;
      else throw error;
    }
    if (live)
      throw new Error(
        'Another GoodKiddo process already owns the assistant database',
      );
    unlinkSync(file);
  }
  const fd = openSync(file, 'wx', 0o600);
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  return () => {
    if (existsSync(file) && readFileSync(file, 'utf8') === String(process.pid))
      unlinkSync(file);
  };
}
