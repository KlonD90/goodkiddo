export type ChatType = 'private' | 'group' | 'supergroup';

export interface AssistantChat {
  id: string;
  type: ChatType;
  timezone: string;
  active: number;
}

export interface Actor {
  id: string;
  name: string;
  username?: string;
}

export interface InboundRequest {
  updateId: number;
  chat: AssistantChat;
  actor: Actor;
  text: string;
  /** Current author's text, excluding quoted/document context. */
  userText?: string;
  messageDate?: string;
  forwarded?: boolean;
  interaction: 'message' | 'mention' | 'reply' | 'command' | 'button';
  messageAt?: string;
  contextVersion?: number;
  imagePaths?: string[];
  messageThreadId?: number;
  scheduled?: ScheduledTurn;
}

export type NotificationMode = 'verbose' | 'summary' | 'errors_only' | 'silent';
export interface ScheduledTurn {
  jobId: string;
  runId: string;
  revision: number;
  notification: NotificationMode;
  maxCalls: number;
  maxSearches: number;
  maxCostUsd: number;
}

export type JobKind = 'reminder' | 'meeting';
export interface MeetingData {
  options: string[];
  participants: string[];
}

export interface AssistantJob {
  id: string;
  chat_id: string;
  owner_id: string;
  kind: JobKind;
  title: string;
  due_at: string;
  remind_at: string | null;
  reminded: number;
  status:
    | 'active'
    | 'delivering'
    | 'delivery_failed'
    | 'completed'
    | 'cancelled';
  data: string;
  created_at: string;
}

export interface MeetingVote {
  job_id: string;
  user_id: string;
  username: string | null;
  name: string;
  choices: string;
}

export type TaskType =
  | 'search'
  | 'research'
  | 'report'
  | 'meeting'
  | 'reminder'
  | 'other';
export type TaskStatus =
  | 'success'
  | 'error'
  | 'refused'
  | 'timeout'
  | 'cancelled';
export interface TaskUsage {
  llm_calls: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
