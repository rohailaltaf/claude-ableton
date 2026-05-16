"""Thin OSC client wrapper for talking to AbletonOSC.

Sends commands to 127.0.0.1:11000 and receives replies on 127.0.0.1:11001.
The reply listener runs in a background daemon thread. Reply correlation
is by OSC address: a query sets a handler for the expected reply address,
sends the request, and waits. Concurrent queries to the same address are
not supported (MCP stdio serializes tool calls, so this is fine for MVP).
"""

from __future__ import annotations

import threading
from typing import Any

from pythonosc.dispatcher import Dispatcher
from pythonosc.osc_server import ThreadingOSCUDPServer
from pythonosc.udp_client import SimpleUDPClient

DEFAULT_HOST = "127.0.0.1"
DEFAULT_SEND_PORT = 11000
DEFAULT_RECV_PORT = 11001
DEFAULT_TIMEOUT = 0.5

OscArgs = tuple[Any, ...]


class BridgeUnreachable(RuntimeError):
    """Raised when the AbletonOSC bridge doesn't reply to a ping."""


class QueryTimeout(RuntimeError):
    """Raised when an OSC query doesn't get a reply within the timeout."""


class AbletonClient:
    def __init__(
        self,
        host: str = DEFAULT_HOST,
        send_port: int = DEFAULT_SEND_PORT,
        recv_port: int = DEFAULT_RECV_PORT,
    ) -> None:
        self._dispatcher = Dispatcher()
        self._dispatcher.set_default_handler(self._on_reply)
        self._handlers: dict[str, threading.Event] = {}
        self._replies: dict[str, OscArgs] = {}
        self._lock = threading.Lock()

        self._server = ThreadingOSCUDPServer((host, recv_port), self._dispatcher)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

        self._client = SimpleUDPClient(host, send_port)

    def _on_reply(self, address: str, *args: Any) -> None:
        with self._lock:
            event = self._handlers.get(address)
            if event is not None:
                self._replies[address] = args
                event.set()

    def send(self, address: str, *args: Any) -> None:
        """Fire-and-forget: send a message without waiting for a reply."""
        self._client.send_message(address, list(args))

    def query(
        self, address: str, *args: Any, timeout: float = DEFAULT_TIMEOUT
    ) -> OscArgs:
        """Send a message and wait for a reply on the same address."""
        event = threading.Event()
        with self._lock:
            self._handlers[address] = event
            self._replies.pop(address, None)

        try:
            self._client.send_message(address, list(args))
            if not event.wait(timeout):
                raise QueryTimeout(
                    f"No reply to {address} within {int(timeout * 1000)}ms"
                )
            with self._lock:
                return self._replies.pop(address)
        finally:
            with self._lock:
                self._handlers.pop(address, None)

    def ping_or_raise(self, timeout: float = DEFAULT_TIMEOUT) -> None:
        """Verify the bridge is reachable. Raise BridgeUnreachable if not."""
        try:
            self.query("/live/test", timeout=timeout)
        except QueryTimeout as e:
            raise BridgeUnreachable(
                f"Ableton Live not reachable at the OSC bridge ({e}). "
                "Is Live running with AbletonOSC selected as a Control Surface?"
            ) from e

    def close(self) -> None:
        self._server.shutdown()
