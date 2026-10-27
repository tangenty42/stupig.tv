#!/bin/sh
# Upload the runtime environment inside a private directory before replacing
# the fixed incoming path. A stale incoming file cannot weaken upload mode.
set -eu

: "${SSH_HOST:?SSH_HOST is required}"
: "${SSH_USER:?SSH_USER is required}"
: "${SSH_PORT:?SSH_PORT is required}"
: "${DEPLOY_DIR:?DEPLOY_DIR is required}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
: "${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT is required}"
case "$GITHUB_RUN_ID:$GITHUB_RUN_ATTEMPT" in
  *[!0-9:]*|:*|*:|*:*:*) echo 'Invalid GitHub run identity' >&2; exit 1 ;;
esac
case "$DEPLOY_DIR" in
  /*) ;;
  *) echo 'DEPLOY_DIR must be absolute' >&2; exit 1 ;;
esac
case "$DEPLOY_DIR" in
  *"'"*|*'
'*) echo 'Unsupported DEPLOY_DIR' >&2; exit 1 ;;
esac

destination="$SSH_USER@$SSH_HOST"
stage="$DEPLOY_DIR/.env-upload-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
ssh -p "$SSH_PORT" "$destination" "umask 077; mkdir -m 700 -- '$stage'"
cleanup() {
  ssh -p "$SSH_PORT" "$destination" "rm -f -- '$stage/.env.prod.incoming'; rmdir -- '$stage'" >/dev/null 2>&1 || true
}
trap cleanup EXIT
chmod 600 "$1"
scp -p -P "$SSH_PORT" "$1" "$destination:$stage/.env.prod.incoming"
ssh -p "$SSH_PORT" "$destination" "chmod 600 -- '$stage/.env.prod.incoming' && mv -fT -- '$stage/.env.prod.incoming' '$DEPLOY_DIR/.env.prod.incoming' && rmdir -- '$stage'"
trap - EXIT
