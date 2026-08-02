# lit-shell Python Client

Python client bindings for [lit-shell](https://github.com/lsadehaan/lit-shell) WebSocket terminal servers.

## Installation

The Python binding is not currently published on PyPI. Tagged GitHub releases
attach a wheel and source distribution; download the matching artifact and
install it locally:

```bash
python -m pip install ./lit_shell-<version>-py3-none-any.whl
```

For development, or when installing directly from a source checkout:

```bash
cd bindings/python
python -m pip install -e .
```

## Quick Start

```python
import asyncio
from lit_shell import TerminalClient

async def main():
    async with TerminalClient("ws://localhost:3000/terminal") as client:
        # Spawn a new terminal session
        session = await client.spawn(shell="/bin/bash")
        print(f"Session started: {session.session_id}")

        # Handle terminal output
        client.on_data(lambda data: print(data, end=""))

        # Write commands
        await client.write("echo 'Hello from Python!'\n")
        await asyncio.sleep(1)

asyncio.run(main())
```

`connect()` validates the server handshake and returns its advertised
capabilities:

```python
client = TerminalClient(
    "ws://localhost:3000/terminal",
    connect_timeout=10.0,
    request_timeout=30.0,
)
server = await client.connect()
print(server.default_shell, server.local_enabled, server.docker_enabled)
```

## Features

- **Async/await** - Built on asyncio and websockets
- **Session multiplexing** - Multiple clients can share the same terminal
- **Docker support** - Connect to Docker containers via exec or attach
- **History replay** - Get terminal output history when joining sessions
- **Automatic reconnect** - Recover from unexpected transport disconnects
- **Event handlers** - React to data, exit, errors, and multiplexing events

## API

### Connection

```python
client = TerminalClient("ws://localhost:3000/terminal")
server_info = await client.connect()

# Or use context manager
async with TerminalClient(url) as client:
    ...
```

Automatic reconnect is enabled by default. `max_reconnect_attempts` limits
attempts after each unexpected disconnect, while `reconnect_delay` sets the
initial exponential-backoff delay in seconds (capped at 30 seconds). Calling
`disconnect()` cancels scheduled or in-progress retries; a later `connect()`
can still reuse the client and its configured reconnect policy.

If a session was active, reconnect also rejoins it before the next `on_connect`
callback and replays the requested history first. Owner resume tokens returned
by the server are kept inside the client: they aren't added to `SessionInfo`,
`SharedSessionInfo`, or session listings. `disconnect()`, `leave()`, `kill()`,
and a matching `sessionClosed` event clear the stored resume capability. The
public `join()` method accepts `resume_token=` for an owner capability obtained
through another trusted channel.

### Spawning Sessions

```python
# Basic
session = await client.spawn(shell="/bin/bash")

# Explicitly share with other authorized clients
shared = await client.spawn(shell="/bin/bash", allow_join=True)

# Docker exec
session = await client.spawn(container="my-container")

# Docker attach
session = await client.spawn(container="my-container", attach_mode=True)
```

Docker sessions use `container_shell` and `container_cwd` instead of the local
`shell` and `cwd` options. Attach mode accepts only common session settings;
exec-only environment, shell, user, and working-directory options are rejected
before a request is sent.

### Multiplexing

Sessions are private by default. Only sessions spawned with `allow_join=True`
are discoverable and joinable by other clients.

```python
# List sessions
sessions = await client.list_sessions()

# Join session
session = await client.join(session_id="term-abc123", request_history=True)

# Leave (keep session running)
client.leave()
```

### I/O

```python
await client.write("ls -la\n")
await client.resize(120, 40)
client.on_data(lambda d: print(d, end=""))
```

`write()`, `resize()`, and `kill()` raise `RuntimeError` when there is no
active session, making accidental input loss visible to callers.

### Lifecycle and errors

```python
client.on_exit(lambda code: print(f"session exited: {code}"))
client.on_error(lambda error: print(f"terminal error: {error}"))
client.on_disconnect(lambda: print("connection closed"))

await client.kill()       # close the active session
await client.disconnect() # idempotent connection cleanup
```

Pending spawn, list, and join calls fail immediately if the connection closes.
Concurrent operations are supported; same-type operations resolve in request
order when the server uses the standard response-type protocol.

## Development

```bash
python -m pip install -e '.[dev]'
ruff check .
ruff format --check .
mypy
python -m pytest --cov=lit_shell --cov-branch --cov-report=term-missing
python -m pip_audit .
python -m build
```

The branch-aware coverage gate has a checked 87% floor. The suite includes a
deterministic protocol server, wheel and source-distribution content checks,
an isolated external mypy consumer, and an E2E test that launches the built
Node server and controls a real PTY. Run `npm run build` at the repository root
before the Node E2E test when `dist/` is not present.

## License

MIT
