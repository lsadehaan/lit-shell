from __future__ import annotations

import asyncio

import pytest

from .conftest import CONTRACT_TIMEOUT, cancel_and_wait
from .contract_server import SESSION


@pytest.mark.asyncio
async def test_protocol_events_decode_documented_fields(
    connected_client, contract_server
) -> None:
    await asyncio.wait_for(
        connected_client.join(SESSION["sessionId"]), CONTRACT_TIMEOUT
    )
    data_events: list[str] = []
    exit_events: list[int] = []
    error_events: list[Exception] = []
    joined_events: list[tuple[str, int]] = []
    left_events: list[tuple[str, int]] = []
    closed_events: list[tuple[str, str]] = []
    complete = asyncio.Event()

    connected_client.on_data(data_events.append)
    connected_client.on_exit(exit_events.append)
    connected_client.on_error(error_events.append)
    connected_client.on_client_joined(
        lambda sid, count: joined_events.append((sid, count))
    )
    connected_client.on_client_left(lambda sid, count: left_events.append((sid, count)))

    def on_closed(session_id: str, reason: str) -> None:
        closed_events.append((session_id, reason))
        complete.set()

    connected_client.on_session_closed(on_closed)

    await contract_server.send(
        {"type": "data", "sessionId": SESSION["sessionId"], "data": "output\r\n"}
    )
    await contract_server.send(
        {"type": "clientJoined", "sessionId": SESSION["sessionId"], "clientCount": 3}
    )
    await contract_server.send(
        {"type": "clientLeft", "sessionId": SESSION["sessionId"], "clientCount": 2}
    )
    await contract_server.send(
        {"type": "exit", "sessionId": SESSION["sessionId"], "exitCode": 17}
    )
    await contract_server.send(
        {"type": "error", "sessionId": SESSION["sessionId"], "error": "pty failed"}
    )
    await contract_server.send(
        {
            "type": "sessionClosed",
            "sessionId": SESSION["sessionId"],
            "reason": "process_exit",
        }
    )

    await asyncio.wait_for(complete.wait(), CONTRACT_TIMEOUT)
    assert data_events == ["output\r\n"]
    assert exit_events == [17]
    assert len(error_events) == 1
    assert str(error_events[0]) == "pty failed"
    assert joined_events == [(SESSION["sessionId"], 3)]
    assert left_events == [(SESSION["sessionId"], 2)]
    assert closed_events == [(SESSION["sessionId"], "process_exit")]


@pytest.mark.asyncio
async def test_malformed_unknown_messages_and_raising_handler_do_not_stop_events(
    connected_client, contract_server
) -> None:
    await asyncio.wait_for(
        connected_client.join(SESSION["sessionId"]), CONTRACT_TIMEOUT
    )
    observed: list[str] = []
    delivered = asyncio.Event()

    def broken_handler(_data: str) -> None:
        raise ValueError("consumer bug")

    def healthy_handler(data: str) -> None:
        observed.append(data)
        if data == "still-alive":
            delivered.set()

    connected_client.on_data(broken_handler)
    connected_client.on_data(healthy_handler)

    await contract_server.send_raw("not valid JSON")
    await contract_server.send_raw("[]")
    await contract_server.send({"type": "futureExtension", "value": "ignored"})
    await contract_server.send(
        {"type": "data", "sessionId": SESSION["sessionId"], "data": "still-alive"}
    )

    await asyncio.wait_for(delivered.wait(), CONTRACT_TIMEOUT)
    assert observed == ["still-alive"]
    assert connected_client.is_connected()


@pytest.mark.asyncio
async def test_stale_session_data_and_exit_are_ignored(
    connected_client, contract_server
) -> None:
    await asyncio.wait_for(
        connected_client.join(SESSION["sessionId"]), CONTRACT_TIMEOUT
    )
    data_events: list[str] = []
    exit_events: list[int] = []
    delivered = asyncio.Event()

    def on_data(data: str) -> None:
        data_events.append(data)
        delivered.set()

    connected_client.on_data(on_data)
    connected_client.on_exit(exit_events.append)

    await contract_server.send(
        {"type": "data", "sessionId": "stale-session", "data": "stale"}
    )
    await contract_server.send(
        {"type": "exit", "sessionId": "stale-session", "exitCode": 99}
    )
    await contract_server.send(
        {"type": "data", "sessionId": SESSION["sessionId"], "data": "current"}
    )

    await asyncio.wait_for(delivered.wait(), CONTRACT_TIMEOUT)
    assert data_events == ["current"]
    assert exit_events == []
    assert connected_client.get_session_id() == SESSION["sessionId"]


@pytest.mark.asyncio
async def test_session_closed_clears_the_matching_active_session(
    connected_client, contract_server
) -> None:
    await asyncio.wait_for(
        connected_client.join(SESSION["sessionId"]), CONTRACT_TIMEOUT
    )
    assert connected_client.has_active_session()

    closed = asyncio.Event()
    connected_client.on_session_closed(lambda _sid, _reason: closed.set())
    await contract_server.send(
        {
            "type": "sessionClosed",
            "sessionId": SESSION["sessionId"],
            "reason": "owner_closed",
        }
    )

    await asyncio.wait_for(closed.wait(), CONTRACT_TIMEOUT)
    assert not connected_client.has_active_session()
    assert connected_client.get_session_info() is None


@pytest.mark.asyncio
async def test_remote_disconnect_notifies_once_and_rejects_pending_requests(
    connected_client, contract_server
) -> None:
    contract_server.auto_respond = False
    disconnected = asyncio.Event()
    disconnect_count = 0

    def on_disconnect() -> None:
        nonlocal disconnect_count
        disconnect_count += 1
        disconnected.set()

    connected_client.on_disconnect(on_disconnect)
    pending = asyncio.create_task(connected_client.list_sessions())
    await contract_server.next_message("listSessions")
    await contract_server.close_clients()

    try:
        await asyncio.wait_for(disconnected.wait(), CONTRACT_TIMEOUT)
        with pytest.raises((ConnectionError, RuntimeError)):
            await asyncio.wait_for(pending, CONTRACT_TIMEOUT)
        assert disconnect_count == 1
        assert not connected_client.is_connected()
    finally:
        await cancel_and_wait(pending)


@pytest.mark.asyncio
async def test_local_disconnect_rejects_pending_requests(
    connected_client, contract_server
) -> None:
    contract_server.auto_respond = False
    pending = asyncio.create_task(connected_client.list_sessions())
    await contract_server.next_message("listSessions")

    await connected_client.disconnect()
    try:
        with pytest.raises((ConnectionError, RuntimeError)):
            await asyncio.wait_for(pending, CONTRACT_TIMEOUT)
    finally:
        await cancel_and_wait(pending)


@pytest.mark.asyncio
async def test_caller_timeout_cancels_an_operation_cleanly(
    connected_client, contract_server
) -> None:
    contract_server.auto_respond = False
    pending = asyncio.create_task(connected_client.list_sessions())
    await contract_server.next_message("listSessions")

    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(pending, 0.05)

    assert pending.cancelled()
    await asyncio.wait_for(connected_client.disconnect(), CONTRACT_TIMEOUT)
