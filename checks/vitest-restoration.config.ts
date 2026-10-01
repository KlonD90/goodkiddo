import { defineConfig } from 'vitest/config';
export default defineConfig({
  cacheDir: '.scratch/vite',
  test: {
    include: [
      'src/providers/assistant-page.test.ts',
      'src/providers/assistant-stream.test.ts',
      'src/channels/telegram-rich-delivery.test.ts',
      'src/channels/telegram-markdown-chunks.test.ts',
      'src/capabilities/documents/extract.test.ts',
    ],
  },
});
