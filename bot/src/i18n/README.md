# i18n — Internationalization

Locale resolution and translation utilities for the agent.

## Locale Resolution

`locale.ts` provides locale resolution for status messages and other user-facing strings.

### Supported Locales

- `en` — English (default)
- `ru` — Russian
- `es` — Spanish

### Resolving a Locale

```typescript
import { resolveLocale, extractLocaleFromTelegram, extractLocaleFromCli } from "./i18n/locale";

// From a locale hint (e.g. Telegram language_code)
const locale = resolveLocale(userLanguageCode, configDefault);

// From Telegram update
const locale = extractLocaleFromTelegram(message.from?.language_code);

// From CLI environment (LANG / LC_ALL)
const locale = extractLocaleFromCli();
```

### Resolution Order

1. Normalize the hint (strip region, lowercase)
2. If normalized hint is a supported locale, use it
3. If config default is provided and supported, use it
4. Fall back to `en` (hardcoded default)

Normalization never throws — unknown or malformed locales resolve to the next fallback.

## Status Templates

Status templates live in `src/tools/status_templates.ts` under the `dictionaries` object.

## Adding a New Language

1. Add the locale to `SUPPORTED_LOCALES` in `locale.ts`:
   ```typescript
   export const SUPPORTED_LOCALES = ["en", "ru", "es", "fr"] as const;
   ```

2. Add the locale to `LocaleDictionary` type and `dictionaries` in `status_templates.ts`:
   ```typescript
   const dictionaries: LocaleDictionary = {
     en: { ... },
     ru: { ... },
     es: { ... },
     fr: {
       read_file: "Lecture de {file_path}",
       // ... all tool templates
     },
   };
   ```

3. Translate each template string, keeping placeholder names identical (`{path}`, `{pattern}`, etc.)

4. Add tests in `locale.test.ts` covering the new locale for exact match and fallback scenarios

5. Update `src/tools/README.md` to list the new supported locale
