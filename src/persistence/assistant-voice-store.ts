import type { AssistantStore } from './assistant-store.js';
import type { AssistantConfig } from '../config/assistant-config.js';
import { VoiceError } from '../providers/assistant-voice.js';

export interface VoiceReceipt {
  update_id: number;
  chat_id: string;
  user_id: string;
  thread_id: number | null;
  context_version: number;
  status: string;
  cost_usd: number;
}

export function voiceBudgetMonth(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Tbilisi',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  return `${parts.find((part) => part.type === 'year')!.value}-${parts.find((part) => part.type === 'month')!.value}`;
}
export function voiceReservedCost(
  seconds: number,
  usdPerMinute: number,
): number {
  return Math.ceil(seconds / 60) * usdPerMinute;
}

export class AssistantVoiceStore {
  constructor(private readonly store: AssistantStore) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS assistant_voice_requests (
      update_id INTEGER PRIMARY KEY, chat_id TEXT NOT NULL, user_id TEXT NOT NULL,
      thread_id INTEGER, context_version INTEGER NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, cost_usd REAL NOT NULL DEFAULT 0, budget_month TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS assistant_voice_limits ON assistant_voice_requests(created_at,user_id,chat_id);`);
  }
  receipt(id: number): VoiceReceipt | null {
    return this.store.db
      .query('SELECT * FROM assistant_voice_requests WHERE update_id=?')
      .get(id) as VoiceReceipt | null;
  }
  active(): VoiceReceipt[] {
    return this.store.db
      .query(
        "SELECT * FROM assistant_voice_requests WHERE status IN ('processing','submitted')",
      )
      .all() as VoiceReceipt[];
  }
  reserve(
    receipt: Omit<VoiceReceipt, 'status' | 'cost_usd'>,
    config: AssistantConfig,
  ): void {
    const cost = voiceReservedCost(
      config.voice.maxSeconds,
      config.voice.usdPerMinute,
    );
    this.store.transaction(() => {
      const day = new Date().toISOString().slice(0, 10);
      const month = voiceBudgetMonth();
      const count = (column: 'user_id' | 'chat_id', value: string) =>
        (
          this.store.db
            .query(
              `SELECT COUNT(*) AS n FROM assistant_voice_requests WHERE ${column}=? AND created_at>=?`,
            )
            .get(value, day) as { n: number }
        ).n;
      if (
        count('user_id', receipt.user_id) >= config.voice.dailyUser ||
        count('chat_id', receipt.chat_id) >= config.voice.dailyChat
      )
        throw new VoiceError(
          'Лимит голосовых на сегодня исчерпан. Он обновится в 00:00 UTC; текст можно отправлять дальше.',
        );
      const spent = (
        this.store.db
          .query(
            'SELECT COALESCE(SUM(cost_usd),0) AS n FROM assistant_voice_requests WHERE budget_month=?',
          )
          .get(month) as { n: number }
      ).n;
      if (
        spent + cost > config.voice.monthlyBudget + 1e-9 ||
        this.store.monthSpend() + cost > config.monthlyBudget + 1e-9
      )
        throw new VoiceError(
          'Лимит расходов на голосовые исчерпан. Пришлите текст.',
        );
      this.store.db
        .query(
          'INSERT INTO assistant_voice_requests VALUES (?,?,?,?,?,?,?,?,?)',
        )
        .run(
          receipt.update_id,
          receipt.chat_id,
          receipt.user_id,
          receipt.thread_id,
          receipt.context_version,
          'processing',
          new Date().toISOString(),
          cost,
          month,
        );
      this.store.reserveSpend(`voice:${receipt.update_id}`, cost);
    });
  }
  submit(id: number, config: AssistantConfig): void {
    this.store.transaction(() => {
      const receipt = this.receipt(id)!;
      const month = voiceBudgetMonth();
      const spent = (
        this.store.db
          .query(
            'SELECT COALESCE(SUM(cost_usd),0) AS n FROM assistant_voice_requests WHERE budget_month=? AND update_id<>?',
          )
          .get(month, id) as { n: number }
      ).n;
      if (spent + receipt.cost_usd > config.voice.monthlyBudget + 1e-9)
        throw new VoiceError(
          'Лимит расходов на голосовые исчерпан. Пришлите текст.',
        );
      this.store.db
        .query(
          "UPDATE assistant_voice_requests SET status='submitted',budget_month=? WHERE update_id=?",
        )
        .run(month, id);
    });
  }
  finish(id: number, status: string, cost: number): void {
    this.store.transaction(() => {
      this.store.db
        .query(
          'UPDATE assistant_voice_requests SET status=?,cost_usd=? WHERE update_id=?',
        )
        .run(status, cost, id);
      this.store.settleSpend(`voice:${id}`, cost);
    });
  }
}
