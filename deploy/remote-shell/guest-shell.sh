#!/bin/sh
set -eu

if [ "${1-}" = '--self-test' ]; then
  identity="$(/usr/bin/id -u):$(/usr/bin/id -g):$(/usr/bin/id -G)"
  if [ "$identity" != '65532:65532:65532' ]; then
    echo "unexpected guest identity: $identity" >&2
    exit 1
  fi
  echo 'lit-shell-guest-self-test-ok'
  exit 0
fi

if [ "$#" -ne 0 ]; then
  echo 'lit-shell guest shell does not accept arguments' >&2
  exit 2
fi

exec /usr/bin/prlimit \
  --as=134217728:134217728 \
  --core=0:0 \
  --cpu=30:30 \
  --fsize=8388608:8388608 \
  --nofile=64:64 \
  --nproc=32:32 \
  -- /usr/bin/nice -n 10 /bin/sh -i
