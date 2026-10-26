#!/bin/sh
set -eu

: "${MQTT_PASSWORD:?MQTT_PASSWORD is required}"
EMQX_NODE__COOKIE=$(printf '%s' "$MQTT_PASSWORD" | sha256sum)
EMQX_NODE__COOKIE=${EMQX_NODE__COOKIE%% *}
export EMQX_NODE__COOKIE

case "${1:-}" in
	--healthcheck) exec /bin/sh /opt/emqx/etc/stupig-healthcheck.sh ;;
	--cli) shift; exec /opt/emqx/bin/emqx "$@" ;;
esac

exec /bin/sh /opt/emqx/etc/stupig-entrypoint.sh "$@"
