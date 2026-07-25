#!/usr/bin/env bash
# Adds/updates a hosts-file entry so THIS machine resolves the shared host
# record to a LAN IP instead of its public IP - a per-machine workaround for
# NAT hairpinning when you don't run a local DNS server. See the README's
# Troubleshooting section for background and the local-DNS-override
# alternative, which fixes every device on the LAN instead of just this one.
#
# Usage: sudo ./add-host-entry.sh <host-record> <lan-ip>
#   sudo ./add-host-entry.sh factorio-stack-manager.mydomain.com 192.168.1.50
#
# Safe to re-run: it replaces its own previously-added block instead of
# duplicating it. Re-run it if the host's LAN IP changes - this does not
# track that automatically.
set -euo pipefail

if [[ $# -ne 2 || "$1" == "-h" || "$1" == "--help" ]]; then
  echo "Usage: $0 <host-record> <lan-ip>" >&2
  exit 1
fi

host_record="$1"
lan_ip="$2"
hosts_file="/etc/hosts"

if [[ ! "$host_record" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,62}\.)+[A-Za-z0-9-]{1,63}$ ]]; then
  echo "error: '$host_record' doesn't look like a valid hostname" >&2
  exit 1
fi
octet='(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])'
if [[ ! "$lan_ip" =~ ^${octet}\.${octet}\.${octet}\.${octet}$ ]]; then
  echo "error: '$lan_ip' doesn't look like a valid IPv4 address" >&2
  exit 1
fi

if [[ ! -w "$hosts_file" ]]; then
  echo "error: cannot write to $hosts_file - rerun with sudo" >&2
  exit 1
fi

marker_begin="# BEGIN factorio-stack-manager (${host_record})"
marker_end="# END factorio-stack-manager (${host_record})"
# Pre-rebrand marker: recognized so a re-run of this (updated) script still finds
# and replaces a block an older version of it wrote, instead of leaving that one
# behind and duplicating the entry. Never written going forward.
legacy_marker_begin="# BEGIN factorio-tools-manager (${host_record})"
legacy_marker_end="# END factorio-tools-manager (${host_record})"

if grep -Fq "$host_record" "$hosts_file" \
  && ! grep -Fq "$marker_begin" "$hosts_file" \
  && ! grep -Fq "$legacy_marker_begin" "$hosts_file"; then
  echo "warning: $host_record already appears in $hosts_file outside this script's managed block." >&2
  echo "         The first matching line wins, so check for conflicts if the override doesn't take effect." >&2
fi

filtered="$(mktemp)"
final="$(mktemp)"
trap 'rm -f "$filtered" "$final"' EXIT

awk -v begin="$marker_begin" -v end="$marker_end" \
    -v legacyBegin="$legacy_marker_begin" -v legacyEnd="$legacy_marker_end" '
  $0 == begin || $0 == legacyBegin { skipping = 1; next }
  $0 == end   || $0 == legacyEnd   { skipping = 0; next }
  !skipping   { print }
' "$hosts_file" > "$filtered"

content="$(cat "$filtered")"
{
  printf '%s\n' "$content"
  printf '\n%s\n%s\t%s\n%s\n' "$marker_begin" "$lan_ip" "$host_record" "$marker_end"
} > "$final"

cp "$hosts_file" "${hosts_file}.bak.$(date +%Y%m%d%H%M%S)"
cat "$final" > "$hosts_file"

echo "Added: $lan_ip -> $host_record in $hosts_file (backup saved alongside it)"
echo "If the change doesn't take effect immediately, flush your OS DNS cache"
echo "(macOS: sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder)."
