export const ANALYTICS_EVENTS = new Set([
  'bot_interaction',
  'bot_started',
  'request_accepted',
  'task_started',
  'task_completed',
  'llm_usage',
  'tool_usage',
  'bot_added_to_chat',
  'bot_removed_from_chat',
]);
export type AnalyticsEvent =
  | 'bot_interaction'
  | 'bot_started'
  | 'request_accepted'
  | 'task_started'
  | 'task_completed'
  | 'llm_usage'
  | 'tool_usage'
  | 'bot_added_to_chat'
  | 'bot_removed_from_chat';
const SOURCES = new Set([
  'landing_nav',
  'landing_hero',
  'landing_meet',
  'landing_dm',
  'landing_steps',
  'landing_final',
  'direct',
  'unknown',
]);
export function startSource(value?: string): string {
  return value ? (SOURCES.has(value) ? value : 'unknown') : 'direct';
}
const ENUMS: Record<string, Set<string>> = {
  input_type: new Set(['voice', 'text']),
  interaction_type: new Set([
    'command',
    'reply',
    'mention',
    'message',
    'button',
  ]),
  task_type: new Set([
    'search',
    'research',
    'report',
    'meeting',
    'reminder',
    'other',
  ]),
  initiator: new Set(['user', 'bot']),
  status: new Set(['success', 'error', 'refused', 'timeout', 'cancelled']),
  error_type: new Set([
    'rate_limit',
    'timeout',
    'llm_error',
    'internal',
    'tool_error',
    'delivery_error',
  ]),
  source: SOURCES,
  entrypoint: new Set(['private', 'group']),
  tool_name: new Set([
    'search_web',
    'create_reminder',
    'create_meeting',
    'list_tasks',
    'cancel_task',
    'meeting_status',
    'respond_to_meeting',
    'set_timezone',
    'ls',
    'read_file',
    'write_file',
    'edit_file',
    'glob',
    'grep',
    'send_file',
    'grant_fs_access',
    'read_url',
    'extract_file',
    'describe_image',
    'retry_task_delivery',
    'delivery_status',
    'create_prompt_job',
    'list_prompt_jobs',
    'update_prompt_job',
    'prompt_job_runs',
    'prompt_job_result',
    'memory_list',
    'memory_write',
    'memory_delete',
    'history_search',
    'save_context_summary',
    'todo_add',
    'todo_list',
    'todo_update',
    'unknown',
  ]),
};
const COUNTS = new Set([
  'duration_sec',
  'llm_calls',
  'tokens_in',
  'tokens_out',
  'cost_usd',
]);
export function analyticsProperties(
  props: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === 'string' && ENUMS[key]?.has(value))
      result[key] = value;
    else if (
      COUNTS.has(key) &&
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 1e12
    )
      result[key] = value;
    else if (key === 'usage_estimated' && typeof value === 'boolean')
      result[key] = value;
    else if (
      key === 'model' &&
      typeof value === 'string' &&
      /^[a-z0-9][a-z0-9._:/-]{0,99}$/i.test(value) &&
      !value.includes('://')
    )
      result[key] = value;
    else if (
      key === 'provider' &&
      typeof value === 'string' &&
      /^[a-z0-9][a-z0-9._-]{0,99}$/i.test(value)
    )
      result[key] = value;
  }
  return result;
}
