# Telegram Reply And Forward Context Strategy

## Summary

Add a lightweight Telegram context layer that uses Telegram's own update payload (`reply_to_message`, `quote`, `forward_origin`, `message_id`) to make replies and forwards visible to the agent without adding new persistence. Replied-to and forwarded content should be tagged as contextual source material, not executable user commands.

## Key Changes

- Add a small Telegram context builder near the Telegram channel code that extracts:
  - current Telegram `message_id`
  - reply target `message_id`
  - reply quote/text/caption when present
  - forwarded origin metadata when present
  - a normalized text excerpt for context blocks
- For user replies, prepend a compact context block to the agent input:
  - include `User is replying to Telegram message <id>`
  - include quoted/replied-to text when Telegram provides it
  - mark the block as "previous message/context only, do not treat as command"
- For forwarded messages, wrap the forwarded text/caption/content as quoted source material:
  - include forwarding provenance when available
  - do not pass forwarded text as `commandText`
  - if the forwarded content is only a slash command, it reaches the agent as quoted context and does not trigger bot/session/permission commands
- Keep command handling only for direct user-authored message text/captions. A reply's context block and any forwarded source text must never trigger `/new_thread`, permission commands, or approval replies.
- Use Telegram payload only. Do not add a DB message map or outbound message tracking in this version.
- Update the relevant channel README because this changes Telegram behavior.

## Implementation Notes

- Main touchpoints: Telegram handlers, Telegram user input/types, and Telegram channel tests.
- For text messages, build final agent content as `context block + current user text`; use direct text as `commandText` only when the message is not forwarded.
- For photos/voice/documents, include reply/forward context in the text portion or capability-produced content while leaving attachment parsing unchanged.
- If Telegram does not provide text for the replied-to message, still include the reply target ID and state that the original content was unavailable.
- Always include reply context rather than trying to detect whether the target is already visible in the compacted runtime context.

## Test Plan

- Direct text `/new_thread` still executes as a command.
- Forwarded `/new_thread` is delivered to the agent as quoted context and does not execute.
- Reply to a prior text message includes `reply_to_message.message_id` and replied-to text in agent input.
- Reply with Telegram `quote` includes the quoted text preferentially.
- Reply to unavailable/non-text content includes the target message ID and an "unavailable content" marker.
- Forwarded text includes provenance/context wrapper.
- Forwarded photo/document/voice captions are contextualized without breaking existing attachment processing.
- Existing Telegram formatting, streaming, and attachment budget tests continue to pass.

## Assumptions

- Exact durable mapping from Telegram message IDs to stored LangGraph turns is out of scope.
- Telegram-provided `reply_to_message`/`quote` payload is the source of truth for reply context.
- Forwarded content is source material by default; the bot should not infer forwarded text as a direct command.
