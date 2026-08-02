from __future__ import annotations

import asyncio

import pytest

from lit_shell import TerminalClient

from .conftest import CONTRACT_TIMEOUT, cancel_and_wait


@pytest.mark.asyncio
async def test_connect_returns_the_advertised_server_capabilities(
    contract_server,
) -> None:
    client = TerminalClient(contract_server.url, reconnect=False)

    try:
        info = await client.connect()
        assert info.local_enabled is True
        assert info.docker_enabled is True
        assert info.allowed_shells == ["/bin/sh", "/bin/bash"]
        assert info.default_shell == "/bin/sh"
        assert info.default_container_shell == "/bin/sh"
    finally:
        await client.disconnect()


@pytest.mark.asyncio
async def test_connect_completes_only_after_server_info(server_factory) -> None:
    server = await server_factory(send_info_on_connect=False)
    client = TerminalClient(server.url, reconnect=False)
    connected_events: list[bool] = []
    client.on_connect(lambda: connected_events.append(True))
    task = asyncio.create_task(client.connect())

    try:
        await server.wait_connected()
        await asyncio.sleep(0.05)
        assert not task.done(), "connect() completed before the protocol handshake"
        assert connected_events == []

        await server.send_server_info()
        await asyncio.wait_for(task, CONTRACT_TIMEOUT)
        assert client.is_connected()
        assert connected_events == [True]
    finally:
        await cancel_and_wait(task)
        await client.disconnect()


@pytest.mark.asyncio
async def test_connect_rejects_a_non_server_info_handshake(server_factory) -> None:
    server = await server_factory(send_info_on_connect=False)
    client = TerminalClient(server.url, reconnect=False)
    task = asyncio.create_task(client.connect())

    try:
        await server.wait_connected()
        await server.send({"type": "data", "sessionId": "unexpected", "data": "x"})
        with pytest.raises(RuntimeError, match="serverInfo"):
            await asyncio.wait_for(task, CONTRACT_TIMEOUT)
        assert not client.is_connected()
    finally:
        await cancel_and_wait(task)
        await client.disconnect()


@pytest.mark.asyncio
async def test_connect_rejects_malformed_server_info(server_factory) -> None:
    server = await server_factory(send_info_on_connect=False)
    client = TerminalClient(server.url, reconnect=False)
    task = asyncio.create_task(client.connect())

    try:
        await server.wait_connected()
        await server.send({"type": "serverInfo", "info": []})
        with pytest.raises(RuntimeError, match=r"serverInfo\.info must be an object"):
            await asyncio.wait_for(task, CONTRACT_TIMEOUT)
        assert not client.is_connected()
    finally:
        await cancel_and_wait(task)
        await client.disconnect()


@pytest.mark.asyncio
async def test_async_context_manager_closes_the_websocket(contract_server) -> None:
    client = TerminalClient(contract_server.url, reconnect=False)

    async with client as entered:
        assert entered is client
        assert client.is_connected()
        await contract_server.wait_connected()

    assert not client.is_connected()
    await contract_server.wait_peer_closed()


@pytest.mark.asyncio
async def test_connect_failure_invokes_error_handler(unused_tcp_port: int) -> None:
    client = TerminalClient(
        f"ws://127.0.0.1:{unused_tcp_port}/terminal", reconnect=False
    )
    errors: list[Exception] = []
    client.on_error(errors.append)

    with pytest.raises(OSError):
        await client.connect()

    assert len(errors) == 1
    assert isinstance(errors[0], OSError)
    assert not client.is_connected()


@pytest.mark.asyncio
async def test_disconnect_is_idempotent_and_notifies_once(contract_server) -> None:
    client = TerminalClient(contract_server.url, reconnect=False)
    notifications: list[bool] = []
    client.on_disconnect(lambda: notifications.append(True))
    await client.connect()

    await client.disconnect()
    await client.disconnect()

    assert notifications == [True]
    assert not client.is_connected()
