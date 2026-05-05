# Ops

Production provisioning for Ubuntu lives in [`ops/ansible/`](./ansible/).

The playbook provisions:

- Bun
- Google Chrome Stable for browser automation
- `agent-browser` as the browser CLI used by the runtime
- `uv`/`uvx` for MiniMax MCP image understanding
- Docker and `docker-compose`
- local SearXNG + Valkey via Docker Compose for search, managed by systemd
- a dedicated system user
- local PostgreSQL with a dedicated database and role
- nginx as the only public entrypoint
- an HTTP-only nginx origin intended to sit behind Cloudflare Flexible SSL
- the generated `landing/dist/` bundle served by nginx after running the
  landing `bun build` script
- the `web/` bot UI bundle consumed by the bot service after running `bun run web:build`
- a managed environment file at `/etc/goodkiddo/bot.env`
- a systemd service that runs `bun src/bin/bot.ts` from `bot/`
- optional Telegram image understanding through MiniMax MCP when
  `enable_image_understanding=true`

It deliberately does **not** provision Firecracker or any execution sandbox
hardening yet. The example vars keep `ENABLE_EXECUTE=false` so the bot runs as
a Telegram service with PostgreSQL persistence but without scripting/execution.
The Bun app stays HTTP-only on `WEB_HOST`/`WEB_PORT`. nginx also stays
HTTP-only on the origin; Cloudflare Flexible SSL handles public HTTPS and
forwards requests to the origin over HTTP.

## Files

- [`ansible/production.yml`](./ansible/production.yml) - main playbook
- [`ansible/requirements.yml`](./ansible/requirements.yml) - Ansible collections
- [`ansible/inventory/production.ini.example`](./ansible/inventory/production.ini.example) - starter inventory
- [`ansible/group_vars/goodkiddo_prod/00-safe-defaults.yml`](./ansible/group_vars/goodkiddo_prod/00-safe-defaults.yml) - tracked safe defaults
- [`ansible/examples/goodkiddo_prod.10-env.yml.example`](./ansible/examples/goodkiddo_prod.10-env.yml.example) - starter non-secret env vars
- [`ansible/examples/goodkiddo_prod.20-secrets.vault.yml.example`](./ansible/examples/goodkiddo_prod.20-secrets.vault.yml.example) - starter secret vars
- [`ansible/templates/searxng.env.j2`](./ansible/templates/searxng.env.j2) - local SearXNG runtime env
- [`ansible/templates/goodkiddo-searxng.service.j2`](./ansible/templates/goodkiddo-searxng.service.j2) - systemd unit for the SearXNG stack
- `ansible/tasks/` - split task files for preflight, packages, app, search stack, PostgreSQL, bot service, and nginx

## Safer Layout

This directory is now split so you do not need to edit the playbook itself:

- `production.yml`: orchestration only
- `inventory/production.ini`: host list only, ignored by git
- `group_vars/goodkiddo_prod/00-safe-defaults.yml`: tracked safe defaults
- `group_vars/goodkiddo_prod/10-env.yml`: your real non-secret production config, ignored by git
- `group_vars/goodkiddo_prod/20-secrets.vault.yml`: your real secret config, ignored by git and encrypted with Ansible Vault

If `10-env.yml` or `20-secrets.vault.yml` is missing required values, the playbook
fails before making changes.
`ai_api_key` may be left empty when the app is pointed at a local/custom model
endpoint via `ai_base_url`. `openrouter` still requires a key.
The playbook always provisions the browser/search stack and expects
`bot_searxng_secret` in the Vault file.
When `enable_image_understanding=true`, it also expects `minimax_api_key` in the
Vault file and installs `uvx` so the runtime can launch
`minimax-coding-plan-mcp`.

## Usage

1. Install the collection:

   ```bash
   ansible-galaxy collection install -r ops/ansible/requirements.yml
   ```

2. Copy the example inventory and vars, then fill in the real values:

   ```bash
   cp ops/ansible/inventory/production.ini.example ops/ansible/inventory/production.ini
   mkdir -p ops/ansible/group_vars/goodkiddo_prod
   cp ops/ansible/examples/goodkiddo_prod.10-env.yml.example ops/ansible/group_vars/goodkiddo_prod/10-env.yml
   cp ops/ansible/examples/goodkiddo_prod.20-secrets.vault.yml.example ops/ansible/group_vars/goodkiddo_prod/20-secrets.vault.yml
   ```

3. Encrypt the secrets file:

   ```bash
   ansible-vault encrypt ops/ansible/group_vars/goodkiddo_prod/20-secrets.vault.yml
   ```

4. Edit the two config files:

   - `ops/ansible/group_vars/goodkiddo_prod/10-env.yml`
   - `ops/ansible/group_vars/goodkiddo_prod/20-secrets.vault.yml`

5. Choose how the app code reaches the server:

   - set `bot_repo_url` if Ansible should clone/update the repository into `bot_app_dir`
   - leave `bot_repo_url` empty if you place the checkout on the host yourself

6. Point proxied Cloudflare DNS records at the host before running the playbook:

   - `bot_main_domain` -> server public IP
   - `bot_app_domain` -> same server public IP

7. Run the playbook:

   ```bash
   ansible-playbook -i ops/ansible/inventory/production.ini ops/ansible/production.yml --ask-vault-pass
   ```

8. After the service is up, provision Telegram chats with the existing admin CLI:

   ```bash
   sudo systemd-run --wait --pipe \
     -p User=goodkiddo \
     -p WorkingDirectory=/opt/goodkiddo/app/bot \
     -p EnvironmentFile=/etc/goodkiddo/bot.env \
     /usr/local/bin/bun src/bin/admin.ts add-user telegram <chat-id> "Display name"
   ```

## Notes

- The playbook expects Ubuntu with `apt`.
- Real inventory and real production vars are meant to live in ignored files, not in the playbook.
- PostgreSQL is local by default. Override `bot_database_url` if you want to
  point the bot at a managed PostgreSQL instance instead, and set
  `bot_manage_postgres=false` so Ansible skips the local PostgreSQL tasks.
- `bot_main_domain` and `bot_app_domain` must be set correctly in Cloudflare
  and should be proxied when using Flexible SSL.
- The browser/search stack is local-only: Chrome is installed on the host,
  `agent-browser` is installed globally with Bun, Docker and `docker-compose`
  are installed on the host, and SearXNG listens on
  `bot_searxng_host:bot_searxng_port`.
- The SearXNG compose stack is managed by `{{ bot_searxng_service_name }}`
  through systemd instead of a one-off `docker-compose up -d` task.
- nginx serves the generated `landing/dist/` bundle for `bot_main_domain` over
  origin HTTP and proxies the Bun file-share UI for `bot_app_domain`.
- Landing analytics are embedded at build time. Set `landing_posthog_key` and
  `landing_posthog_host` before provisioning so `bun run build` can inline the
  browser PostHog config into `landing/dist`.
- The embedded bot browser UI is built from the root workspace with
  `bun run web:build`; the bot service reads the generated `web/dist` files.
- The bot gets `SEARXNG_API_BASE` and `AGENT_BROWSER_EXECUTABLE_PATH` through
  `/etc/goodkiddo/bot.env`, which is what the current runtime expects.
- MiniMax image understanding is controlled by `enable_image_understanding`,
  `minimax_api_key`, and `minimax_api_host`; these render to
  `ENABLE_IMAGE_UNDERSTANDING`, `MINIMAX_API_KEY`, and `MINIMAX_API_HOST`.
- Production dependencies are installed from the root Bun workspace with
  `bun install --frozen-lockfile --production`.
