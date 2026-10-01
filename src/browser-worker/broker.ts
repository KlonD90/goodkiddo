import net from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { requestSchema } from './protocol.js';
import { BrowserContainer, type BrokerJob } from './container.js';

export function createBrowserBroker(
  image: string,
  factory: (id: string, release: () => void) => BrokerJob = (id, release) =>
    new BrowserContainer(id, image, undefined, undefined, release),
) {
  let active: BrokerJob | undefined;
  return net.createServer((socket) => {
    let job: BrokerJob | undefined;
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let busy = false;
    let started = false;
    let commands = 0;
    let lastId = 0;
    const send = (value: unknown) => {
      if (!socket.destroyed) socket.write(JSON.stringify(value) + '\n');
    };
    const release = () => {
      if (active === job) active = undefined;
    };
    const close = async () => {
      if (!job) return;
      await job.close();
      release();
    };
    socket.on('error', () => void close().catch(() => {}));
    socket.on('close', () => void close().catch(() => {}));
    socket.on('data', (bytes) => {
      buffer += decoder.write(bytes);
      if (Buffer.byteLength(buffer) > 8192) {
        socket.destroy();
        return;
      }
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let request;
        try {
          request = requestSchema.parse(JSON.parse(line));
          if (request.id <= lastId) throw new Error();
          lastId = request.id;
        } catch {
          socket.destroy();
          return;
        }
        // A close must interrupt in-flight commands and acknowledge real cleanup.
        if (request.type === 'close') {
          void close().then(
            () => send({ id: request.id, ok: true, output: '' }),
            () => send({ id: request.id, ok: false, output: '' }),
          );
          continue;
        }
        if (busy) {
          socket.destroy();
          return;
        }
        busy = true;
        void (async () => {
          try {
            if (request.type === 'start') {
              if (started || active)
                throw new Error('Browser capacity reached.');
              started = true;
              job = factory(request.jobId, release);
              active = job;
              send({ id: request.id, ok: true, output: '' });
            } else {
              if (!job || ++commands > 12)
                throw new Error('Browser job unavailable.');
              send({
                id: request.id,
                ok: true,
                output: await job.run(request.command),
              });
            }
          } catch {
            send({ id: request.id, ok: false, output: '' });
          } finally {
            busy = false;
          }
        })();
      }
    });
  });
}
export function startBrowserBroker(image: string, fd = 3) {
  const server = createBrowserBroker(image);
  server.listen({ fd });
  return server;
}
