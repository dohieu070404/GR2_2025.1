#!/bin/sh
set -eu

# This entrypoint exists to avoid the common "Read-only file system" / chown
# issues when mounting mosquitto.conf/passwordfile/aclfile as individual files.
#
# Strategy:
#  - Mount repo config dir read-only at /config-ro
#  - Use a writable volume at /mosquitto/config
#  - Copy config files from /config-ro into /mosquitto/config on start
#  - (IMPORTANT) Generate a clean passwordfile at runtime via mosquitto_passwd
#    to avoid Windows newline issues and to guarantee user/pass match.

SRC_DIR="/config-ro"
DST_DIR="/mosquitto/config"

# Credentials for the default/dev broker user.
# Keep in sync with backend docker-compose env.
MQTT_USER="${MOSQUITTO_USERNAME:-${MQTT_USERNAME:-smarthome}}"
MQTT_PASS="${MOSQUITTO_PASSWORD:-${MQTT_PASSWORD:-smarthome123}}"

mkdir -p "$DST_DIR" "$DST_DIR/conf.d" /mosquitto/data /mosquitto/log

# Prevent stale include_dir configs from persisting across named-volume reuse.
rm -f "$DST_DIR/conf.d"/* 2>/dev/null || true

# Copy only the files we expect from the repo config.
for f in mosquitto.conf aclfile; do
  if [ -f "$SRC_DIR/$f" ]; then
    cp -f "$SRC_DIR/$f" "$DST_DIR/$f"
  fi
done

# Generate passwordfile (clean 1-line format) every boot.
# This avoids problems when a passwordfile shipped from Windows has CRLF.
mosquitto_passwd -c -b "$DST_DIR/passwordfile" "$MQTT_USER" "$MQTT_PASS"

# Strip any CRLF that may have come from Windows mounts.
sed -i 's/\r$//' "$DST_DIR/mosquitto.conf" "$DST_DIR/aclfile" "$DST_DIR/passwordfile" 2>/dev/null || true

# Best-effort permissions. Some environments may not allow chown; don't crash.
chown -R mosquitto:mosquitto /mosquitto/config /mosquitto/data /mosquitto/log 2>/dev/null || true

echo "[mosquitto-entrypoint] using config=$DST_DIR/mosquitto.conf user=$MQTT_USER"

exec mosquitto -c /mosquitto/config/mosquitto.conf
