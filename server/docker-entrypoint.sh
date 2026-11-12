#!/bin/sh
# Container entrypoint (see Dockerfile). Runs the command as the unprivileged
# "node" user.
#
# Started as "node" (the default image): just exec the command.
# Started as root (RUNTIME_USER=root builds, or `docker run --user 0`): some
# platforms mount persistent volumes owned by root, so first make DATA_DIR
# writable for "node", then drop privileges permanently. The server never
# runs as root, and it becomes PID 1 so SIGTERM reaches it directly.
set -eu

if [ "$(id -u)" = "0" ]; then
  data_dir="${DATA_DIR:-/data}"
  mkdir -p "$data_dir" 2>/dev/null || true
  chown -R node:node "$data_dir" 2>/dev/null || true
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

exec "$@"
