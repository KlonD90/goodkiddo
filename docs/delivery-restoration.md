# Durable delivery reconciliation

Text and documents now have immutable, chat-scoped recovery snapshots independent of the
12,000-character conversation-history limit and mutable VFS contents. A reply batch stores
the full original answer plus exact rendered parts; document parts retain caption/topic and
the original file bytes until acknowledged, cancelled or expired. Parts record pending,
sending, sent, uncertain, failed, blocked and cancelled outcomes. Only confirmed parts are
reported as sent. A valid Telegram message ID is required by the real send adapter.

New sends have no Telegram idempotency key. A timeout, 5xx, malformed acknowledgement or
restart during a new send becomes uncertain; remaining parts are blocked and the automatic
queue is released. Documents follow the same rule. Definitive rejections such as flood wait
may retry with backoff. An edit to a known message ID can safely retry, and Telegram's
already-applied/not-modified response is accepted. Concurrent delivery ticks share a single
drain. Durable holds keep tool-generated documents behind their active model turn.

`/deliveries`, `/delivery ID` and the read-only `delivery_status` tool expose only same-chat
metadata and per-part outcomes. `/retry_delivery ID` is author-only and requeues immutable
unacknowledged parts, skipping confirmed parts. If a part had an ambiguous outcome, the bot
first warns about a possible duplicate and requires the author's actual command
`/retry_delivery ID confirm`. Forwarded commands and model tools cannot supply this consent.
The possibility of a previous duplicate remains visible after a confirmed manual retry.
One-time reminder `/retry ID` uses the same reconciliation; it does not rerun the model or
retransmit chunks already acknowledged. Cancelled jobs cannot be retried via the lower-level
delivery command.

Recovery snapshots expire within seven days. A reply is capped at 1 MiB, chat text snapshots
at 8 MiB, and global text snapshots at 128 MiB; at most 1,000 batches per chat, 20,000 globally,
and 256 parts per batch. Completed/cancelled batches may expire sooner under quota pressure;
unresolved snapshots are never evicted for a new response. Document bytes continue to count
against existing VFS snapshot quotas (20 MiB/file, 100 MiB/chat, 1 GiB globally). Expiry removes
outbox entries/receipts and releases document bytes; source VFS files remain intact. `/clear`
also cancels/purges response recovery payloads, preserving source files and saved tasks.

Schema additions are additive companion tables initialized by AssistantStore. Historical
outbox entries are captured before their next API request; a full answer already lost by an
older release cannot be reconstructed. No production migration/start or user file publication
occurs during local tests. Do not roll back to a September release unaware of pending document
outbox rows. Back up the production SQLite database before the first capability release;
roll back to a file-aware build while retaining additive tables and immutable pending snapshots.
