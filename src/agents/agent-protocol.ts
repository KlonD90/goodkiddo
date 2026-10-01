/**
 * Agent Protocol Constants (SSOT).
 *
 * Shared constants for host ↔ runner communication.
 * Runners are separate packages and can't import this directly —
 * they define local copies with comments referencing this file.
 */

/** Sentinel markers for robust stdout output parsing. */
export const OUTPUT_START_MARKER = '---GOODKIDDO_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---GOODKIDDO_OUTPUT_END---';

/** Regex to extract [Image: /path/to/file] tags from agent text. */
export const IMAGE_TAG_RE = /\[Image:\s*(\/[^\]]+)\]/g;

/** IPC polling interval (ms) used by runners to check for follow-up messages. */
export const IPC_POLL_MS = 500;
export const IPC_INPUT_SUBDIR = 'input';
export const IPC_CLOSE_SENTINEL = '_close';
