"""Smoke-test the AbletonOSC bridge.

Sends /live/test to 127.0.0.1:11000 and waits up to 500ms for a reply
on 127.0.0.1:11001. Exits 0 on success, 1 on failure.

Run with: uv run python scripts/ping.py
"""

from __future__ import annotations

import sys
import threading

from pythonosc.dispatcher import Dispatcher
from pythonosc.osc_server import ThreadingOSCUDPServer
from pythonosc.udp_client import SimpleUDPClient

LIVE_HOST = "127.0.0.1"
LIVE_RECV_PORT = 11000
LIVE_SEND_PORT = 11001
TIMEOUT_SEC = 0.5


def main() -> int:
    reply_event = threading.Event()
    reply: list[tuple[str, tuple[object, ...]]] = []

    def on_reply(address: str, *args: object) -> None:
        reply.append((address, args))
        reply_event.set()

    dispatcher = Dispatcher()
    dispatcher.set_default_handler(on_reply)

    server = ThreadingOSCUDPServer((LIVE_HOST, LIVE_SEND_PORT), dispatcher)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()

    try:
        client = SimpleUDPClient(LIVE_HOST, LIVE_RECV_PORT)
        client.send_message("/live/test", [])

        if reply_event.wait(timeout=TIMEOUT_SEC):
            address, args = reply[0]
            print(f"OK: reply on {address} with args {args}")
            return 0

        print(
            f"FAIL: no reply within {int(TIMEOUT_SEC * 1000)}ms. "
            "Is Live running with AbletonOSC selected as a Control Surface?",
            file=sys.stderr,
        )
        return 1
    finally:
        server.shutdown()


if __name__ == "__main__":
    sys.exit(main())
