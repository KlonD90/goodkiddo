import type { InboundRequest } from '../shared/assistant-types.js';

// A forward supplies source material, not authorization to mutate chat state.
const READ_TOOLS = new Set([
  'search_web',
  'list_tasks',
  'meeting_status',
  'delivery_status',
  'memory_list',
  'history_search',
  'todo_list',
  'list_prompt_jobs',
  'prompt_job_runs',
  'prompt_job_result',
  'ls',
  'read_file',
  'glob',
  'grep',
  'read_url',
  'extract_file',
  'describe_image',
  'list_pages',
]);
export function toolAllowedForRequest(
  name: string,
  request: InboundRequest,
): boolean {
  return (!request.forwarded && !request.scheduled) || READ_TOOLS.has(name);
}
