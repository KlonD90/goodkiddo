import { getEnv } from './env.js';

export const APPROVED_BROWSER_SOCKET = '/run/goodkiddo-browser/worker.sock';

// Absence leaves browser rendering disabled. This never connects to the worker.
export function loadBrowserConfig(
  read: (key: string) => string | undefined = getEnv,
): { browserSocket?: string } {
  const socket = read('ASSISTANT_BROWSER_SOCKET')?.trim();
  if (!socket) return {};
  if (socket !== APPROVED_BROWSER_SOCKET)
    throw new Error('Invalid ASSISTANT_BROWSER_SOCKET');
  return { browserSocket: socket };
}
