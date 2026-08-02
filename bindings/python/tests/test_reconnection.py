from __future__ import annotations

import asyncio
import gc
from typing import Any

import pytest
from websockets.asyncio.client import ClientConnection
from websockets.exceptions import ConnectionClosedError

from lit_shell import TerminalClient

from .conftest import CONTRACT_TIMEOUT
from .contract_server import RESUME_TOKEN, SESSION


def _lit_shell_tasks() -> list[asyncio.Task[Any]]:
    current = asyncio.current_task()
    return [
        task
        for task in asyncio.all_tasks()
        if task is not current
        and not task.done()
        and task.get_name().startswith("lit-shell-")
    ]


@pytest.mark.parametrize(
    ("kwargs", "error_type"),
    [
        ({"reconnect": 1}, TypeError),
        ({"max_reconnect_attempts": True}, TypeError),
        ({"max_reconnect_attempts": 1.5}, TypeError),
        ({"max_reconnect_attempts": -1}, ValueError),
        ({"reconnect_delay": True}, TypeError),
        ({"reconnect_delay": "soon"}, TypeError),
        ({"reconnect_delay": -0.1}, ValueError),
        ({"reconnect_delay": float("inf")}, ValueError),
        ({"reconnect_delay": float("nan")}, ValueError),
        ({"reconnect_delay": 10**400}, ValueError),
        ({"connect_timeout": True}, TypeError),
        ({"connect_timeout": 0}, ValueError),
        ({"connect_timeout": float("inf")}, ValueError),
        ({"connect_timeout": float("nan")}, ValueError),
        ({"request_timeout": True}, TypeError),
        ({"request_timeout": 0}, ValueError),
        ({"request_timeout": float("inf")}, ValueError),
        ({"request_timeout": float("nan")}, ValueError),
    ],
)
def test_reconnect_options_are_validated(
    kwargs: dict[str, Any], error_type: type[Exception]
) -> None:
    with pytest.raises(error_type):
        TerminalClient("ws://127.0.0.1:1/terminal", **kwargs)


@pytest.mark.asyncio
async def test_disconnect_cancels_an_initial_handshake(
    server_factory,
) -> None:
    server = await server_factory(send_info_on_connect=False)
    client = TerminalClient(server.url, reconnect=True, connect_timeout=5)
    errors: list[Exception] = []
    client.on_error(errors.append)
    connecting = asyncio.create_task(client.connect())

    await server.wait_connection_count(1, CONTRACT_TIMEOUT)
    await asyncio.wait_for(client.disconnect(), CONTRACT_TIMEOUT)
    await server.wait_peer_closed(CONTRACT_TIMEOUT)
    await asyncio.sleep(0)

    assert connecting.done()
    with pytest.raises(asyncio.CancelledError):
        await connecting
    assert errors == []
    assert not client.is_connected()
    assert _lit_shell_tasks() == []


@pytest.mark.asyncio
async def test_older_disconnect_cannot_clobber_a_new_connection(
    contract_server, monkeypatch
) -> None:
    client = TerminalClient(contract_server.url, reconnect=False)
    disconnects = 0

    def on_disconnect() -> None:
        nonlocal disconnects
        disconnects += 1

    client.on_disconnect(on_disconnect)
    first_info = await client.connect()
    old_websocket = client._ws
    assert old_websocket is not None
    close_started = asyncio.Event()
    release_close = asyncio.Event()
    original_close = ClientConnection.close

    async def delayed_close(
        connection: ClientConnection, *args: Any, **kwargs: Any
    ) -> None:
        if connection is old_websocket:
            close_started.set()
            await release_close.wait()
        await original_close(connection, *args, **kwargs)

    monkeypatch.setattr(ClientConnection, "close", delayed_close)
    disconnecting = asyncio.create_task(client.disconnect())

    try:
        await asyncio.wait_for(close_started.wait(), CONTRACT_TIMEOUT)
        reconnecting = asyncio.create_task(client.connect())
        await contract_server.wait_connection_count(2, CONTRACT_TIMEOUT)
        assert await asyncio.wait_for(reconnecting, CONTRACT_TIMEOUT) == first_info

        release_close.set()
        await asyncio.wait_for(disconnecting, CONTRACT_TIMEOUT)

        assert client.is_connected()
        assert client.get_server_info() == first_info
        assert disconnects == 1
    finally:
        release_close.set()
        await asyncio.gather(disconnecting, return_exceptions=True)
        await client.disconnect()

    assert disconnects == 2


