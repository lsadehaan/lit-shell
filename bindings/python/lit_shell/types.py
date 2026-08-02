"""
Type definitions for lit-shell Python client.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal, Optional


@dataclass
class ServerInfo:
    """Capabilities advertised by the server during connection setup."""

    local_enabled: bool = True
    docker_enabled: bool = False
    allowed_shells: list[str] = field(default_factory=list)
    default_shell: str = "/bin/bash"
    default_container_shell: str = "/bin/bash"
    request_ids: bool = False


@dataclass
class SessionInfo:
    """Information about a terminal session."""

    session_id: str
    shell: str
    cwd: str
    cols: int
    rows: int
    container: Optional[str] = None
    container_shell: Optional[str] = None
    created_at: Optional[datetime] = None


@dataclass
class SharedSessionInfo:
    """Information about a shared/multiplexed session."""

    session_id: str
    type: Literal["local", "docker-exec", "docker-attach"]
    shell: str
    cwd: str
    cols: int
    rows: int
    client_count: int
    owner: str
    label: Optional[str] = None
    accepting: bool = True
    container: Optional[str] = None
    created_at: Optional[datetime] = None
    history_enabled: bool = True


@dataclass
class TerminalOptions:
    """Options for spawning a terminal session."""

    shell: Optional[str] = None
    cwd: Optional[str] = None
    cols: int = 80
    rows: int = 24
    env: dict[str, str] = field(default_factory=dict)

    # Docker options
    container: Optional[str] = None
    container_shell: Optional[str] = None
    container_user: Optional[str] = None
    container_cwd: Optional[str] = None
    attach_mode: bool = False

    # Multiplexing options
    label: Optional[str] = None
    allow_join: bool = False
    enable_history: bool = True


@dataclass
class JoinOptions:
    """Options for joining an existing session."""

    session_id: str
    request_history: bool = True
    history_limit: int = 50000


@dataclass
class SessionListFilter:
    """Filter options for listing sessions."""

    type: Optional[Literal["local", "docker-exec", "docker-attach"]] = None
    container: Optional[str] = None
    accepting: Optional[bool] = None
