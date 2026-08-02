"""Async client for the public lit-shell WebSocket protocol."""

from __future__ import annotations

import asyncio
import json
import logging
import math
from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Deque, Dict, List, Optional, Set

from websockets.asyncio.client import ClientConnection
from websockets.asyncio.client import connect as websocket_connect
from websockets.exceptions import ConnectionClosed

from .types import ServerInfo, SessionInfo, SharedSessionInfo

logger = logging.getLogger(__name__)


_RESPONSE_TYPES = {
    "spawn": "spawned",
    "listSessions": "sessionList",
    "join": "joined",
}

_MAX_RECONNECT_DELAY = 30.0


class _ConnectAborted(ConnectionError):
    """A connection attempt invalidated by an explicit disconnect."""


class _ServerResponseError(RuntimeError):
    """An error response returned by the terminal server."""


@dataclass(eq=False)
class _PendingRequest:
    """One request waiting for its protocol response."""

    response_type: str
    future: asyncio.Future[Dict[str, Any]]
    request_id: Optional[str] = None
    on_response: Optional[Callable[[Dict[str, Any]], None]] = None


def _parse_datetime(value: Any) -> Optional[datetime]:
    if isinstance(value, datetime):
        return value
    if not isinstance(value, str) or not value:
        return None
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        return datetime.fromisoformat(normalized)
    except ValueError:
        logger.warning("Invalid session timestamp received: %r", value)
        return None


def _validated_seconds(name: str, value: Any, *, allow_zero: bool) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"{name} must be a number")
    try:
        seconds = float(value)
    except OverflowError as error:
        raise ValueError(f"{name} must be finite") from error
    if not math.isfinite(seconds) or seconds < 0 or (seconds == 0 and not allow_zero):
        requirement = "zero or greater" if allow_zero else "greater than zero"
        raise ValueError(f"{name} must be finite and {requirement}")
    return seconds