@pytest.mark.asyncio
async def test_send_side_disconnect_consumes_pending_future_error(
    contract_server, monkeypatch
) -> None:
    client = TerminalClient(contract_server.url, reconnect=False)
    await client.connect()
    websocket = client._ws
    assert websocket is not None
    original_send = ClientConnection.send
    loop = asyncio.get_running_loop()
    loop_errors: list[dict[str, Any]] = []
    previous_handler = loop.get_exception_handler()
    loop.set_exception_handler(lambda _loop, context: loop_errors.append(context))

    async def failed_send(connection: ClientConnection, message: Any) -> None:
        if connection is websocket:
            raise ConnectionClosedError(None, None)
        await original_send(connection, message)

    monkeypatch.setattr(ClientConnection, "send", failed_send)
    try:
        with pytest.raises(ConnectionError):
            await client.list_sessions()
        gc.collect()
        await asyncio.sleep(0)
    finally:
        loop.set_exception_handler(previous_handler)
        await client.disconnect()

    assert not [
        context
        for context in loop_errors
        if "Future exception was never retrieved" in context.get("message", "")
    ]


@pytest.mark.asyncio
async def test_cancelled_disconnect_still_finishes_socket_cleanup(
    contract_server, monkeypatch
) -> None:
    client = TerminalClient(contract_server.url, reconnect=False)
    await client.connect()
    websocket = client._ws
    assert websocket is not None
    close_started = asyncio.Event()
    release_close = asyncio.Event()
    original_close = ClientConnection.close

    async def delayed_close(
        connection: ClientConnection, *args: Any, **kwargs: Any
    ) -> None:
        if connection is websocket:
            close_started.set()
            await release_close.wait()
        await original_close(connection, *args, **kwargs)

    monkeypatch.setattr(ClientConnection, "close", delayed_close)
    disconnecting = asyncio.create_task(client.disconnect())

    try:
        await asyncio.wait_for(close_started.wait(), CONTRACT_TIMEOUT)
        disconnecting.cancel()
        await asyncio.sleep(0)
        assert not disconnecting.done()

        release_close.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(disconnecting, CONTRACT_TIMEOUT)
        await contract_server.wait_peer_closed(CONTRACT_TIMEOUT)

        assert not client.is_connected()
        assert _lit_shell_tasks() == []
    finally:
        release_close.set()
        await asyncio.gather(disconnecting, return_exceptions=True)
        await client.disconnect()


@pytest.mark.asyncio
async def test_unexpected_disconnect_reconnects_and_repeats_handshake(
    contract_server,
) -> None:
    client = TerminalClient(
        contract_server.url,
        reconnect=True,
        max_reconnect_attempts=2,
        reconnect_delay=0,
    )
    connect_count = 0
    disconnect_count = 0
    reconnected = asyncio.Event()

    def on_connect() -> None:
        nonlocal connect_count
        connect_count += 1
        if connect_count == 2:
            reconnected.set()

    def on_disconnect() -> None:
        nonlocal disconnect_count
        disconnect_count += 1

    client.on_connect(on_connect)
    client.on_disconnect(on_disconnect)

    try:
        first_info = await client.connect()
        await contract_server.close_clients()

        await asyncio.wait_for(reconnected.wait(), CONTRACT_TIMEOUT)
        await contract_server.wait_connection_count(2, CONTRACT_TIMEOUT)

        assert client.is_connected()
        assert client.get_server_info() == first_info
        assert connect_count == 2
        assert disconnect_count == 1
        assert len(await client.list_sessions()) == 1

        await asyncio.sleep(0)
        task_names = [task.get_name() for task in _lit_shell_tasks()]
        assert task_names == ["lit-shell-receive"]
    finally:
        await client.disconnect()

    await asyncio.sleep(0)
    assert _lit_shell_tasks() == []


