from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
from pathlib import Path

import pytest
import pytest_asyncio

from lit_shell import TerminalClient

from .conftest import CONTRACT_TIMEOUT

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
SERVER_ENTRYPOINT = REPOSITORY_ROOT / "dist" / "server" / "index.js"


@pytest_asyncio.fixture
async def node_server_url() -> str:
    if shutil.which("node") is None:
        pytest.skip("Node.js is not installed")
    if not SERVER_ENTRYPOINT.exists():
        pytest.skip("run `npm run build` before the Python Node E2E suite")

    entrypoint = SERVER_ENTRYPOINT.as_uri()
    script = f"""
import {{ createServer }} from 'node:http';
import {{ TerminalServer }} from {json.dumps(entrypoint)};

const httpServer = createServer((_request, response) => {{
  response.writeHead(404);
  response.end();
}});
const terminalServer = new TerminalServer({{
  path: '/terminal',
  allowedShells: ['/bin/sh'],
  allowedPaths: ['/tmp'],
  defaultCwd: '/tmp',
  maxSessionsTotal: 4,
  maxSessionsPerClient: 2,
  orphanTimeout: 1000,
  verbose: false,
}});
terminalServer.attach(httpServer);
httpServer.listen(0, '127.0.0.1', () => {{
  const address = httpServer.address();
  process.stdout.write(JSON.stringify({{ port: address.port }}) + '\\n');
}});
const shutdown = () => {{
  terminalServer.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2000).unref();
}};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
"""
    process = subprocess.Popen(  # noqa: ASYNC220 - bounded local test-server launch
        ["node", "--input-type=module", "--eval", script],
        cwd=REPOSITORY_ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert process.stdout is not None

    try:
        line = await asyncio.wait_for(
            asyncio.to_thread(process.stdout.readline), timeout=5.0
        )
        if not line:
            stderr = process.stderr.read() if process.stderr is not None else ""
            pytest.fail(f"Node server did not start: {stderr}")
        port = json.loads(line)["port"]
        yield f"ws://127.0.0.1:{port}/terminal"
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                await asyncio.wait_for(asyncio.to_thread(process.wait), timeout=3.0)
            except asyncio.TimeoutError:
                process.kill()
                await asyncio.to_thread(process.wait)


@pytest.mark.node_e2e
@pytest.mark.asyncio
async def test_python_client_controls_a_real_node_pty(node_server_url: str) -> None:
    client = TerminalClient(node_server_url, reconnect=False)
    output: list[str] = []
    marker_seen = asyncio.Event()

    def on_data(data: str) -> None:
        output.append(data)
        if "python-node-e2e-ok" in "".join(output):
            marker_seen.set()

    client.on_data(on_data)
    try:
        await client.connect()
        session = await asyncio.wait_for(
            client.spawn(shell="/bin/sh", cwd="/tmp", cols=90, rows=30),
            CONTRACT_TIMEOUT * 2,
        )
        assert session.session_id

        await client.resize(100, 40)
        await client.write("printf 'python-node-e2e-ok\\n'\n")
        await asyncio.wait_for(marker_seen.wait(), timeout=3.0)
        await client.kill()
    finally:
        await client.disconnect()


@pytest.mark.node_e2e
@pytest.mark.asyncio
async def test_python_client_recovers_private_node_session(
    node_server_url: str,
) -> None:
    client = TerminalClient(
        node_server_url,
        reconnect=True,
        max_reconnect_attempts=3,
        reconnect_delay=0,
    )
    connect_count = 0
    reconnected = asyncio.Event()
    resumed_output = asyncio.Event()

    def on_connect() -> None:
        nonlocal connect_count
        connect_count += 1
        if connect_count == 2:
            reconnected.set()

    def on_data(data: str) -> None:
        if "python-node-resumed-ok" in data:
            resumed_output.set()

    client.on_connect(on_connect)
    client.on_data(on_data)

    try:
        await client.connect()
        session = await asyncio.wait_for(
            client.spawn(shell="/bin/sh", cwd="/tmp"),
            CONTRACT_TIMEOUT * 2,
        )
        assert not hasattr(session, "resume_token")

        websocket = client._ws
        assert websocket is not None
        await websocket.close(code=1011, reason="test transport loss")

        await asyncio.wait_for(reconnected.wait(), timeout=3.0)
        assert client.is_connected()
        assert client.get_session_id() == session.session_id

        await client.write("printf 'python-node-resumed-ok\\n'\n")
        await asyncio.wait_for(resumed_output.wait(), timeout=3.0)
        await client.kill()
    finally:
        await client.disconnect()