class TerminalClient:
    """Asynchronous client for a lit-shell terminal server.

    The wire protocol correlates normal responses by message type. Requests of
    the same type are therefore completed in FIFO order. A server may advertise
    the optional ``requestIds`` extension in ``serverInfo``; when it does, the
    client adds and honors request IDs as an additional correlation mechanism.
    """

    def __init__(
        self,
        url: str,
        reconnect: bool = True,
        max_reconnect_attempts: int = 10,
        reconnect_delay: float = 1.0,
        *,
        connect_timeout: float = 10.0,
        request_timeout: float = 30.0,
    ):
        if not isinstance(reconnect, bool):
            raise TypeError("reconnect must be a bool")
        if isinstance(max_reconnect_attempts, bool) or not isinstance(
            max_reconnect_attempts, int
        ):
            raise TypeError("max_reconnect_attempts must be an int")
        if max_reconnect_attempts < 0:
            raise ValueError("max_reconnect_attempts must be zero or greater")
        reconnect_seconds = _validated_seconds(
            "reconnect_delay", reconnect_delay, allow_zero=True
        )
        connect_seconds = _validated_seconds(
            "connect_timeout", connect_timeout, allow_zero=False
        )
        request_seconds = _validated_seconds(
            "request_timeout", request_timeout, allow_zero=False
        )

        self.url = url
        self.reconnect = reconnect
        self.max_reconnect_attempts = max_reconnect_attempts
        self.reconnect_delay = reconnect_seconds
        self.connect_timeout = connect_seconds
        self.request_timeout = request_seconds

        self._ws: Optional[ClientConnection] = None
        self._connected = False
        self._session_id: Optional[str] = None
        self._session_info: Optional[SessionInfo] = None
        self._server_info: Optional[ServerInfo] = None
        self._receive_task: Optional[asyncio.Task[Any]] = None
        self._reconnect_task: Optional[asyncio.Task[None]] = None
        self._connect_attempt_task: Optional[asyncio.Task[ServerInfo]] = None
        self._connect_lock = asyncio.Lock()
        self._disconnect_notified = True
        self._connection_announced = False
        self._disconnect_requested = False
        self._lifecycle_generation = 0
        self._recovering_session = False

        self._resume_token: Optional[str] = None
        self._session_recovery_pending = False
        self._session_establishing = False
        self._rejoin_request_history = True
        self._rejoin_history_limit = 50000

        self._pending_by_type: Dict[str, Deque[_PendingRequest]] = defaultdict(deque)
        self._pending_by_id: Dict[str, _PendingRequest] = {}
        self._pending_order: Deque[_PendingRequest] = deque()
        self._request_id = 0
        self._supports_request_ids = False
        self._background_tasks: Set[asyncio.Task[Any]] = set()

        self._on_connect: List[Callable[[], None]] = []
        self._on_disconnect: List[Callable[[], None]] = []
        self._on_data: List[Callable[[str], None]] = []
        self._on_exit: List[Callable[[int], None]] = []
        self._on_error: List[Callable[[Exception], None]] = []
        self._on_spawned: List[Callable[[SessionInfo], None]] = []
        self._on_server_info: List[Callable[[ServerInfo], None]] = []
        self._on_client_joined: List[Callable[[str, int], None]] = []
        self._on_client_left: List[Callable[[str, int], None]] = []
        self._on_session_closed: List[Callable[[str, str], None]] = []

    async def __aenter__(self) -> "TerminalClient":
        await self.connect()
        return self

    async def __aexit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        await self.disconnect()

    # Connection management

    async def connect(self) -> ServerInfo:
        """Connect, validate the ``serverInfo`` handshake, and return it."""
        try:
            self._disconnect_requested = False
            reconnect_task = self._reconnect_task
            if (
                reconnect_task is not None
                and reconnect_task is not asyncio.current_task()
            ):
                reconnect_task.cancel()
                await asyncio.gather(reconnect_task, return_exceptions=True)
                if self._reconnect_task is reconnect_task:
                    self._reconnect_task = None

            generation = self._lifecycle_generation
            async with self._connect_lock:
                return await self._connect_locked(generation)
        except asyncio.CancelledError:
            await self._abandon_unannounced_connection()
            raise

    async def _connect_locked(self, generation: int) -> ServerInfo:
        if self._transport_open() and self._server_info is not None:
            if not self._connection_announced:
                await self._complete_connection(generation)
            return self._server_info

        connect_attempt = asyncio.create_task(
            self._connect_once(generation), name="lit-shell-connect"
        )
        self._connect_attempt_task = connect_attempt
        try:
            server_info = await connect_attempt
        finally:
            if self._connect_attempt_task is connect_attempt:
                self._connect_attempt_task = None

        if self._connection_attempt_is_stale(generation):
            raise _ConnectAborted("Connection attempt cancelled by disconnect")

        await self._complete_connection(generation)
        return server_info

    async def _complete_connection(self, generation: int) -> None:
        if self._session_recovery_pending:
            self._recovering_session = True
            try:
                await self._recover_active_session()
            finally:
                self._recovering_session = False

        if self._connection_attempt_is_stale(generation) or not self._transport_open():
            raise _ConnectAborted("Connection attempt cancelled by disconnect")

        self._connection_announced = True
        self._disconnect_notified = False
        self._notify_handlers(self._on_connect, "connect")
        logger.info("Connected to %s", self.url)

    async def _connect_once(self, generation: int) -> ServerInfo:
        websocket: Optional[ClientConnection] = None
        try:
            if self._connection_attempt_is_stale(generation):
                raise _ConnectAborted("Connection attempt cancelled by disconnect")

            websocket = await websocket_connect(
                self.url,
                open_timeout=self.connect_timeout,
            )
            raw_message = await asyncio.wait_for(
                websocket.recv(), timeout=self.connect_timeout
            )
            message = self._decode_message(raw_message)
            if message.get("type") != "serverInfo":
                actual = message.get("type")
                raise RuntimeError(
                    f"Expected serverInfo handshake, got: {actual or 'unknown'}"
                )

            if self._connection_attempt_is_stale(generation):
                raise _ConnectAborted("Connection attempt cancelled by disconnect")

            self._set_server_info(message.get("info", {}))
            self._ws = websocket
            self._connection_announced = False
            self._recovering_session = self._session_recovery_pending
            self._connected = True
            self._receive_task = asyncio.create_task(
                self._receive_loop(websocket), name="lit-shell-receive"
            )
            assert self._server_info is not None
            return self._server_info
        except asyncio.CancelledError:
            if websocket is not None:
                try:
                    await websocket.close()
                except Exception:
                    logger.debug("Error closing cancelled connection", exc_info=True)
            raise
        except Exception as error:
            if websocket is not None:
                try:
                    await websocket.close()
                except Exception:
                    logger.debug("Error closing failed connection", exc_info=True)
            if not isinstance(error, _ConnectAborted):
                self._notify_handlers(self._on_error, "connect error", error)
                logger.error("Failed to connect to %s: %s", self.url, error)
            raise

    async def disconnect(self) -> None:
        """Close the socket and deterministically reject outstanding work."""
        self._disconnect_requested = True
        self._lifecycle_generation += 1

        websocket = self._ws
        receive_task = self._receive_task
        reconnect_task = self._reconnect_task
        connect_attempt = self._connect_attempt_task
        was_connected = self._connected or websocket is not None

        self._connected = False
        self._connection_announced = False
        self._recovering_session = False
        self._ws = None
        self._receive_task = None
        self._reconnect_task = None
        self._connect_attempt_task = None
        self._fail_pending(ConnectionError("Disconnected from terminal server"))
        self._clear_session()
        self._server_info = None
        self._supports_request_ids = False
        if was_connected:
            self._notify_disconnect_once()

        background_tasks = list(self._background_tasks)
        self._background_tasks.clear()
        for task in background_tasks:
            task.cancel()

        current_task = asyncio.current_task()
        lifecycle_tasks = [
            task
            for task in (receive_task, reconnect_task, connect_attempt)
            if task is not None and task is not current_task
        ]
        tasks_to_wait = list(dict.fromkeys(lifecycle_tasks + background_tasks))
        for task in tasks_to_wait:
            task.cancel()

        cleanup_task = asyncio.create_task(
            self._close_connection_resources(tasks_to_wait, websocket),
            name="lit-shell-disconnect-cleanup",
        )
        try:
            await asyncio.shield(cleanup_task)
        except asyncio.CancelledError:
            await asyncio.shield(cleanup_task)
            raise
        logger.info("Disconnected from %s", self.url)

    def is_connected(self) -> bool:
        return (
            self._transport_open()
            and self._connection_announced
            and not self._recovering_session
        )

    def has_active_session(self) -> bool:
        return self._session_id is not None

    def get_session_id(self) -> Optional[str]:
        return self._session_id

    def get_session_info(self) -> Optional[SessionInfo]:
        return self._session_info

    def get_server_info(self) -> Optional[ServerInfo]:
        return self._server_info

    # Session management

    async def spawn(
        self,
        shell: Optional[str] = None,
        cwd: Optional[str] = None,
        cols: int = 80,
        rows: int = 24,
        env: Optional[Dict[str, str]] = None,
        container: Optional[str] = None,
        container_shell: Optional[str] = None,
        container_user: Optional[str] = None,
        container_cwd: Optional[str] = None,
        attach_mode: bool = False,
        label: Optional[str] = None,
        allow_join: bool = False,
        enable_history: bool = True,
    ) -> SessionInfo:
        self._require_connected()
        self._require_session_available()
        self._validate_spawn_target(
            shell=shell,
            cwd=cwd,
            env=env,
            container=container,
            container_shell=container_shell,
            container_user=container_user,
            container_cwd=container_cwd,
            attach_mode=attach_mode,
        )
        options: Dict[str, Any] = {"cols": cols, "rows": rows}
        optional_values = {
            "shell": shell,
            "cwd": cwd,
            "env": env,
            "container": container,
            "containerShell": container_shell,
            "containerUser": container_user,
            "containerCwd": container_cwd,
            "label": label,
        }
        options.update(
            {key: value for key, value in optional_values.items() if value is not None}
        )
        if attach_mode:
            options["attachMode"] = True
        options["allowJoin"] = allow_join
        if not enable_history:
            options["enableHistory"] = False

        spawned_session: Optional[SessionInfo] = None

        def apply_spawned(response: Dict[str, Any]) -> None:
            nonlocal spawned_session
            session = SessionInfo(
                session_id=str(response.get("sessionId", "")),
                shell=str(response.get("shell", "")),
                cwd=str(response.get("cwd", "")),
                cols=int(response.get("cols", cols)),
                rows=int(response.get("rows", rows)),
                container=response.get("container"),
                container_shell=response.get("containerShell"),
                created_at=_parse_datetime(response.get("createdAt")),
            )
            if not session.session_id:
                raise RuntimeError("Spawn response did not include a sessionId")

            self._session_id = session.session_id
            self._session_info = session
            self._resume_token = self._response_resume_token(response)
            self._session_recovery_pending = False
            self._rejoin_request_history = enable_history
            self._rejoin_history_limit = 50000
            spawned_session = session
            self._notify_handlers(self._on_spawned, "spawned", session)

        self._session_establishing = True
        try:
            await self._send_request(
                "spawn", {"options": options}, on_response=apply_spawned
            )
        finally:
            self._session_establishing = False
        if spawned_session is None:
            raise RuntimeError("Spawn response was not applied")
        return spawned_session

    async def kill(self) -> None:
        self._require_connected()
        session_id = self._require_session()
        self._clear_session()
        await self._send_message({"type": "close", "sessionId": session_id})

    # Multiplexing

    async def list_sessions(
        self,
        type: Optional[str] = None,
        container: Optional[str] = None,
        accepting: Optional[bool] = None,
    ) -> List[SharedSessionInfo]:
        self._require_connected()
        filters: Dict[str, Any] = {}
        if type is not None:
            filters["type"] = type
        if container is not None:
            filters["container"] = container
        if accepting is not None:
            filters["accepting"] = accepting

        payload = {"filter": filters} if filters else {}
        response = await self._send_request("listSessions", payload)
        return [self._shared_session(item) for item in response.get("sessions", [])]

    async def join(
        self,
        session_id: str,
        request_history: bool = True,
        history_limit: int = 50000,
        resume_token: Optional[str] = None,
    ) -> SharedSessionInfo:
        self._require_connected()
        self._require_session_available()
        self._session_establishing = True
        try:
            return await self._join_session(
                session_id,
                request_history=request_history,
                history_limit=history_limit,
                resume_token=resume_token,
                recovering=False,
            )
        finally:
            self._session_establishing = False

    async def _join_session(
        self,
        session_id: str,
        *,
        request_history: bool,
        history_limit: int,
        resume_token: Optional[str],
        recovering: bool,
    ) -> SharedSessionInfo:
        if resume_token is not None and (
            not isinstance(resume_token, str) or not resume_token
        ):
            raise ValueError("resume_token must be a non-empty string")

        options: Dict[str, Any] = {
            "sessionId": session_id,
            "requestHistory": request_history,
            "historyLimit": history_limit,
        }
        if resume_token is not None:
            options["resumeToken"] = resume_token

        joined_session: Optional[SharedSessionInfo] = None

        def apply_joined(response: Dict[str, Any]) -> None:
            nonlocal joined_session
            joined_id = str(response.get("sessionId") or session_id)
            session = self._shared_session(
                response.get("session", {}), default_session_id=joined_id
            )
            self._session_id = joined_id
            self._session_info = SessionInfo(
                session_id=session.session_id,
                shell=session.shell,
                cwd=session.cwd,
                cols=session.cols,
                rows=session.rows,
                container=session.container,
                created_at=session.created_at,
            )
            self._resume_token = self._response_resume_token(response)
            self._session_recovery_pending = False
            self._rejoin_request_history = request_history
            self._rejoin_history_limit = history_limit
            joined_session = session

            history = response.get("history")
            if isinstance(history, str):
                self._notify_handlers(self._on_data, "history", history)

        await self._send_request(
            "join",
            {"options": options},
            on_response=apply_joined,
            allow_recovering=recovering,
        )
        if joined_session is None:
            raise RuntimeError("Join response was not applied")
        return joined_session

    async def _recover_active_session(self) -> None:
        session_id = self._session_id
        if session_id is None:
            self._session_recovery_pending = False
            return

        try:
            await self._join_session(
                session_id,
                request_history=self._rejoin_request_history,
                history_limit=self._rejoin_history_limit,
                resume_token=self._resume_token,
                recovering=True,
            )
        except asyncio.CancelledError:
            raise
        except Exception as error:
            if isinstance(error, _ServerResponseError):
                self._clear_session()
                logger.warning("Failed to recover session %s: %s", session_id, error)
                return

            if self._transport_open():
                self._notify_handlers(self._on_error, "session recovery", error)
                await self._abandon_unannounced_connection()
            if self._session_id is not None:
                self._session_recovery_pending = True
            logger.warning("Session recovery interrupted for %s: %s", session_id, error)
            raise

    def leave(self, session_id: Optional[str] = None) -> None:
        self._require_connected()
        target_session = session_id or self._require_session()
        task = asyncio.create_task(
            self._send_message({"type": "leave", "sessionId": target_session}),
            name="lit-shell-leave",
        )
        self._track_background_task(task)
        if target_session == self._session_id:
            self._clear_session()

    # Terminal I/O

    async def write(self, data: str) -> None:
        self._require_connected()
        session_id = self._require_session()
        await self._send_message(
            {"type": "data", "sessionId": session_id, "data": data}
        )

    async def resize(self, cols: int, rows: int) -> None:
        self._require_connected()
        session_id = self._require_session()
        await self._send_message(
            {
                "type": "resize",
                "sessionId": session_id,
                "cols": cols,
                "rows": rows,
            }
        )

    # Event registration

    def on_connect(self, handler: Callable[[], None]) -> None:
        self._on_connect.append(handler)

    def on_disconnect(self, handler: Callable[[], None]) -> None:
        self._on_disconnect.append(handler)

    def on_data(self, handler: Callable[[str], None]) -> None:
        self._on_data.append(handler)

    def on_exit(self, handler: Callable[[int], None]) -> None:
        self._on_exit.append(handler)

    def on_error(self, handler: Callable[[Exception], None]) -> None:
        self._on_error.append(handler)

    def on_spawned(self, handler: Callable[[SessionInfo], None]) -> None:
        self._on_spawned.append(handler)

    def on_server_info(self, handler: Callable[[ServerInfo], None]) -> None:
        self._on_server_info.append(handler)

    def on_client_joined(self, handler: Callable[[str, int], None]) -> None:
        self._on_client_joined.append(handler)

    def on_client_left(self, handler: Callable[[str, int], None]) -> None:
        self._on_client_left.append(handler)

    def on_session_closed(self, handler: Callable[[str, str], None]) -> None:
        self._on_session_closed.append(handler)

    # Protocol internals

    async def _send_message(self, message: Dict[str, Any]) -> None:
        websocket = self._ws
        if not self._connected or websocket is None:
            raise RuntimeError("Not connected to server")
        try:
            await websocket.send(json.dumps(message))
        except ConnectionClosed as error:
            connection_error = ConnectionError("Terminal server connection closed")
            await self._handle_remote_disconnect(websocket, connection_error)
            raise connection_error from error

    async def _send_request(
        self,
        request_type: str,
        data: Optional[Dict[str, Any]] = None,
        *,
        on_response: Optional[Callable[[Dict[str, Any]], None]] = None,
        allow_recovering: bool = False,
    ) -> Dict[str, Any]:
        if allow_recovering:
            if not self._transport_open():
                raise RuntimeError("Not connected to server")
        else:
            self._require_connected()
        response_type = _RESPONSE_TYPES[request_type]
        message: Dict[str, Any] = {"type": request_type}
        if data:
            message.update(data)

        request_id: Optional[str] = None
        if self._supports_request_ids:
            self._request_id += 1
            request_id = f"req-{self._request_id}"
            message["requestId"] = request_id

        loop = asyncio.get_running_loop()
        pending = _PendingRequest(
            response_type=response_type,
            future=loop.create_future(),
            request_id=request_id,
            on_response=on_response,
        )
        self._add_pending(pending)
        try:
            try:
                await self._send_message(message)
            except BaseException:
                if not pending.future.done():
                    pending.future.cancel()
                elif not pending.future.cancelled():
                    pending.future.exception()
                raise
            try:
                result = await asyncio.wait_for(
                    pending.future, timeout=self.request_timeout
                )
            except asyncio.TimeoutError as error:
                raise asyncio.TimeoutError(
                    f"Timed out waiting for {response_type} response"
                ) from error
            return result
        finally:
            self._remove_pending(pending)

    async def _receive_loop(self, websocket: ClientConnection) -> None:
        connection_error: Optional[ConnectionError] = None
        try:
            async for raw_message in websocket:
                try:
                    message = self._decode_message(raw_message)
                    self._handle_message(message)
                except json.JSONDecodeError:
                    logger.warning("Invalid JSON received from terminal server")
                except Exception as error:
                    logger.error("Error handling terminal message: %s", error)
        except asyncio.CancelledError:
            raise
        except ConnectionClosed:
            close_code = websocket.close_code
            connection_error = ConnectionError(
                f"Terminal server connection closed ({close_code})"
            )
        except Exception as error:
            connection_error = ConnectionError(
                f"Terminal server receive loop failed: {error}"
            )
            logger.error("Receive loop failed: %s", error)
        finally:
            if self._connected and self._ws is websocket:
                await self._handle_remote_disconnect(
                    websocket,
                    connection_error
                    or ConnectionError("Terminal server connection closed"),
                )

    @staticmethod
    def _validate_spawn_target(
        *,
        shell: Optional[str],
        cwd: Optional[str],
        env: Optional[Dict[str, str]],
        container: Optional[str],
        container_shell: Optional[str],
        container_user: Optional[str],
        container_cwd: Optional[str],
        attach_mode: bool,
    ) -> None:
        container_options = (container_shell, container_user, container_cwd)
        if container is None:
            if attach_mode:
                raise ValueError("attach_mode requires container")
            if any(value is not None for value in container_options):
                raise ValueError("container-specific options require container")
            return

        if shell is not None or cwd is not None:
            raise ValueError(
                "Docker sessions use container_shell/container_cwd, not shell/cwd"
            )

        if attach_mode and (
            env is not None or any(value is not None for value in container_options)
        ):
            raise ValueError(
                "Docker attach does not accept exec-only environment, shell, user, "
                "or working-directory options"
            )

    @staticmethod
    def _decode_message(raw_message: Any) -> Dict[str, Any]:
        message = json.loads(raw_message)
        if not isinstance(message, dict):
            raise RuntimeError("Terminal protocol messages must be JSON objects")
        return message

    def _handle_message(self, data: Dict[str, Any]) -> None:
        message_type = data.get("type")

        if message_type == "serverInfo":
            self._set_server_info(data.get("info", {}))
            return

        if message_type == "error":
            error = _ServerResponseError(
                str(data.get("error") or data.get("message") or "Unknown error")
            )
            self._reject_pending(data, error)
            self._notify_handlers(self._on_error, "error", error)
            return

        if isinstance(message_type, str) and self._resolve_pending(message_type, data):
            return

        if message_type == "data":
            if not self._targets_active_session(data):
                return
            self._notify_handlers(self._on_data, "data", str(data.get("data", "")))
        elif message_type == "exit":
            if not self._targets_active_session(data):
                return
            self._clear_session()
            exit_code = int(data.get("exitCode", data.get("code", 0)))
            self._notify_handlers(self._on_exit, "exit", exit_code)
        elif message_type == "clientJoined":
            self._notify_handlers(
                self._on_client_joined,
                "clientJoined",
                str(data.get("sessionId", "")),
                int(data.get("clientCount", 0)),
            )
        elif message_type == "clientLeft":
            self._notify_handlers(
                self._on_client_left,
                "clientLeft",
                str(data.get("sessionId", "")),
                int(data.get("clientCount", 0)),
            )
        elif message_type == "sessionClosed":
            session_id = str(data.get("sessionId", ""))
            reason = str(data.get("reason", "unknown"))
            if session_id == self._session_id:
                self._clear_session()
            self._notify_handlers(
                self._on_session_closed, "sessionClosed", session_id, reason
            )
        elif message_type == "left":
            session_id = str(data.get("sessionId", ""))
            if session_id == self._session_id:
                self._clear_session()
        else:
            logger.debug("Ignoring unknown terminal message type: %r", message_type)

    def _targets_active_session(self, data: Dict[str, Any]) -> bool:
        session_id = data.get("sessionId")
        return (
            self._session_id is not None
            and isinstance(session_id, str)
            and session_id == self._session_id
        )

    def _set_server_info(self, raw_info: Any) -> None:
        if not isinstance(raw_info, dict):
            raise RuntimeError("serverInfo.info must be an object")
        info = ServerInfo(
            local_enabled=bool(raw_info.get("localEnabled", True)),
            docker_enabled=bool(raw_info.get("dockerEnabled", False)),
            allowed_shells=list(raw_info.get("allowedShells") or []),
            default_shell=str(raw_info.get("defaultShell") or "/bin/bash"),
            default_container_shell=str(
                raw_info.get("defaultContainerShell") or "/bin/bash"
            ),
            request_ids=bool(
                raw_info.get("requestIds") or raw_info.get("supportsRequestIds")
            ),
        )
        self._server_info = info
        self._supports_request_ids = info.request_ids
        self._notify_handlers(self._on_server_info, "serverInfo", info)

    def _shared_session(
        self, raw_session: Any, default_session_id: str = ""
    ) -> SharedSessionInfo:
        if not isinstance(raw_session, dict):
            raise RuntimeError("Session payload must be an object")
        return SharedSessionInfo(
            session_id=str(raw_session.get("sessionId") or default_session_id),
            type=raw_session.get("type", "local"),
            shell=str(raw_session.get("shell", "")),
            cwd=str(raw_session.get("cwd", "")),
            cols=int(raw_session.get("cols", 80)),
            rows=int(raw_session.get("rows", 24)),
            client_count=int(raw_session.get("clientCount", 1)),
            owner=str(raw_session.get("ownerId") or raw_session.get("owner") or ""),
            label=raw_session.get("label"),
            accepting=bool(raw_session.get("accepting", True)),
            container=raw_session.get("container"),
            created_at=_parse_datetime(raw_session.get("createdAt")),
            history_enabled=bool(raw_session.get("historyEnabled", True)),
        )

    def _add_pending(self, pending: _PendingRequest) -> None:
        self._pending_by_type[pending.response_type].append(pending)
        self._pending_order.append(pending)
        if pending.request_id is not None:
            self._pending_by_id[pending.request_id] = pending

    def _remove_pending(self, pending: _PendingRequest) -> None:
        queue = self._pending_by_type.get(pending.response_type)
        if queue is not None:
            try:
                queue.remove(pending)
            except ValueError:
                pass
            if not queue:
                self._pending_by_type.pop(pending.response_type, None)
        try:
            self._pending_order.remove(pending)
        except ValueError:
            pass
        if pending.request_id is not None:
            self._pending_by_id.pop(pending.request_id, None)

    def _pending_for_message(
        self, message_type: str, data: Dict[str, Any]
    ) -> Optional[_PendingRequest]:
        request_id = data.get("requestId")
        if isinstance(request_id, str):
            pending = self._pending_by_id.get(request_id)
            if pending is not None and pending.response_type == message_type:
                return pending
        queue = self._pending_by_type.get(message_type)
        if queue:
            return queue[0]
        return None

    def _resolve_pending(self, message_type: str, data: Dict[str, Any]) -> bool:
        pending = self._pending_for_message(message_type, data)
        if pending is None:
            return False
        self._remove_pending(pending)
        if not pending.future.done():
            try:
                if pending.on_response is not None:
                    pending.on_response(data)
            except Exception as error:
                pending.future.set_exception(error)
            else:
                pending.future.set_result(data)
        return True

    def _reject_pending(self, data: Dict[str, Any], error: Exception) -> bool:
        request_id = data.get("requestId")
        pending: Optional[_PendingRequest] = None
        if isinstance(request_id, str):
            pending = self._pending_by_id.get(request_id)
        if pending is None:
            pending = next(
                (item for item in self._pending_order if not item.future.done()), None
            )
        if pending is None:
            return False
        self._remove_pending(pending)
        if not pending.future.done():
            pending.future.set_exception(error)
        return True

    def _fail_pending(self, error: Exception) -> None:
        pending_requests = list(self._pending_order)
        self._pending_by_type.clear()
        self._pending_by_id.clear()
        self._pending_order.clear()
        for pending in pending_requests:
            if not pending.future.done():
                pending.future.set_exception(error)

    async def _handle_remote_disconnect(
        self, websocket: ClientConnection, error: ConnectionError
    ) -> None:
        if self._ws is not websocket:
            return

        receive_task = self._receive_task
        self._connected = False
        self._connection_announced = False
        self._recovering_session = False
        self._ws = None
        self._receive_task = None
        self._fail_pending(error)
        self._session_recovery_pending = self._session_id is not None
        self._server_info = None
        self._supports_request_ids = False
        self._notify_disconnect_once()

        if receive_task is not None and receive_task is not asyncio.current_task():
            receive_task.cancel()
            await asyncio.gather(receive_task, return_exceptions=True)

        try:
            await websocket.close()
        except ConnectionClosed:
            pass
        except Exception:
            logger.debug("Error closing lost terminal connection", exc_info=True)

        self._schedule_reconnect()

    def _schedule_reconnect(self) -> None:
        reconnect_task = self._reconnect_task
        if (
            not self.reconnect
            or self.max_reconnect_attempts == 0
            or self._disconnect_requested
            or self.is_connected()
            or (reconnect_task is not None and not reconnect_task.done())
        ):
            return

        task = asyncio.create_task(
            self._reconnect_loop(self._lifecycle_generation),
            name="lit-shell-reconnect",
        )
        self._reconnect_task = task

        def completed(completed_task: asyncio.Task[None]) -> None:
            if self._reconnect_task is completed_task:
                self._reconnect_task = None
            if completed_task.cancelled():
                return
            task_error = completed_task.exception()
            if task_error is not None:
                self._notify_handlers(self._on_error, "reconnect loop", task_error)

        task.add_done_callback(completed)

    async def _reconnect_loop(self, generation: int) -> None:
        for attempt in range(self.max_reconnect_attempts):
            await asyncio.sleep(self._reconnect_delay_for_attempt(attempt))
            if self._connection_attempt_is_stale(generation):
                return

            try:
                async with self._connect_lock:
                    if self.is_connected():
                        return
                    await self._connect_locked(generation)
                return
            except asyncio.CancelledError:
                raise
            except _ConnectAborted:
                return
            except Exception:
                if self._connection_attempt_is_stale(generation):
                    return

        logger.warning(
            "Failed to reconnect to %s after %d attempts",
            self.url,
            self.max_reconnect_attempts,
        )

    def _reconnect_delay_for_attempt(self, attempt: int) -> float:
        if self.reconnect_delay == 0:
            return 0.0
        try:
            delay = math.ldexp(self.reconnect_delay, attempt)
        except OverflowError:
            return _MAX_RECONNECT_DELAY
        return min(delay, _MAX_RECONNECT_DELAY)

    def _connection_attempt_is_stale(self, generation: int) -> bool:
        return self._disconnect_requested or generation != self._lifecycle_generation

    def _transport_open(self) -> bool:
        return self._connected and self._ws is not None

    @staticmethod
    def _response_resume_token(response: Dict[str, Any]) -> Optional[str]:
        resume_token = response.get("resumeToken")
        if isinstance(resume_token, str) and resume_token:
            return resume_token
        return None

    async def _close_connection_resources(
        self,
        tasks: List[asyncio.Task[Any]],
        websocket: Optional[ClientConnection],
    ) -> None:
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        if websocket is not None:
            try:
                await websocket.close()
            except ConnectionClosed:
                pass
            except Exception:
                logger.debug("Error closing terminal connection", exc_info=True)

    async def _abandon_unannounced_connection(self) -> None:
        if self._connection_announced or not self._transport_open():
            return

        websocket = self._ws
        receive_task = self._receive_task
        self._connected = False
        self._recovering_session = False
        self._ws = None
        self._receive_task = None
        self._server_info = None
        self._supports_request_ids = False
        self._session_recovery_pending = self._session_id is not None
        self._fail_pending(ConnectionError("Connection attempt abandoned"))

        tasks: List[asyncio.Task[Any]] = []
        if receive_task is not None and receive_task is not asyncio.current_task():
            receive_task.cancel()
            tasks.append(receive_task)
        cleanup_task = asyncio.create_task(
            self._close_connection_resources(tasks, websocket),
            name="lit-shell-connect-cleanup",
        )
        await asyncio.shield(cleanup_task)

    def _notify_disconnect_once(self) -> None:
        if self._disconnect_notified:
            return
        self._disconnect_notified = True
        self._notify_handlers(self._on_disconnect, "disconnect")

    def _track_background_task(self, task: asyncio.Task[Any]) -> None:
        self._background_tasks.add(task)

        def completed(completed_task: asyncio.Task[Any]) -> None:
            self._background_tasks.discard(completed_task)
            if completed_task.cancelled():
                return
            error = completed_task.exception()
            if error is not None:
                self._notify_handlers(self._on_error, "background operation", error)

        task.add_done_callback(completed)

    @staticmethod
    def _notify_handlers(
        handlers: List[Callable[..., None]], label: str, *args: Any
    ) -> None:
        for handler in list(handlers):
            try:
                handler(*args)
            except Exception:
                logger.exception("Error in %s handler", label)

    def _require_connected(self) -> None:
        if not self.is_connected():
            raise RuntimeError("Not connected to server")

    def _require_session(self) -> str:
        if self._session_id is None:
            raise RuntimeError("No active session")
        return self._session_id

    def _require_session_available(self) -> None:
        if self._session_id is not None or self._session_establishing:
            raise RuntimeError("Session already active; call kill() or leave() first")

    def _clear_session(self) -> None:
        self._session_id = None
        self._session_info = None
        self._resume_token = None
        self._session_recovery_pending = False
        self._rejoin_request_history = True
        self._rejoin_history_limit = 50000