@pytest.mark.asyncio
async def test_pending_request_fails_before_connection_is_recovered(
    contract_server,
) -> None:
    client = TerminalClient(
        contract_server.url,
        reconnect=True,
        max_reconnect_attempts=2,
        reconnect_delay=0,
    )
    connect_count = 0
    reconnected = asyncio.Event()

    def on_connect() -> None:
        nonlocal connect_count
        connect_count += 1
        if connect_count == 2:
            reconnected.set()

    client.on_connect(on_connect)

    try:
        await client.connect()
        contract_server.auto_respond = False
        pending = asyncio.create_task(client.list_sessions())
        await contract_server.next_message("listSessions")
        contract_server.auto_respond = True
        await contract_server.close_clients()

        with pytest.raises(ConnectionError):
            await asyncio.wait_for(pending, CONTRACT_TIMEOUT)
        await asyncio.wait_for(reconnected.wait(), CONTRACT_TIMEOUT)

        assert client.is_connected()
        assert len(await client.list_sessions()) == 1
    finally:
        await client.disconnect()


@pytest.mark.parametrize(
    "options",
    [
        {"reconnect": False},
        {"reconnect": True, "max_reconnect_attempts": 0},
    ],
)
@pytest.mark.asyncio
async def test_reconnect_policy_can_disable_all_attempts(
    contract_server, options: dict[str, Any]
) -> None:
    client = TerminalClient(contract_server.url, reconnect_delay=0, **options)
    disconnected = asyncio.Event()
    client.on_disconnect(disconnected.set)

    try:
        await client.connect()
        await contract_server.close_clients()
        await asyncio.wait_for(disconnected.wait(), CONTRACT_TIMEOUT)
        await asyncio.sleep(0.05)

        assert contract_server.connection_count == 1
        assert not client.is_connected()
        assert _lit_shell_tasks() == []
    finally:
        await client.disconnect()


@pytest.mark.asyncio
async def test_explicit_disconnect_cancels_scheduled_reconnect(
    contract_server,
) -> None:
    client = TerminalClient(
        contract_server.url,
        reconnect=True,
        max_reconnect_attempts=2,
        reconnect_delay=0.1,
    )
    disconnected = asyncio.Event()
    client.on_disconnect(disconnected.set)

    try:
        await client.connect()
        await contract_server.close_clients()
        await asyncio.wait_for(disconnected.wait(), CONTRACT_TIMEOUT)

        await client.disconnect()
        await asyncio.sleep(0.15)

        assert contract_server.connection_count == 1
        assert not client.is_connected()
        assert _lit_shell_tasks() == []

        await client.connect()
        await contract_server.wait_connection_count(2, CONTRACT_TIMEOUT)
        assert client.is_connected()
    finally:
        await client.disconnect()

    await asyncio.sleep(0)
    assert _lit_shell_tasks() == []


@pytest.mark.asyncio
async def test_explicit_disconnect_cancels_reconnect_during_handshake(
    contract_server,
) -> None:
    client = TerminalClient(
        contract_server.url,
        reconnect=True,
        max_reconnect_attempts=2,
        reconnect_delay=0,
        connect_timeout=5,
    )

    try:
        await client.connect()
        contract_server.send_info_on_connect = False
        await contract_server.close_clients()
        await contract_server.wait_connection_count(2, CONTRACT_TIMEOUT)

        await asyncio.wait_for(client.disconnect(), CONTRACT_TIMEOUT)
        await asyncio.sleep(0.05)

        assert contract_server.connection_count == 2
        assert not client.is_connected()
        assert _lit_shell_tasks() == []
    finally:
        await client.disconnect()


