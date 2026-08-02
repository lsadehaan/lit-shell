from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import pytest

from lit_shell import TerminalClient

from .conftest import CONTRACT_TIMEOUT, cancel_and_wait
from .contract_server import SESSION


@pytest.mark.asyncio
async def test_list_sessions_request_matches_the_wire_contract(server_factory) -> None:
    server = await server_factory(auto_respond=False)
    client = TerminalClient(server.url, reconnect=False)
    await client.connect()
    task = asyncio.create_task(
        client.list_sessions(type="local", container="worker-1", accepting=False)
    )

    try:
        assert await server.next_message("listSessions") == {
            "type": "listSessions",
            "filter": {
                "type": "local",
                "container": "worker-1",
                "accepting": False,
            },
        }
    finally:
        await cancel_and_wait(task)
        await client.disconnect()


@pytest.mark.asyncio
async def test_session_list_response_is_decoded_without_request_ids(
    connected_client,
) -> None:
    sessions = await asyncio.wait_for(
        connected_client.list_sessions(), CONTRACT_TIMEOUT
    )

    assert len(sessions) == 1
    session = sessions[0]
    assert session.session_id == SESSION["sessionId"]
    assert session.type == "local"
    assert session.shell == "/bin/sh"
    assert session.cwd == "/work"
    assert (session.cols, session.rows) == (100, 32)
    assert session.client_count == 2
    assert session.owner == "client-owner"
    assert session.label == "contract-session"
    assert session.accepting is True
    assert session.created_at == datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc)


@pytest.mark.asyncio
async def test_join_request_and_history_follow_the_wire_contract(
    connected_client, contract_server
) -> None:
    output: list[str] = []
    connected_client.on_data(output.append)

    joined = await asyncio.wait_for(
        connected_client.join(
            SESSION["sessionId"], request_history=True, history_limit=1234
        ),
        CONTRACT_TIMEOUT,
    )

    assert await contract_server.next_message("join") == {
        "type": "join",
        "options": {
            "sessionId": SESSION["sessionId"],
            "requestHistory": True,
            "historyLimit": 1234,
        },
    }
    assert joined.session_id == SESSION["sessionId"]
    assert joined.owner == "client-owner"
    assert joined.client_count == 2
    assert output == [contract_server.history]
    assert connected_client.get_session_id() == SESSION["sessionId"]


@pytest.mark.asyncio
async def test_join_without_history_does_not_emit_data(
    connected_client, contract_server
) -> None:
    output: list[str] = []
    connected_client.on_data(output.append)

    await asyncio.wait_for(
        connected_client.join(SESSION["sessionId"], request_history=False),
        CONTRACT_TIMEOUT,
    )

    request = await contract_server.next_message("join")
    assert request["options"]["requestHistory"] is False
    assert output == []


@pytest.mark.asyncio
async def test_leave_preserves_the_server_session(
    connected_client, contract_server
) -> None:
    await asyncio.wait_for(
        connected_client.join(SESSION["sessionId"]), CONTRACT_TIMEOUT
    )
    await contract_server.next_message("join")

    connected_client.leave()
    assert await contract_server.next_message("leave") == {
        "type": "leave",
        "sessionId": SESSION["sessionId"],
    }
    assert not connected_client.has_active_session()


@pytest.mark.asyncio
async def test_join_error_rejects_the_matching_operation(connected_client) -> None:
    with pytest.raises(RuntimeError, match="Session not found"):
        await asyncio.wait_for(connected_client.join("term-missing"), CONTRACT_TIMEOUT)


@pytest.mark.asyncio
async def test_different_concurrent_operations_are_correlated_by_response_type(
    connected_client,
) -> None:
    list_task = asyncio.create_task(connected_client.list_sessions())
    spawn_task = asyncio.create_task(connected_client.spawn(shell="/bin/sh"))

    try:
        sessions, spawned = await asyncio.wait_for(
            asyncio.gather(list_task, spawn_task), CONTRACT_TIMEOUT
        )
        assert sessions[0].session_id == SESSION["sessionId"]
        assert spawned.session_id == SESSION["sessionId"]
    finally:
        await cancel_and_wait(list_task)
        await cancel_and_wait(spawn_task)


@pytest.mark.asyncio
async def test_same_type_requests_resolve_in_request_order(server_factory) -> None:
    server = await server_factory(auto_respond=False)
    client = TerminalClient(server.url, reconnect=False)
    await client.connect()

    first = asyncio.create_task(client.list_sessions())
    await server.next_message("listSessions")
    second = asyncio.create_task(client.list_sessions())
    await server.next_message("listSessions")

    first_session = {**SESSION, "sessionId": "term-first", "label": "first"}
    second_session = {**SESSION, "sessionId": "term-second", "label": "second"}
    await server.send({"type": "sessionList", "sessions": [first_session]})
    await server.send({"type": "sessionList", "sessions": [second_session]})

    try:
        first_result, second_result = await asyncio.wait_for(
            asyncio.gather(first, second), CONTRACT_TIMEOUT
        )
        assert first_result[0].session_id == "term-first"
        assert second_result[0].session_id == "term-second"
    finally:
        await cancel_and_wait(first)
        await cancel_and_wait(second)
