#!/bin/sh
set -e
mkdir -p /opt/app/.tmp /opt/app/public/uploads
# fix perms if volume came in as root
chown -R node:node /opt/app/.tmp /opt/app/public/uploads || true
exec "$@"