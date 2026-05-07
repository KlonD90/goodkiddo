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
- the `web/` bot UI bundle served by nginx after running `bun run web:build`
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
- [`ansible/tasks/autoprovision_key.yml`](./ansible/tasks/autoprovision_key.yml) - readonly deploy key and Git host setup
- [`ansible/tasks/autoprovision.yml`](./ansible/tasks/autoprovision.yml) - optional production self-autoprovisioning from a readonly deploy key
- [`ansible/templates/goodkiddo-autoprovision.sh.j2`](./ansible/templates/goodkiddo-autoprovision.sh.j2) - update detector + local Ansible runner
- [`ansible/templates/goodkiddo-autoprovision.service.j2`](./ansible/templates/goodkiddo-autoprovision.service.j2) and [`ansible/templates/goodkiddo-autoprovision.timer.j2`](./ansible/templates/goodkiddo-autoprovision.timer.j2) - systemd service/timer pair
- `ansible/tasks/` - split task files for preflight, packages, app, search stack, PostgreSQL, bot service, nginx, and self-autoprovisioning

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

8. Optional: enable self-autoprovisioning after the first successful manual run.

   Create a GitHub deploy key with **read-only** access to this repository. Put
   the private key either in the encrypted Vault var
   `bot_autoprovision_deploy_key_private` or manually on the host at
   `bot_autoprovision_deploy_key_path` with `0600 root:root` permissions. The
   timer uses a separate root-owned control checkout (`bot_autoprovision_repo_dir`)
   to run Ansible; keep it different from `bot_app_dir` so a compromised bot
   process cannot mutate root-run playbooks/templates.

   Copy the real production vars to a root-owned location outside the app and
   control checkouts. The timer passes these files to `ansible-playbook` as
   explicit extra-vars; if any configured file is missing, unreadable, not
   root-owned, or group/world-writable, the timer skips that tick without
   recording the repo SHA as deployed.

   In `ops/ansible/group_vars/goodkiddo_prod/10-env.yml`:

   ```yaml
   bot_repo_url: git@github.com:KlonD90/goodkiddo.git
   bot_repo_version: main
   bot_autoprovision_enabled: true
   bot_autoprovision_interval: 15min
   bot_autoprovision_vars_dir: /etc/goodkiddo/ansible-vars
   bot_autoprovision_extra_vars_files:
     - "{{ bot_autoprovision_vars_dir }}/10-env.yml"
     - "{{ bot_autoprovision_vars_dir }}/20-secrets.vault.yml"
   bot_autoprovision_repo_dir: /opt/goodkiddo/autoprovision-repo
   bot_autoprovision_state_file: /var/lib/goodkiddo/autoprovision-last-successful-sha
   bot_autoprovision_deploy_key_path: /etc/goodkiddo/deploy_readonly_key
   bot_autoprovision_known_hosts_file: /etc/goodkiddo/autoprovision_known_hosts
   bot_autoprovision_vault_password_file: /etc/goodkiddo/ansible-vault-pass
   ```

   `bot_autoprovision_known_hosts` defaults to GitHub's published SSH host keys,
   written to the dedicated `bot_autoprovision_known_hosts_file` used by the
   deploy-key Git commands. Override it only with operator-verified keys for a
   different Git host; do not bootstrap production trust from unaudited
   `ssh-keyscan` output.

   If production vars remain Vault-encrypted, create the vault password file on
   the server as root-only:

   ```bash
   sudo install -m 0600 -o root -g root /dev/null /etc/goodkiddo/ansible-vault-pass
   sudo editor /etc/goodkiddo/ansible-vault-pass
   ```

   Then run the playbook once manually again. It installs
   `goodkiddo-autoprovision.timer`. Every 15 minutes the host checks that the
   root-owned vars/secrets files listed in `bot_autoprovision_extra_vars_files`
   are readable and root-controlled. If any are missing or insecure, that timer
   tick logs the path and skips deployment without recording success. When vars
   are present, it checks the readonly deploy key against `bot_repo_version`;
   when the SHA changed, it updates the root-owned control checkout, runs the
   production playbook locally through a localhost inventory with those extra
   vars, and records the SHA only after Ansible succeeds so failed or skipped
   runs retry on the next timer tick.

   Useful production checks:

   ```bash
   sudo systemctl list-timers goodkiddo-autoprovision.timer
   sudo systemctl status goodkiddo-autoprovision.timer
   sudo journalctl -u goodkiddo-autoprovision.service -n 100 --no-pager
   sudo systemctl start goodkiddo-autoprovision.service
   ```

9. After the service is up, provision Telegram chats with the existing admin CLI:

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
- nginx serves the generated `landing/dist/` bundle for `bot_main_domain` and
  the generated `web/dist` file-share UI under `/fs` for `bot_app_domain`.
- `/api/fs/...` and `/_dl` are proxied to the Bun web server for authenticated
  boot, browse, preview, and download operations.
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
