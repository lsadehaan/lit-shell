#!/bin/sh

# A real shell wrapper used to make PTY creation externally observable. The
# watchdog bounds the lifetime of a process that a failed limit check leaks.
set -eu

: "${LIT_SHELL_E2E_LIFECYCLE_LOG:?missing lifecycle log path}"
printf '%s\n' "$$" >> "$LIT_SHELL_E2E_LIFECYCLE_LOG"

target_pid=$$
(
  sleep "${LIT_SHELL_E2E_WATCHDOG_SECONDS:-3}"
  kill -TERM "$target_pid" 2>/dev/null || true
) &

exec /bin/sh
