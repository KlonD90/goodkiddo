#!/bin/sh
set -eu
# Approved worker prerequisites only. No upgrades, shared Docker changes, kernel
# toggles, firewall changes, bot keys/groups or service restart are performed.
test "$(id -u)" = 0
export DEBIAN_FRONTEND=noninteractive
podman_was_present=0
if command -v podman >/dev/null 2>&1; then podman_was_present=1; fi
apt-get install -y --no-install-recommends --no-upgrade \
  podman=4.9.3+ds1-1ubuntu0.2 \
  uidmap=1:4.13+dfsg1-4ubuntu3.2 \
  fuse-overlayfs=1.13-1
if test "$podman_was_present" = 0; then
  # Apt enables rootful defaults. This worker needs only daemonless rootless
  # Podman; preserve any Podman services on hosts where it already existed.
  systemctl disable --now podman.socket podman.service \
    podman-auto-update.timer podman-restart.service
fi
if ! id goodkiddo-browser >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/goodkiddo-browser \
    --shell /usr/sbin/nologin goodkiddo-browser
fi
test "$(getent passwd goodkiddo-browser | cut -d: -f6)" = /var/lib/goodkiddo-browser
chmod 700 /var/lib/goodkiddo-browser
# Allocate disjoint subordinate IDs only for the dedicated worker identity.
python3 - <<'PY'
import pathlib,subprocess
name='goodkiddo-browser'
paths=[pathlib.Path('/etc/subuid'),pathlib.Path('/etc/subgid')]
rows=[]
for p in paths:
    rows.append([line.split(':') for line in p.read_text().splitlines() if line])
end=max([100000]+[int(row[1])+int(row[2]) for group in rows for row in group])
start=((end+65535)//65536)*65536
for option, group in zip(['--add-subuids','--add-subgids'],rows):
    if not any(row[0]==name for row in group):
        subprocess.run(['usermod',option,f'{start}-{start+65535}',name],check=True)
PY
install -d -m 700 -o goodkiddo-browser -g goodkiddo-browser /run/goodkiddo-browser-owner
install -d -m 755 -o root -g root /opt/goodkiddo-browser
cd /var/lib/goodkiddo-browser
sudo -u goodkiddo-browser env HOME=/var/lib/goodkiddo-browser \
  XDG_RUNTIME_DIR=/run/goodkiddo-browser-owner \
  /usr/bin/podman --cgroup-manager=cgroupfs info --format '{{.Host.Security.Rootless}}'
