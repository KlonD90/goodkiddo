"""Preserve vendor deny-by-default rules and permit Chrome's namespace chroot."""
import hashlib
import json
import pathlib
import sys

source = pathlib.Path(sys.argv[1])
target = pathlib.Path(sys.argv[2])
payload = source.read_bytes()
if hashlib.sha256(payload).hexdigest() != "cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849":
    raise SystemExit("Unexpected official Playwright seccomp profile")
profile = json.loads(payload)
if profile["defaultAction"] != "SCMP_ACT_ERRNO":
    raise SystemExit("Unexpected seccomp default")
# Do not add CAP_SYS_CHROOT to the container. The parent remains unable to chroot;
# Chrome creates its own user namespace and then removes filesystem access.
profile["syscalls"].insert(0, {
    "names": ["chroot"], "action": "SCMP_ACT_ALLOW", "args": [],
    "includes": {}, "excludes": {},
    "comment": "Chrome namespace sandbox drops filesystem access with chroot; container capabilities remain empty",
})
target.write_text(json.dumps(profile, indent=2) + "\n")
print("Prepared worker seccomp", hashlib.sha256(target.read_bytes()).hexdigest())
