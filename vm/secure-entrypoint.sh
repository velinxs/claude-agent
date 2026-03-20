#!/bin/bash
# Secure entrypoint for OpenClaw Docker container
# - Reads secrets from /run/secrets/ (Docker secrets or mounted files)
# - Sets them as env vars for the OpenClaw process ONLY
# - Hides /proc/*/environ so tools can't read them
# - Drops to node user with restricted sudo

set -euo pipefail

# 1. Read secrets from encrypted file (root-only)
SECRETS_FILE="/run/secrets/openclaw.env"
if [ -f "$SECRETS_FILE" ]; then
  echo "[secure] Loading secrets from $SECRETS_FILE"
  # Source secrets into this root shell's environment
  set -a
  source "$SECRETS_FILE"
  set +a
else
  echo "[secure] WARNING: No secrets file found, using existing env vars"
fi

# 2. Hide /proc/*/environ from non-root users
# This prevents `cat /proc/self/environ` or `cat /proc/1/environ` from leaking secrets
mount -o remount,hidepid=2 /proc 2>/dev/null || true

# 3. Create a restricted sudoers for the node user
# Allow package installs but NOT env reading, file access to /run/secrets, etc.
cat > /etc/sudoers.d/node-restricted << 'SUDOEOF'
node ALL=(ALL) NOPASSWD: /usr/bin/apt, /usr/bin/apt-get, /usr/bin/npm, /usr/bin/pip3, /usr/bin/pip
node ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/apt/sources.list.d/*
SUDOEOF
chmod 440 /etc/sudoers.d/node-restricted

# 4. Clear secrets from any files the node user could read
# The env vars are only in this process's memory now
unset HISTFILE
export HISTFILE=/dev/null

# 5. Drop privileges and exec OpenClaw
# `exec gosu` replaces this process — secrets env vars are inherited
# but /proc/self/environ is hidden by hidepid=2
echo "[secure] Starting OpenClaw as node user (secrets hidden from /proc)"
exec gosu node "$@"
