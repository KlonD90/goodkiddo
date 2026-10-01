import net from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { parseCommand } from './protocol.js';
import type { BrowserWorkerFactory } from '../capabilities/browser/job.js';

export function socketBrowserFactory(
  path: string,
  connect: (path: string) => net.Socket = (path) => net.createConnection(path),
): BrowserWorkerFactory {
  if (path !== '/run/goodkiddo-browser/worker.sock')
    throw new Error('Invalid browser worker socket.');
  return ({ jobId, signal }) => {
    const socket = connect(path);
    const pending = new Map<
      number,
      { resolve(value: string): void; reject(error: Error): void }
    >();
    let id = 0;
    let buffer = '';
    const decoder = new StringDecoder('utf8');
    const cancelled = new Set<number>();
    let closed = false;
    const fail = () => {
      for (const item of pending.values())
        item.reject(new Error('Browser worker unavailable.'));
      pending.clear();
    };
    socket.on('error', fail);
    socket.on('close', fail);
    socket.on('data', (bytes) => {
      buffer += decoder.write(bytes);
      if (Buffer.byteLength(buffer) > 128 * 1024) {
        socket.destroy();
        return;
      }
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const result = JSON.parse(line);
          if (cancelled.delete(result.id)) continue;
          const item = pending.get(result.id);
          if (
            !item ||
            typeof result.output !== 'string' ||
            result.output.length > 20000
          )
            throw new Error();
          pending.delete(result.id);
          result.ok
            ? item.resolve(result.output)
            : item.reject(new Error('Browser read unavailable.'));
        } catch {
          socket.destroy();
          return;
        }
      }
    });
    function request(
      value: Record<string, unknown>,
      cancel: AbortSignal,
    ): Promise<string> {
      cancel.throwIfAborted();
      if (closed || socket.destroyed)
        throw new Error('Browser connection closed.');
      const requestId = ++id;
      return new Promise((resolve, reject) => {
        const abort = () => {
          pending.delete(requestId);
          cancelled.add(requestId);
          reject(new Error('Browser stopped.'));
        };
        cancel.addEventListener('abort', abort, { once: true });
        pending.set(requestId, {
          resolve: (text) => {
            cancel.removeEventListener('abort', abort);
            resolve(text);
          },
          reject: (error) => {
            cancel.removeEventListener('abort', abort);
            reject(error);
          },
        });
        socket.write(JSON.stringify({ ...value, id: requestId }) + '\n');
        if (cancel.aborted) abort();
      });
    }
    const start = request({ type: 'start', jobId }, signal);
    start.catch(() => {});
    return {
      run: async (input) => {
        await start;
        return {
          stdout: await request(
            { type: 'command', command: parseCommand(input.argv, jobId) },
            input.signal,
          ),
          stderr: '',
          exitCode: 0,
        };
      },
      dispose: async (cancel) => {
        try {
          if (socket.destroyed)
            throw new Error('Browser cleanup was not confirmed.');
          await request({ type: 'close' }, cancel);
        } finally {
          closed = true;
          socket.end();
        }
      },
    };
  };
}
