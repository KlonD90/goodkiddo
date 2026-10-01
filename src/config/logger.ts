import pino, { type Logger } from 'pino';

const serviceName = (process.env.ASSISTANT_NAME || 'claude').toLowerCase();

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  name: serviceName,
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

type LogBindings = Record<string, unknown>;

function normalizeBindings(bindings: LogBindings): LogBindings {
  const normalized = Object.fromEntries(
    Object.entries(bindings).filter(([, value]) => value !== undefined),
  );

  if (
    typeof normalized.groupName === 'string' &&
    normalized.group === undefined
  ) {
    normalized.group = normalized.groupName;
  }

  return normalized;
}

export function createScopedLogger(bindings: LogBindings): Logger {
  return logger.child(normalizeBindings(bindings));
}

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
