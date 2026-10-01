import { createHmac } from 'node:crypto';
import { PostHog } from 'posthog-node';
import type { AssistantConfig } from '../config/assistant-config.js';
import type { AssistantStore } from '../persistence/assistant-store.js';
import type {
  AssistantChat,
  TaskStatus,
  TaskType,
} from '../shared/assistant-types.js';
import {
  ANALYTICS_EVENTS,
  analyticsProperties,
  type AnalyticsEvent,
} from './assistant-analytics-policy.js';

interface EventPayload {
  distinctId: string;
  event: AnalyticsEvent;
  timestamp: string;
  properties: Record<string, unknown>;
}
export interface AnalyticsClient {
  capture(payload: Omit<EventPayload, 'timestamp'> & { timestamp: Date }): void;
  flush(): Promise<unknown>;
  shutdown(): Promise<unknown>;
}
function posthogClient(config: AssistantConfig): AnalyticsClient {
  const host = new URL(config.posthogHost);
  if (
    host.protocol !== 'https:' ||
    host.username ||
    host.password ||
    host.search ||
    host.hash ||
    host.pathname !== '/'
  )
    throw new Error('Invalid analytics host');
  const client = new PostHog(config.posthogKey!, {
    host: host.origin,
    disableGeoip: true,
    flushInterval: 0,
    flushAt: 100,
    maxQueueSize: 200,
    requestTimeout: 3000,
    fetchRetryCount: 0,
    enableExceptionAutocapture: false,
    enableLocalEvaluation: false,
  });
  // Never log SDK errors: they may include credentials or request bodies.
  client.on('error', () => {});
  return client;
}

export class AssistantAnalytics {
  private readonly client?: AnalyticsClient;
  private flushing?: Promise<void>;
  constructor(
    private readonly config: AssistantConfig,
    private readonly store: AssistantStore,
    createClient: (config: AssistantConfig) => AnalyticsClient = posthogClient,
  ) {
    if (!config.posthogKey || !config.analyticsSalt) return;
    try {
      this.client = createClient(config);
    } catch {
      /* Optional analytics cannot prevent startup. */
    }
  }
  get enabled(): boolean {
    return !!this.client;
  }
  private hash(kind: string, value: string): string {
    return createHmac('sha256', this.config.analyticsSalt!)
      .update(`${kind}:${value}`)
      .digest('hex')
      .slice(0, 16);
  }
  track(
    key: string,
    event: AnalyticsEvent,
    chat: AssistantChat,
    userId: string | null,
    props: Record<string, unknown> = {},
  ): void {
    if (!this.client || !ANALYTICS_EVENTS.has(event)) return;
    try {
      const insertId = this.hash('event', key);
      const properties = analyticsProperties(props);
      if (typeof props.task_id === 'string')
        properties.task_id = `t_${this.hash('task', props.task_id)}`;
      const payload: EventPayload = {
        distinctId: userId
          ? `u_${this.hash('user', userId)}`
          : `c_${this.hash('chat', chat.id)}`,
        event,
        timestamp: new Date().toISOString(),
        properties: {
          ...properties,
          $insert_id: insertId,
          $process_person_profile: false,
          $geoip_disable: true,
          chat_id: `c_${this.hash('chat', chat.id)}`,
          chat_type: chat.type,
          audience:
            this.config.internalChats.has(chat.id) ||
            (userId && this.config.internalUsers.has(userId))
              ? 'internal'
              : 'external',
          bot_version: /^[a-z0-9._-]{1,80}$/i.test(this.config.botVersion)
            ? this.config.botVersion
            : 'unknown',
          app: 'goodkiddo_bot',
          schema_version: 2,
          is_test: this.config.analyticsTestMode === true,
        },
      };
      // Bound an extended analytics outage. No message/file content is queued here.
      this.store.db
        .query(
          'INSERT OR IGNORE INTO assistant_events SELECT ?,? WHERE (SELECT COUNT(*) FROM assistant_events)<10000',
        )
        .run(insertId, JSON.stringify(payload));
    } catch {
      /* Optional event storage must not roll back bot work/delivery. */
    }
  }
  start(
    id: string,
    chat: AssistantChat,
    userId: string | null,
    type: TaskType,
    initiator: 'user' | 'bot',
  ): void {
    // Runs are core state (budgets/delivery), even with analytics disabled.
    this.store.startRun(id, chat, userId, type);
    this.track(`${id}:start`, 'task_started', chat, userId, {
      task_id: id,
      task_type: type,
      initiator,
    });
  }
  finish(
    id: string,
    chat: AssistantChat,
    userId: string | null,
    status: TaskStatus,
    errorType?: string,
  ): void {
    this.store.transaction(() => {
      const row = this.store.db
        .query('SELECT * FROM assistant_runs WHERE id=?')
        .get(id) as {
        status: string;
        task_type: string;
        started_at: string;
        user_id: string | null;
      } | null;
      if (!row || row.status !== 'running') return;
      this.store.db
        .query('UPDATE assistant_runs SET status=?,finished_at=? WHERE id=?')
        .run(status, new Date().toISOString(), id);
      this.track(`${id}:complete`, 'task_completed', chat, userId, {
        task_id: id,
        task_type: row.task_type,
        status,
        initiator: row.user_id ? 'user' : 'bot',
        duration_sec: Math.max(
          0,
          (Date.now() - Date.parse(row.started_at)) / 1000,
        ),
        ...this.store.runUsage(id),
        ...(errorType ? { error_type: errorType } : {}),
      });
    });
  }
  flush(): Promise<void> {
    if (!this.client) return Promise.resolve();
    if (this.flushing) return this.flushing;
    this.flushing = this.sendPending().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }
  private async sendPending(): Promise<void> {
    const rows = this.store.db
      .query('SELECT id,payload FROM assistant_events LIMIT 100')
      .all() as { id: string; payload: string }[];
    if (!rows.length) return;
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as EventPayload;
      // Only transmit the audited schema; do not backfill historical payloads.
      if (payload.properties.schema_version !== 2) continue;
      this.client!.capture({
        ...payload,
        timestamp: new Date(payload.timestamp),
      });
    }
    await this.client!.flush();
    this.store.transaction(() => {
      for (const row of rows)
        this.store.db
          .query('DELETE FROM assistant_events WHERE id=?')
          .run(row.id);
    });
  }
  async shutdown(): Promise<void> {
    try {
      await this.flush();
    } finally {
      await this.client?.shutdown();
    }
  }
}
