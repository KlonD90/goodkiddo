# Temporary media/research source handoff

This directory transports two reviewed source patches for later integration. The application files on this branch remain identical to the published baseline `dd9faa9e17d9b8b783c52c6af182f5bcc28dc476` (`restoration/2026-10-01`), derived from source snapshot `5a0e39c1474943110728afbfa6a0174dfb123de5`. Patch files omit commit author/mail headers and do not import local development history. `MANIFEST.json` records exact source commits, order and SHA-256 hashes.

Apply in this order to an isolated checkout of that baseline:

```sh
git apply handoff/temporary-media-research/0001-research.patch
git apply handoff/temporary-media-research/0002-research.patch
```

1. `cafebef7892513c95731af69bc71b65574300899` adds bounded read-only research modules and an inactive browser contract.
2. `3e6316d41f12686778d61979c0a218454d1ec11b` wires research into the assistant with existing shared budgets and HTTP/current-chat VFS/document reads.

Both patches applied in order without conflicts to the published baseline in a disposable local worktree. Research typecheck and all 46 synthetic tests passed (9 Bun integration tests and 37 Vitest unit tests). No actual provider requests, browsing, software installation, live bot messages or service changes occurred. Later integrator revisions may require manual merging in `src/assistant/tools.ts` and `src/assistant/prompt.ts`; preserve existing delivery holds, document dispatch and delivery reconciliation.

The browser contract has no real worker implementation and remains inactive. Browser runtime work in progress is excluded. These patches do not authorize installation or activation and must not be represented as a working rendered browser. Review and commit the integrated result separately; remove this temporary handoff directory after transport if desired.

Publication checks reviewed the patch contents for credentials, personal data and deployment details. The credential-bearing URL in a browser test is a synthetic rejection fixture on `example.com`, not a live credential. Existing source license and upstream notices remain unchanged.
