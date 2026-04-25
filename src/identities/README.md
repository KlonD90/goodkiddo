# identities

System prompts that define agent behavior. Loaded as raw markdown via `?raw`.

## Curated Presets

Only presets registered in `registry.ts` are visible to users via `/identity`. The registry is explicit — adding a new `.md` file does **not** automatically expose it.

| File | Preset id | Label | Description |
|---|---|---|---|
| `GOOD_KIDDO.md` | `good_kiddo` | Good Kiddo | **Default.** Friendly, patient helper — explains clearly, asks when unsure. |
| `DO_IT_DOGGO.md` | `do_it_doggo` | Do-It Doggo | Action-first agent — executes fast, reports results, minimal narration. |
| `BUSINESS_DOGGO.md` | `business_doggo` | Business Doggo | Proactive strategist — analyzes every turn, builds frameworks, schedules research autonomously. |

## Adding a New Preset

1. Write a new `.md` file in this directory.
2. Open `registry.ts` and add an entry to the `REGISTRY` array:
   ```ts
   {
     id: "my_preset",       // stable lowercase slug, used in commands and DB
     label: "My Preset",   // human-readable Telegram label
     description: "...",   // one-line purpose shown in /identity list
     prompt: MY_PRESET,    // imported via ?raw at the top of the file
   }
   ```
3. Add a `registry.test.ts` coverage assertion if the preset has special resolution behavior.

## Development / Test Prompts

- `ECHO.md` — sample/test prompt. Not registered; not visible to users.
