# Repo Notes

- This repository uses Bun workspaces. Do not use `pnpm` or `npm` commands here.
- Use plain `bun ...` commands from the repository root unless a task explicitly needs a workspace-local working directory.
- Workspaces are `bot/`, `landing/`, and `web/`; bot source lives under `bot/src/`, and the embedded bot browser UI source lives under `web/src/`.
- When a task changes behavior, setup, architecture, or operational workflow, update the relevant `README.md` docs before finishing the task.

## Bun HTML asset notes

- Social preview metadata in `landing/index.html` and `web/index.html` should use absolute public URLs, for example `https://whosagoodkiddo.me/goodkiddo-og-image.jpeg`. Do not hardcode Bun-generated hashed filenames in source HTML.
- Bun does not rewrite image paths inside `<meta property="og:image" ...>`, `<meta property="og:logo" ...>`, or `<meta name="twitter:image" ...>` content attributes. To make Bun copy a social preview image into `dist/`, also reference the same local file through a supported HTML asset tag such as `<link rel="preload" as="image" href="./goodkiddo-og-image.jpeg" />`.
- Keep the landing and web build scripts configured with `--asset-naming '[name].[ext]'` so the emitted social preview images keep the same filenames used by the meta tags. Verify with `bun run landing:build` or `bun run web:build` that the image is emitted into `dist/` under the real local filename.

## Image asset notes

- Run `bun run images:optimize` after adding or replacing checked-in images under `landing/` or `web/`. The optimizer skips generated `dist/` output and only rewrites files when the optimized output is meaningfully smaller.
- Use `bun run images:check` before finishing image-heavy changes.
