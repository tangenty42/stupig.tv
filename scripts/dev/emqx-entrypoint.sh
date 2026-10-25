#!/bin/sh
set -eu

# EMQX hashes these initial credentials into its built-in database. Keep the
# generated file inside the container; never commit a credential file.
: "${MQTT_USERNAME:?MQTT_USERNAME is required}"
: "${MQTT_PASSWORD:?MQTT_PASSWORD is required}"
: "${EMQX_AUTHENTICATION__1__BOOTSTRAP_FILE:?bootstrap file is required}"
umask 077

# Use JSON to preserve commas, quotes and control characters in credentials.
# The pinned image includes core Perl; no additional package or JSON module
# is needed. Encode quotes, backslashes and control characters as JSON strings.
perl -e '
  sub json_string {
    my ($value) = @_;
    $value =~ s/([\\"])/\\$1/g;
    $value =~ s/([\x00-\x1f])/sprintf("\\u%04x", ord($1))/ge;
    return "\"$value\"";
  }
  print "[{\"user_id\":", json_string($ENV{MQTT_USERNAME}),
    ",\"password\":", json_string($ENV{MQTT_PASSWORD}),
    ",\"is_superuser\":true}]\n";
' > "$EMQX_AUTHENTICATION__1__BOOTSTRAP_FILE"

# Retain the image's node discovery and foreground startup behavior.
exec /usr/bin/docker-entrypoint.sh "$@"
