The bot's owner-managed credentials remain in `/etc/goodkiddo/bot.env`.
Deployment must never replace, print or copy that file into a release/archive.
The public landing configuration remains in
`/opt/goodkiddo/shared/posthog/analytics-config.js`; it contains the public project
ingestion key only, and never the HMAC salt.

Prepare a release with `landing-v2/index.html`, `analytics.js` and the four public
image/icon assets. Before switching `/opt/goodkiddo/current`, run as root:

```sh
python3 /path/to/ops/prepare-landing.py /opt/goodkiddo/releases/RELEASE/payload/landing
```

This creates an empty disabled public configuration only when none exists and
replaces the NEW release's default configuration with a symlink to the persistent
asset. Existing public configuration bytes and permissions remain unchanged.
Each release, including rollback releases with these analytics assets, uses the
same persistent asset. A September landing without `analytics.js` remains
untouched. Activate only after the owner confirms completing hidden entry; verify
nonsecret presence, matching configuration and project/host metadata without
printing either credentials or the salt. Restart only GoodKiddo after release
checks. The helper itself does not deploy, restart or send capture events.