@pytest.mark.asyncio
async def test_cancelling_manual_recovery_closes_unannounced_transport(
    contract_server,
) -> None:
    contract_server.sessions[0]["accepting"] = False
    client = TerminalClient(
        contract_server.url,
        reconnect=False,
        request_timeout=5,
    )
    events: list[str] = []
    client.on_connect(lambda: events.append("connect"))
    client.on_disconnect(lambda: events.append("disconnect"))

    try:
        await client.connect()
        await client.spawn()
        await contract_server.next_message("spawn")
        contract_server.auto_respond = False
        await contract_server.close_clients()
        await contract_server.wait_active_connection_count(0, CONTRACT_TIMEOUT)

        recovering = asyncio.create_task(client.connect())
        await contract_server.wait_connection_count(2, CONTRACT_TIMEOUT)
        await contract_server.next_message("join")
        recovering.cancel()

        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(recovering, CONTRACT_TIMEOUT)
        await contract_server.wait_active_connection_count(0, CONTRACT_TIMEOUT)
        await asyncio.sleep(0)

        assert events == ["connect", "disconnect"]
        assert not client.is_connected()
        assert client.get_session_id() == SESSION["sessionId"]
        assert _lit_shell_tasks() == []

        contract_server.auto_respond = True
        await client.connect()
        await contract_server.wait_connection_count(3, CONTRACT_TIMEOUT)
        recovery = await contract_server.next_message("join")
        assert recovery["options"]["resumeToken"] == RESUME_TOKEN
        assert events == ["connect", "disconnect", "connect"]
        assert client.has_active_session()
    finally:
        await client.disconnect()


@pytest.mark.asyncio
async def test_transport_loss_during_recovery_does_not_duplicate_disconnect(
    contract_server,
) -> None:
    contract_server.sessions[0]["accepting"] = False
    client = TerminalClient(
        contract_server.url,
        reconnect=True,
        max_reconnect_attempts=3,
        reconnect_delay=0,
    )
    events: list[str] = []
    reconnected = asyncio.Event()

    def on_connect() -> None:
        events.append("connect")
        if events.count("connect") == 2:
            reconnected.set()

    client.on_connect(on_connect)
    client.on_disconnect(lambda: events.append("disconnect"))

    try:
        await client.connect()
        await client.spawn()
        await contract_server.next_message("spawn")
        contract_server.auto_respond = False
        await contract_server.close_clients()

        await contract_server.wait_connection_count(2, CONTRACT_TIMEOUT)
        await contract_server.next_message("join")
        contract_server.auto_respond = True
        await contract_server.close_clients()

        await asyncio.wait_for(reconnected.wait(), CONTRACT_TIMEOUT)
        await contract_server.wait_connection_count(3, CONTRACT_TIMEOUT)
        recovery = await contract_server.next_message("join")

        assert recovery["options"]["resumeToken"] == RESUME_TOKEN
        assert events == ["connect", "disconnect", "connect"]
        assert client.is_connected()
        assert client.has_active_session()
    finally:
        await client.disconnect()


@pytest.mark.asyncio
async def test_recovery_timeout_replaces_transport_and_retries_session(
    contract_server,
) -> None:
    contract_server.sessions[0]["accepting"] = False
    client = TerminalClient(
        contract_server.url,
        reconnect=True,
        max_reconnect_attempts=3,
        reconnect_delay=0,
        request_timeout=0.03,
    )
    errors: list[Exception] = []
    reconnected = asyncio.Event()
    connect_count = 0

    def on_connect() -> None:
        nonlocal connect_count
        connect_count += 1
        if connect_count == 2:
            reconnected.set()

    client.on_connect(on_connect)
    client.on_error(errors.append)

    try:
        await client.connect()
        await client.spawn()
        await contract_server.next_message("spawn")
        contract_server.auto_respond = False
        await contract_server.close_clients()

        await contract_server.wait_connection_count(2, CONTRACT_TIMEOUT)
        await contract_server.next_message("join")
        contract_server.auto_respond = True

        await asyncio.wait_for(reconnected.wait(), CONTRACT_TIMEOUT)
        await contract_server.wait_connection_count(3, CONTRACT_TIMEOUT)
        recovery = await contract_server.next_message("join")

        assert recovery["options"]["resumeToken"] == RESUME_TOKEN
        assert contract_server.active_connection_count == 1
        assert len(errors) == 1
        assert isinstance(errors[0], asyncio.TimeoutError)
        assert client.is_connected()
        assert client.has_active_session()
    finally:
        await client.disconnect()


