# Contributing

## Source Code Changes

**Accepted:** Bug fixes, security fixes, simplifications, reducing code.

**Not accepted:** Features, capabilities, compatibility, enhancements. These should be skills.

## Maintainability Standard

Follow the canonical writing standard in [`MAINTAINABILITY.md`](MAINTAINABILITY.md).

Default review expectations:

- New code should keep one clear responsibility per file and function.
- Edited legacy code should be improved opportunistically when the change already touches that area.
- Do not grow hotspot files or functions without a clear reason.
- Split code when a module starts mixing transport, policy, persistence, formatting, or lifecycle concerns.
- Prefer explicit domain terms, predictable control flow, and comments that explain intent.

Use this short checklist during review:

- Is the file easy to scan top-to-bottom?
- Are side effects near the edges?
- Is state ownership obvious?
- Are subsystem boundaries still clear?
- If the file or function is large, is that justified?

## Skills

A [skill](https://code.claude.com/docs/en/skills) is a markdown file in `.claude/skills/` that teaches Claude Code how to transform a GoodKiddo installation.

A PR that contributes a skill should not modify any source files.

Your skill should contain the **instructions** Claude follows to add the feature—not pre-built code. See `/add-telegram` for a good example.

### Why?

Every user should have clean and minimal code that does exactly what they need. Skills let users selectively add features to their fork without inheriting code for features they don't want.

### Testing

Test your skill by running it on a fresh clone before submitting.
