"""A deterministic implementation of the public lit-shell wire contract.

The server in this module is intentionally independent from the TypeScript
implementation.  In particular, responses don't copy unknown fields from
requests.  This makes client-generated correlation IDs ineffective unless
they become part of the documented protocol on both sides.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any, Optional

import websockets

SERVER_INFO = {
    "type": "serverInfo",
    "info": {
        "localEnabled": True,
        "dockerEnabled": True,
        "allowedShells": ["/bin/sh", "/bin/bash"],
        "defaultShell": "/bin/sh",
        "defaultContainerShell": "/bin/sh",
    },
}

SESSION = {
    "sessionId": "term-contract-1",
    "type": "local",
    "shell": "/bin/sh",
    "cwd": "/work",
    "cols": 100,
    "rows": 32,
    "createdAt": "2026-01-02T03:04:05.000Z",
    "clientCount": 2,
    "accepting": True,
    "ownerId": "client-owner",
    "label": "contract-session",
    "historyEnabled": True,
}

RESUME_TOKEN = "contract-owner-resume-token"


@dataclass
class ContractServer:
    """Small WebSocket server that speaks only documented protocol fields."""

    send_info_on_connect: bool = True
    auto_respond: bool = True
    history: str = "before-join\r\n"
    resume_token: str = RESUME_TOKEN
    sessions: list[dict[str, Any]] = field(default_factory=lambda: [dict(SESSION)])
    received: asyncio.Queue[dict[str, Any]] = field(
        default_factory=asyncio.Queue, init=False
    )
    raw_received: asyncio.Queue[Any] = field(default_factory=asyncio.Queue, init=False)
    connection_count: int = field(default=0, init=False)

    def __post_init__(self) -> None:
        self._server: Any = None
        self._connections: set[Any] = set()
        self._connected = asyncio.Event()
        self._connection_count_changed = asyncio.Event()
        self._peer_closed = asyncio.Event()
        self.url = ""

    async def start(self) -> "ContractServer":
        self._server = await websockets.serve(self._handle_connection, "127.0.0.1", 0)
        port = self._server.sockets[0].getsockname()[1]
        self.url = f"ws://127.0.0.1:{port}/terminal"
        return self

    async def close(self) -> None:
        connections = list(self._connections)
        if connections:
            await asyncio.gather(
                *(connection.close() for connection in connections),
                return_exceptions=True,
            )
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()

    async def wait_connected(self, timeout: float = 1.0) -> None:
        await asyncio.wait_for(self._connected.wait(), timeout)

    async def wait_peer_closed(self, timeout: float = 1.0) -> None:
        await asyncio.wait_for(self._peer_closed.wait(), timeout)

    async def wait_connection_count(self, count: int, timeout: float = 1.0) -> None:
        async def wait_until_reached() -> None:
            while self.connection_count < count:
                self._connection_count_changed.clear()
                if self.connection_count < count:
                    await self._connection_count_changed.wait()

        await asyncio.wait_for(wait_until_reached(), timeout)

    @property
    def active_connection_count(self) -> int:
        return len(self._connections)

    async def wait_active_connection_count(
        self, count: int, timeout: float = 1.0
    ) -> None:
        async def wait_until_reached() -> None:
            while self.active_connection_count != count:
                self._connection_count_changed.clear()
                if self.active_connection_count != count:
                    await self._connection_count_changed.wait()

        await asyncio.wait_for(wait_until_reached(), timeout)

    async def send(self, message: dict[str, Any]) -> None:
        await self.wait_connected()
        connection = next(iter(self._connections))
        await connection.send(json.dumps(message))

    async def send_raw(self, message: Any) -> None:
        await self.wait_connected()
        connection = next(iter(self._connections))
        await connection.send(message)

    async def send_server_info(self) -> None:
        await self.send(SERVER_INFO)

    async def close_clients(self, code: int = 1011, reason: str = "test close") -> None:
        connections = list(self._connections)
        await asyncio.gather(
            *(connection.close(code=code, reason=reason) for connection in connections),
            return_exceptions=True,
        )

    async def next_message(
        self, expected_type: Optional[str] = None, timeout: float = 1.0
    ) -> dict[str, Any]:
        message = await asyncio.wait_for(self.received.get(), timeout)
        if expected_type is not None:
            assert message.get("type") == expected_type
        return message

    async def _handle_connection(self, websocket: Any) -> None:
        self._connections.add(websocket)
        self.connection_count += 1
        self._connection_count_changed.set()
        try:
            if self.send_info_on_connect:
                await websocket.send(json.dumps(SERVER_INFO))
            self._connected.set()

            try:
                async for raw_message in websocket:
                    await self.raw_received.put(raw_message)
                    message = json.loads(raw_message)
                    await self.received.put(message)
                    if self.auto_respond:
                        await self._respond(websocket, message)
            except websockets.ConnectionClosed:
                pass
        finally:
            self._connections.discard(websocket)
            self._connection_count_changed.set()
            self._peer_closed.set()

    async def _respond(self, websocket: Any, message: dict[str, Any]) -> None:
        message_type = message.get("type")
        if message_type == "spawn":
            options = message.get("options", {})
            response = {
                "type": "spawned",
                "sessionId": SESSION["sessionId"],
                "shell": options.get("shell", "/bin/sh"),
                "cwd": options.get("cwd", "/work"),
                "cols": options.get("cols", 80),
                "rows": options.get("rows", 24),
                "resumeToken": self.resume_token,
            }
        elif message_type == "listSessions":
            response = {"type": "sessionList", "sessions": self.sessions}
        elif message_type == "join":
            requested_id = message.get("options", {}).get("sessionId")
            session = next(
                (item for item in self.sessions if item["sessionId"] == requested_id),
                None,
            )
            if session is None:
                response = {
                    "type": "error",
                    "sessionId": requested_id,
                    "error": "Session not found",
                }
            elif (
                not session.get("accepting", True)
                and message.get("options", {}).get("resumeToken") != self.resume_token
            ):
                response = {
                    "type": "error",
                    "sessionId": requested_id,
                    "error": "Session is not accepting new clients",
                }
            else:
                response = {
                    "type": "joined",
                    "sessionId": requested_id,
                    "session": session,
                }
                if message.get("options", {}).get("requestHistory", True):
                    response["history"] = self.history
                if message.get("options", {}).get("resumeToken") == self.resume_token:
                    response["resumeToken"] = self.resume_token
        elif message_type == "leave":
            response = {
                "type": "left",
                "sessionId": message.get("sessionId", ""),
            }
        else:
            return

        # Unknown request fields, including requestId, are deliberately not echoed.
        await websocket.send(json.dumps(response))