@pytest.mark.asyncio
async def test_reconnect_stops_after_configured_attempt_limit(
    contract_server,
) -> None:
    client = TerminalClient(
        contract_server.url,
        reconnect=True,
        max_reconnect_attempts=2,
        reconnect_delay=0,
        connect_timeout=0.03,
    )
    errors: list[Exception] = []
    attempts_exhausted = asyncio.Event()

    def on_error(error: Exception) -> None:
        errors.append(error)
        if len(errors) == 2:
            attempts_exhausted.set()

    client.on_error(on_error)

    try:
        await client.connect()
        contract_server.send_info_on_connect = False
        await contract_server.close_clients()

        await asyncio.wait_for(attempts_exhausted.wait(), CONTRACT_TIMEOUT)
        await contract_server.wait_connection_count(3, CONTRACT_TIMEOUT)
        await asyncio.sleep(0.05)

        assert contract_server.connection_count == 3
        assert len(errors) == 2
        assert not client.is_connected()
        assert _lit_shell_tasks() == []
    finally:
        await client.disconnect()


@pytest.mark.asyncio
async def test_spawned_private_session_is_recovered_before_connect_event(
    contract_server,
) -> None:
    contract_server.sessions[0]["accepting"] = False
    client = TerminalClient(
        contract_server.url,
        reconnect=True,
        max_reconnect_attempts=2,
        reconnect_delay=0,
    )
    output: list[str] = []
    connect_snapshots: list[tuple[bool, str | None, list[str]]] = []
    disconnect_snapshots: list[tuple[bool, str | None]] = []
    reconnected = asyncio.Event()

    def on_connect() -> None:
        connect_snapshots.append(
            (client.is_connected(), client.get_session_id(), list(output))
        )
        if len(connect_snapshots) == 2:
            reconnected.set()

    client.on_data(output.append)
    client.on_connect(on_connect)
    client.on_disconnect(
        lambda: disconnect_snapshots.append(
            (client.is_connected(), client.get_session_id())
        )
    )

    try:
        await client.connect()
        spawned = await client.spawn(enable_history=True)
        await contract_server.next_message("spawn")
        assert not hasattr(spawned, "resume_token")

        contract_server.auto_respond = False
        await contract_server.close_clients()
        recovery = await contract_server.next_message("join")

        assert not client.is_connected()
        assert client.get_session_id() == SESSION["sessionId"]
        with pytest.raises(RuntimeError, match="Not connected"):
            await client.list_sessions()

        await contract_server.send(
            {
                "type": "joined",
                "sessionId": SESSION["sessionId"],
                "session": contract_server.sessions[0],
                "history": contract_server.history,
                "resumeToken": RESUME_TOKEN,
            }
        )
        await asyncio.wait_for(reconnected.wait(), CONTRACT_TIMEOUT)

        assert recovery == {
            "type": "join",
            "options": {
                "sessionId": SESSION["sessionId"],
                "requestHistory": True,
                "historyLimit": 50000,
                "resumeToken": RESUME_TOKEN,
            },
        }
        assert disconnect_snapshots == [(False, SESSION["sessionId"])]
        assert connect_snapshots[1] == (
            True,
            SESSION["sessionId"],
            [contract_server.history],
        )
        assert client.has_active_session()
        assert output == [contract_server.history]

        contract_server.auto_respond = True
        sessions = await client.list_sessions()
        assert sessions and not hasattr(sessions[0], "resume_token")
    finally:
        await client.disconnect()


