"""Extract one pinned official binary; never execute package installation scripts."""
import base64
import hashlib
import io
import pathlib
import sys
import tarfile
import urllib.request

target = pathlib.Path(sys.argv[1])
if not target.is_absolute() or target.name != "agent-browser":
    raise SystemExit("Invalid binary destination")
url = "https://registry.npmjs.org/agent-browser/-/agent-browser-0.38.1.tgz"
digest = "k58FCz0yUOCANoNkMiqJe+H2y6r6sUZazqXsWF+MYq1iRC42PjtLcBoag6SSTOD/FRQppvPDvE5HDYEhclvnhw=="
with urllib.request.urlopen(url, timeout=30) as response:
    payload = response.read(60 * 1024 * 1024 + 1)
if len(payload) > 60 * 1024 * 1024:
    raise SystemExit("Binary archive limit exceeded")
if base64.b64encode(hashlib.sha512(payload).digest()).decode() != digest:
    raise SystemExit("Binary archive integrity mismatch")
with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as archive:
    member = archive.getmember("package/bin/agent-browser-linux-x64")
    if not member.isfile() or member.size > 60 * 1024 * 1024:
        raise SystemExit("Unexpected native binary")
    with archive.extractfile(member) as source:
        target.write_bytes(source.read())
target.chmod(0o555)
print("Verified native agent-browser 0.38.1", hashlib.sha256(target.read_bytes()).hexdigest())
