#!/bin/sh
set -eu
# Trusted operator-only test. Move this launcher into the already-limited worker
# cgroup, then drop root before any Node/container code. No cgroup mode/owner change.
test "$(id -u)" = 0
test "$#" = 0
printf '%s' "$$" > /sys/fs/cgroup/system.slice/goodkiddo-browser.service/broker/cgroup.procs
cd /var/lib/goodkiddo-browser
exec runuser -u goodkiddo-browser -- env \
  HOME=/var/lib/goodkiddo-browser XDG_RUNTIME_DIR=/run/goodkiddo-browser-owner \
  PATH=/usr/bin:/bin /usr/bin/node /tmp/confinement-verify.js \
  localhost/goodkiddo-browser:d03b240c101b
