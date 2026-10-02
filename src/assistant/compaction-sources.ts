import type { AssistantConfig } from '../config/assistant-config.js';
import type { CompactionSnapshot } from '../persistence/assistant-compaction.js';
import type { LlmMessage } from '../shared/assistant-types.js';
import {
  ContextBudgetError,
  messageTokens,
  requestTokens,
} from '../providers/assistant-context-budget.js';
import { estimateScale } from '../providers/assistant-token-estimate.js';

interface SourceSegment {
  source_id: number;
  role: string;
  start: number;
  end: number;
  text: string;
}
const message = (source: SourceSegment): LlmMessage => ({
  role: 'user',
  content: JSON.stringify(source),
});

function unicodeBoundary(text: string, end: number): number {
  const before = text.charCodeAt(end - 1);
  const after = text.charCodeAt(end);
  return before >= 0xd800 &&
    before <= 0xdbff &&
    after >= 0xdc00 &&
    after <= 0xdfff
    ? end - 1
    : end;
}

// Segment by BPE budget without losing or duplicating any source character/offset.
export function splitCompactionSource(
  original: LlmMessage,
  config: AssistantConfig,
  segmentLimit: number,
): LlmMessage[] {
  if (
    Math.ceil(estimateScale(config) * messageTokens(original)) <= segmentLimit
  )
    return [original];
  const source = JSON.parse(original.content!) as SourceSegment;
  const pieces: LlmMessage[] = [];
  let start = 0;
  const part = (end: number) =>
    message({
      ...source,
      start: source.start + start,
      end: source.start + end,
      text: source.text.slice(start, end),
    });
  const fits = (end: number) =>
    Math.ceil(estimateScale(config) * messageTokens(part(end))) <= segmentLimit;
  do {
    let end = source.text.length;
    if (!fits(end)) {
      let low = start + 1;
      let high = source.text.length;
      end = start;
      while (low <= high) {
        const probe = Math.floor((low + high) / 2);
        const boundary = unicodeBoundary(source.text, probe);
        if (boundary <= start) {
          low = probe + 1;
          continue;
        }
        if (fits(boundary)) {
          end = boundary;
          low = probe + 1;
        } else high = probe - 1;
      }
      if (end <= start)
        throw new ContextBudgetError(
          'Insufficient context for a source segment',
        );
    }
    pieces.push(part(end));
    start = end;
  } while (start < source.text.length);
  return pieces;
}

export function compactionSources(
  snapshot: CompactionSnapshot,
  config: AssistantConfig,
  segmentLimit: number,
): LlmMessage[] {
  return snapshot.rows.flatMap((row) =>
    splitCompactionSource(
      message({
        source_id: row.id,
        role: row.role,
        start: 0,
        end: row.content?.length ?? 0,
        text: row.content ?? '',
      }),
      config,
      segmentLimit,
    ),
  );
}

export function takeCompactionBatch(
  fixed: LlmMessage[],
  pending: LlmMessage[],
  config: AssistantConfig,
  inputLimit: number,
): LlmMessage[] {
  if (requestTokens(fixed, [], config) >= inputLimit)
    throw new ContextBudgetError('Summary exceeds reduced context budget');
  if (
    pending.length &&
    requestTokens([...fixed, pending[0]], [], config) > inputLimit
  ) {
    const limit = Math.floor(
      (inputLimit - requestTokens(fixed, [], config)) / 2,
    );
    pending.unshift(...splitCompactionSource(pending.shift()!, config, limit));
  }
  const messages = [...fixed];
  while (
    pending.length &&
    requestTokens([...messages, pending[0]], [], config) <= inputLimit
  )
    messages.push(pending.shift()!);
  if (messages.length === fixed.length)
    throw new ContextBudgetError('Source segment exceeds context');
  return messages;
}
