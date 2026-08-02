"""
lit-shell Python client bindings.

A Python client for connecting to lit-shell WebSocket terminal servers.

Usage:
    from lit_shell import TerminalClient

    async with TerminalClient("ws://localhost:3000/terminal") as client:
        session = await client.spawn(shell="/bin/bash")

        client.on_data(lambda data: print(data, end=""))

        await client.write("ls -la\\n")
        await asyncio.sleep(1)
"""

from .client import TerminalClient
from .types import (
    JoinOptions,
    ServerInfo,
    SessionInfo,
    SessionListFilter,
    SharedSessionInfo,
    TerminalOptions,
)

__version__ = "1.2.1"
__all__ = [
    "JoinOptions",
    "ServerInfo",
    "SessionInfo",
    "SessionListFilter",
    "SharedSessionInfo",
    "TerminalClient",
    "TerminalOptions",
]
