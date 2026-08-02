from __future__ import annotations

import asyncio

import pytest

from lit_shell import TerminalClient

from .conftest import CONTRACT_TIMEOUT, cancel_and_wait
from .contract_server import SESSION


@pytest.mark.asyncio
async def test_spawn_request_matches_the_public_wire_contract(
    server_factory,
) -> None:
    # Use a fresh manual server so no response can obscure the request assertion.
    manual_server = await server_factory(auto_respond=False)

    client = TerminalClient(manual_server.url, reconnect=False)
    await client.connect()
    task = asyncio.create_task(
        client.spawn(
            cols=132,
            rows=43,
            env={"TERM": "xterm-256color"},
            container="worker-1",
            container_shell="/bin/ash",
            container_user="1000:1000",
            container_cwd="/workspace",
            label="quality",
            allow_join=False,
            enable_history=False,
        )
    )

    try:
        request = await manual_server.next_message("spawn")
        assert request == {
            "type": "spawn",
            "options": {
                "cols": 132,
                "rows": 43,
                "env": {"TERM": "xterm-256color"},
                "container": "worker-1",
                "containerShell": "/bin/ash",
                "containerUser": "1000:1000",
                "containerCwd": "/workspace",
                "label": "quality",
                "allowJoin": False,
                "enableHistory": False,
            },
        }
    finally:
        await cancel_and_wait(task)
        await client.disconnect()


@pytest.mark.asyncio
async def test_attach_request_excludes_exec_only_options(server_factory) -> None:
    manual_server = await server_factory(auto_respond=False)
    client = TerminalClient(manual_server.url, reconnect=False)
    await client.connect()
    task = asyncio.create_task(
        client.spawn(
            container="worker-1",
            attach_mode=True,
            cols=100,
            rows=30,
            label="attached",
            allow_join=True,
        )
    )

    try:
        request = await manual_server.next_message("spawn")
        assert request == {
            "type": "spawn",
            "options": {
                "cols": 100,
                "rows": 30,
                "container": "worker-1",
                "attachMode": True,
                "label": "attached",
                "allowJoin": True,
            },
        }
    finally:
        await cancel_and_wait(task)
        await client.disconnect()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "options",
    [
        {"attach_mode": True},
        {"container_shell": "/bin/sh"},
        {"container": "worker-1", "shell": "/bin/sh"},
        {"container": "worker-1", "cwd": "/workspace"},
        {"container": "worker-1", "attach_mode": True, "env": {}},
        {
            "container": "worker-1",
            "attach_mode": True,
            "container_user": "1000",
        },
    ],
)
async def test_spawn_rejects_incompatible_target_options(
    connected_client, options
) -> None:
    with pytest.raises(ValueError):
        await connected_client.spawn(**options)


@pytest.mark.asyncio
async def test_standard_spawned_response_completes_spawn(
    connected_client, contract_server
) -> None:
    spawned = []
    connected_client.on_spawned(spawned.append)

    session = await asyncio.wait_for(
        connected_client.spawn(shell="/bin/sh", cwd="/work", cols=100, rows=32),
        CONTRACT_TIMEOUT,
    )

    assert session.session_id == SESSION["sessionId"]
    assert session.shell == "/bin/sh"
    assert session.cwd == "/work"
    assert (session.cols, session.rows) == (100, 32)
    assert connected_client.get_session_id() == SESSION["sessionId"]
    assert connected_client.get_session_info() == session
    assert spawned == [session]
    request = await contract_server.next_message("spawn")
    assert request["options"]["allowJoin"] is False


async def _spawn_for_io(client) -> None:
    await asyncio.wait_for(client.spawn(shell="/bin/sh", cwd="/work"), CONTRACT_TIMEOUT)


@pytest.mark.asyncio
async def test_write_targets_the_active_session(
    connected_client, contract_server
) -> None:
    await _spawn_for_io(connected_client)
    await connected_client.write("printf 'hello'\n")

    await contract_server.next_message("spawn")
    assert await contract_server.next_message("data") == {
        "type": "data",
        "sessionId": SESSION["sessionId"],
        "data": "printf 'hello'\n",
    }


@pytest.mark.asyncio
async def test_resize_targets_the_active_session(
    connected_client, contract_server
) -> None:
    await _spawn_for_io(connected_client)
    await connected_client.resize(144, 51)

    await contract_server.next_message("spawn")
    assert await contract_server.next_message("resize") == {
        "type": "resize",
        "sessionId": SESSION["sessionId"],
        "cols": 144,
        "rows": 51,
    }


@pytest.mark.asyncio
async def test_kill_uses_the_close_message_and_session_id(
    connected_client, contract_server
) -> None:
    await _spawn_for_io(connected_client)
    await connected_client.kill()

    await contract_server.next_message("spawn")
    assert await contract_server.next_message() == {
        "type": "close",
        "sessionId": SESSION["sessionId"],
    }
    assert not connected_client.has_active_session()


@pytest.mark.asyncio
async def test_io_without_an_active_session_is_rejected(connected_client) -> None:
    with pytest.raises(RuntimeError, match="active session"):
        await connected_client.write("unsafe\n")
    with pytest.raises(RuntimeError, match="active session"):
        await connected_client.resize(80, 24)


@pytest.mark.asyncio
async def test_active_session_rejects_another_spawn_or_join(
    connected_client,
) -> None:
    await _spawn_for_io(connected_client)

    with pytest.raises(RuntimeError, match="Session already active"):
        await connected_client.spawn()
    with pytest.raises(RuntimeError, match="Session already active"):
        await connected_client.join(SESSION["sessionId"])


@pytest.mark.asyncio
async def test_pending_spawn_reserves_the_single_session_slot(
    server_factory,
) -> None:
    server = await server_factory(auto_respond=False)
    client = TerminalClient(server.url, reconnect=False)
    await client.connect()
    spawning = asyncio.create_task(client.spawn())

    try:
        await server.next_message("spawn")
        with pytest.raises(RuntimeError, match="Session already active"):
            await client.join(SESSION["sessionId"])
    finally:
        await cancel_and_wait(spawning)
        await client.disconnect()
