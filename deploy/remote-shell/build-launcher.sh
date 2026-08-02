#!/bin/sh

set -eu

output=${1:?launcher output path is required}
source_root=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)

cc \
  -U_FORTIFY_SOURCE \
  -D_FORTIFY_SOURCE=3 \
  -O2 \
  -Wall \
  -Wextra \
  -Werror \
  -Wformat=2 \
  -Wl,-z,now \
  -Wl,-z,relro \
  -fPIE \
  -fstack-clash-protection \
  -fstack-protector-strong \
  -o "$output" \
  -static-pie \
  "$source_root/sandbox-launcher.c" \
  -lseccomp

readelf --file-header "$output" | grep --quiet 'Type:.*DYN'
if readelf --program-headers "$output" \
  | grep --quiet 'Requesting program interpreter'; then
  echo 'sandbox launcher must not have a dynamic interpreter' >&2
  exit 1
fi
