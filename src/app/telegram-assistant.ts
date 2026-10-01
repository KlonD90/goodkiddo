import {
  loadAssistantConfig,
  type AssistantConfig,
} from '../config/assistant-config.js';
import { logger } from '../config/logger.js';
import { AssistantStore } from '../persistence/assistant-store.js';
import { AssistantAnalytics } from '../integrations/assistant-analytics.js';
import { CompatibleAssistantLlm } from '../providers/assistant-llm.js';
import {
  TelegramApiError,
  TelegramAssistantApi,
} from '../channels/telegram-assistant-api.js';
import { AssistantIngress } from '../assistant/ingress.js';
import { AssistantWorker } from '../assistant/worker.js';
import { deliverMessages } from '../assistant/delivery.js';
import { advanceAssistantJobs } from '../tasks/assistant-scheduler.js';
import { acquireAssistantLock } from './assistant-lock.js';
import { startFileLinkServer } from '../server/assistant-file-links.js';
import { expireFileGrants } from '../persistence/assistant-file-quota.js';
import { BrowserResearchRuntime } from '../assistant/browser-runtime.js';

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

export async function startTelegramAssistant(): Promise<void> {
  const config = loadAssistantConfig();
  const unlock = acquireAssistantLock(config.dbPath);
  try {
    await runService(config);
  } finally {
    unlock();
  }
}

async function runService(config: AssistantConfig): Promise<void> {
  const store = new AssistantStore(config.dbPath);
  const analytics = new AssistantAnalytics(config, store);
  const api = new TelegramAssistantApi(config.telegramToken);
  const browser = config.browserSocket
    ? new BrowserResearchRuntime(config.browserSocket)
    : undefined;
  const worker = new AssistantWorker(
    config,
    store,
    analytics,
    new CompatibleAssistantLlm(config),
    api,
    browser,
  );
  const stop = new AbortController();
  let maintenance: Promise<void> | undefined;
  let ingress: AssistantIngress | undefined;
  let fileServer: ReturnType<typeof startFileLinkServer>;
  const shutdown = () => {
    stop.abort();
    api.stop();
    fileServer?.stop(true);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    const me = await api.me();
    ingress = new AssistantIngress(store, config, analytics, api, me);
    worker.recoverInterrupted();
    fileServer = startFileLinkServer(config, store);
    maintenance = (async () => {
      let lastAnalytics = 0;
      let lastFileCleanup = 0;
      while (!stop.signal.aborted) {
        try {
          advanceAssistantJobs(store, analytics);
          if (Date.now() - lastFileCleanup > 60_000) {
            expireFileGrants(store.db);
            lastFileCleanup = Date.now();
          }
          worker.wake();
          await deliverMessages(store, api, analytics);
          if (Date.now() - lastAnalytics > 15_000) {
            lastAnalytics = Date.now();
            void analytics.flush().catch(() => {
              logger.warn('Analytics delivery deferred');
            });
          }
        } catch {
          logger.warn('Assistant background tick failed; retrying');
        }
        await delay(1000, stop.signal);
      }
    })();
    logger.info(
      {
        botVersion: config.botVersion,
        searchEnabled: !!config.braveKey,
        analyticsEnabled: analytics.enabled,
        browserEnabled: !!browser,
        voiceEnabled:
          config.voice.enabled &&
          !!config.voice.apiKey &&
          config.voice.monthlyBudget > 0,
      },
      'GoodKiddo Telegram assistant started',
    );
    let failures = 0;
    while (!stop.signal.aborted) {
      try {
        const updates = await api.updates(
          Number(store.state('telegram_offset') || 0),
        );
        for (const update of updates) {
          if (stop.signal.aborted) break;
          const outcome = await ingress.handle(update);
          logger.info(
            {
              chatType:
                update.message?.chat.type ||
                update.my_chat_member?.chat.type ||
                update.callback_query?.message?.chat.type ||
                'unknown',
              outcome,
            },
            'Telegram update handled',
          );
          store.setState('telegram_offset', String(update.update_id + 1));
          worker.wake();
        }
        failures = 0;
      } catch (error) {
        if (stop.signal.aborted) break;
        if (
          error instanceof TelegramApiError &&
          (error.code === 401 || error.code === 409)
        )
          throw error;
        failures++;
        const waitMs =
          error instanceof TelegramApiError && error.retryAfter
            ? error.retryAfter * 1000
            : Math.min(60_000, 1000 * 2 ** Math.min(failures, 6));
        logger.warn(
          { retryInSeconds: waitMs / 1000 },
          'Telegram unavailable; will retry',
        );
        await delay(waitMs, stop.signal);
      }
    }
  } finally {
    shutdown();
    await ingress?.voice.stop();
    await worker.stop();
    await maintenance;
    await analytics.shutdown().catch(() => {
      logger.warn('Analytics remains queued for next startup');
    });
    store.close();
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
  }
}

if (import.meta.main) {
  startTelegramAssistant().catch((error) => {
    // Never log raw HTTP errors: request URLs may include the Telegram token.
    const message =
      error instanceof TelegramApiError
        ? `Telegram startup failed (${error.code})`
        : error instanceof Error &&
            /^(Set |Invalid |LLM_BASE_URL|PostHog requires|Another GoodKiddo)/.test(
              error.message,
            )
          ? error.message
          : 'GoodKiddo startup failed';
    logger.error(message);
    process.exitCode = 1;
  });
}