@pytest.mark.asyncio
async def test_joined_owner_session_reuses_token_and_history_preference(
    contract_server,
) -> None:
    contract_server.sessions[0]["accepting"] = False
    client = TerminalClient(
        contract_server.url,
        reconnect=True,
        max_reconnect_attempts=2,
        reconnect_delay=0,
    )
    output: list[str] = []
    connect_count = 0
    reconnected = asyncio.Event()

    def on_connect() -> None:
        nonlocal connect_count
        connect_count += 1
        if connect_count == 2:
            reconnected.set()

    client.on_data(output.append)
    client.on_connect(on_connect)

    try:
        await client.connect()
        joined = await client.join(
            SESSION["sessionId"],
            request_history=False,
            history_limit=123,
            resume_token=RESUME_TOKEN,
        )
        initial_join = await contract_server.next_message("join")
        assert initial_join["options"]["resumeToken"] == RESUME_TOKEN
        assert not hasattr(joined, "resume_token")

        await contract_server.close_clients()
        await asyncio.wait_for(reconnected.wait(), CONTRACT_TIMEOUT)
        recovery = await contract_server.next_message("join")

        assert recovery["options"] == {
            "sessionId": SESSION["sessionId"],
            "requestHistory": False,
            "historyLimit": 123,
            "resumeToken": RESUME_TOKEN,
        }
        assert output == []
        assert client.get_session_id() == SESSION["sessionId"]
    finally:
        await client.disconnect()


@pytest.mark.asyncio
async def test_rejected_session_recovery_keeps_transport_connected(
    contract_server,
) -> None:
    contract_server.sessions[0]["accepting"] = False
    client = TerminalClient(
        contract_server.url,
        reconnect=True,
        max_reconnect_attempts=3,
        reconnect_delay=0,
    )
    errors: list[Exception] = []
    connect_count = 0
    reconnected = asyncio.Event()

    def on_connect() -> None:
        nonlocal connect_count
        connect_count += 1
        if connect_count == 2:
            reconnected.set()

    client.on_connect(on_connect)
    client.on_error(errors.append)

    try:
        await client.connect()
        await client.spawn()
        await contract_server.next_message("spawn")
        contract_server.resume_token = "rotated-owner-token"

        await contract_server.close_clients()
        await asyncio.wait_for(reconnected.wait(), CONTRACT_TIMEOUT)
        recovery = await contract_server.next_message("join")
        await asyncio.sleep(0.05)

        assert recovery["options"]["resumeToken"] == RESUME_TOKEN
        assert contract_server.connection_count == 2
        assert len(errors) == 1
        assert "not accepting" in str(errors[0])
        assert client.is_connected()
        assert not client.has_active_session()
        assert len(await client.list_sessions()) == 1
    finally:
        await client.disconnect()


@pytest.mark.parametrize("action", ["kill", "leave", "session_closed"])
@pytest.mark.asyncio
async def test_explicit_session_end_prevents_recovery(
    contract_server, action: str
) -> None:
    client = TerminalClient(
        contract_server.url,
        reconnect=True,
        max_reconnect_attempts=2,
        reconnect_delay=0,
    )
    connect_count = 0
    reconnected = asyncio.Event()

    def on_connect() -> None:
        nonlocal connect_count
        connect_count += 1
        if connect_count == 2:
            reconnected.set()

    client.on_connect(on_connect)

    try:
        await client.connect()
        await client.spawn()
        await contract_server.next_message("spawn")

        if action == "kill":
            await client.kill()
            await contract_server.next_message("close")
        elif action == "leave":
            client.leave()
            await contract_server.next_message("leave")
        else:
            session_closed = asyncio.Event()
            client.on_session_closed(lambda _session_id, _reason: session_closed.set())
            await contract_server.send(
                {
                    "type": "sessionClosed",
                    "sessionId": SESSION["sessionId"],
                    "reason": "owner_closed",
                }
            )
            await asyncio.wait_for(session_closed.wait(), CONTRACT_TIMEOUT)

        await contract_server.close_clients()
        await asyncio.wait_for(reconnected.wait(), CONTRACT_TIMEOUT)

        with pytest.raises(asyncio.TimeoutError):
            await contract_server.next_message(timeout=0.05)
        assert not client.has_active_session()
    finally:
        await client.disconnect()
