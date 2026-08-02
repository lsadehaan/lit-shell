lit-shell.js remote demo
========================

This is a deliberately tiny, disposable shell used to demonstrate the real
lit-shell WebSocket client, terminal component, protocol, and PTY server.

Security boundary
-----------------

- The filesystem is read-only and contains only a few viewing commands.
- There is no package manager, compiler, scripting runtime, or upload area.
- Outbound and local socket syscalls are denied by the sandbox.
- Process, memory, CPU, input, output, idle, and wall-clock limits apply.
- Only one anonymous session is admitted at a time, for at most 60 seconds.
- The shell receives no application, Render, or visitor credentials.

Useful commands
---------------

  id
  env
  ls /
  cat /README.txt
  uname -a
  date

The project source and local examples are available at:
https://github.com/lsadehaan/lit-shell
