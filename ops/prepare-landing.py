#!/usr/bin/env python3
"""Link a new landing release to owner-managed public analytics configuration.

Never read bot.env or overwrite an existing configuration. Run before switching
/opt/goodkiddo/current. The persistent asset contains only the public project key.
"""
import argparse
import os
from pathlib import Path


def prepare(base: Path, landing: Path) -> Path:
    base = base.resolve()
    landing = landing.resolve()
    landing.relative_to(base / "releases")
    index = (landing / "index.html").read_text()
    analytics = (landing / "analytics.js").read_text()
    if not all(name in index for name in ("analytics-config.js", "analytics.js")):
        raise ValueError("Landing does not load the approved analytics assets")
    if "schema_version: 2" not in analytics:
        raise ValueError("Landing analytics schema is not version 2")
    shared = base / "shared" / "posthog"
    shared.mkdir(parents=True, exist_ok=True, mode=0o755)
    target = shared / "analytics-config.js"
    blank = (
        "window.GOODKIDDO_ANALYTICS = {projectKey: '', "
        "apiHost: 'https://us.i.posthog.com', testMode: false};\n"
    )
    try:
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    except FileExistsError:
        if target.is_symlink() or not target.is_file():
            raise ValueError("Persistent configuration is not a regular file")
    else:
        with os.fdopen(fd, "w") as stream:
            stream.write(blank)
        target.chmod(0o644)
    link = landing / "analytics-config.js"
    temporary = landing / ".analytics-config.js.new"
    if temporary.exists() or temporary.is_symlink():
        raise ValueError("Temporary analytics link already exists")
    temporary.symlink_to(target)
    temporary.replace(link)
    return target


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("landing", type=Path)
    parser.add_argument("--base", type=Path, default=Path("/opt/goodkiddo"))
    args = parser.parse_args()
    print("Persistent public analytics asset linked:", prepare(args.base, args.landing))
