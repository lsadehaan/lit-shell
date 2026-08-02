from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

import pytest_asyncio

from lit_shell import TerminalClient

from .contract_server import ContractServer

CONTRACT_TIMEOUT = 0.5


async def cancel_and_wait(task: asyncio.Task[Any]) -> None:
    if not task.done():
        task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    except Exception:
        pass


@pytest_asyncio.fixture
async def server_factory() -> AsyncIterator[Callable[..., Awaitable[ContractServer]]]:
    servers: list[ContractServer] = []

    async def create(**kwargs: Any) -> ContractServer:
        server = await ContractServer(**kwargs).start()
        servers.append(server)
        return server

    yield create

    for server in reversed(servers):
        await server.close()


@pytest_asyncio.fixture
async def contract_server(server_factory: Callable[..., Awaitable[ContractServer]]):
    return await server_factory()


@pytest_asyncio.fixture
async def connected_client(
    contract_server: ContractServer,
) -> AsyncIterator[TerminalClient]:
    client = TerminalClient(contract_server.url, reconnect=False)
    await client.connect()
    await contract_server.wait_connected()
    try:
        yield client
    finally:
        await client.disconnect()
