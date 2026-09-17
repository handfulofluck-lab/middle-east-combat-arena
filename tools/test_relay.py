# Protocol-level tests for tools/mca_relay.py: rooms, relay, host-forward
# stamping, targeted delivery, drop notices, ping/pong, host-leave closing.
# Starts a real relay on an ephemeral localhost port, drives it with in-memory
# websocket clients from a dedicated asyncio loop running in a thread.
# Usage: .venv/Scripts/python test_relay.py
import asyncio
import json
import sys
import threading
import time
from pathlib import Path

import websockets

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mca_relay

RESULTS = []


def check(name, cond, detail=""):
    RESULTS.append((name, bool(cond), str(detail)))
    print(f"{'PASS' if cond else 'FAIL'}  {name}  --  {detail}")


class Client:
    """One websocket client on the test loop."""

    def __init__(self, name):
        self.name = name
        self.ws = None
        self.inbox = []

    async def connect(self, port):
        self.ws = await websockets.connect(f"ws://127.0.0.1:{port}")
        asyncio.create_task(self._pump())

    async def _pump(self):
        try:
            async for raw in self.ws:
                self.inbox.append(json.loads(raw))
        except websockets.ConnectionClosed:
            pass

    async def send(self, msg):
        await self.ws.send(json.dumps(msg))

    def drain(self):
        out, self.inbox = self.inbox, []
        return out

    def find(self, t, **kw):
        for m in self.inbox:
            if m.get("t") != t:
                continue
            if all(m.get(k) == v for k, v in kw.items()):
                return m
        return None

    async def close(self):
        try:
            await self.ws.close()
        except Exception:
            pass


def run_async_tests(coro):
    """Run the async test body on a fresh loop in a thread; return its results."""
    err = []

    def worker():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(coro())
        except Exception as e:  # surfaced as a failed check
            err.append(f"{type(e).__name__}: {e}")
        finally:
            loop.close()

    th = threading.Thread(target=worker, daemon=True)
    th.start()
    th.join(60)
    if th.is_alive():
        err.append("async test body timed out")
    return err


async def body():
    relay = mca_relay.Relay()
    # ephemeral port on localhost
    server = await websockets.serve(relay.handle, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]

    a, b, c = Client("host"), Client("joiner"), Client("third")
    await a.connect(port)
    await a.send({"t": "create", "name": "host"})
    for _ in range(100):
        if a.find("room"):
            break
        await asyncio.sleep(0.01)
    ra = a.find("room")
    check("create-room", ra and ra["code"] and ra["slot"] == 0 and ra["host"] is True,
          json.dumps(ra))
    code = ra["code"] if ra else "????"
    a.drain()

    # join with a wrong code -> error, connection stays usable
    await b.connect(port)
    await b.send({"t": "join", "code": "ZZZZ", "name": "joiner"})
    for _ in range(100):
        if b.find("error"):
            break
        await asyncio.sleep(0.01)
    check("join-bad-code", bool(b.find("error", reason="no-such-room")), json.dumps(b.inbox))

    # proper join -> room msg (not host), both sides see lobby membership
    await b.send({"t": "join", "code": code, "name": "joiner"})
    for _ in range(100):
        if b.find("room") and a.find("lobby"):
            break
        await asyncio.sleep(0.01)
    rb = b.find("room")
    lob_a = a.find("lobby")
    check("join-room-slot1", bool(rb) and rb["slot"] == 1 and rb["host"] is False,
          json.dumps(rb))
    check("lobby-membership-broadcast",
          bool(lob_a) and [s["slot"] for s in lob_a["slots"]] == [0, 1]
          and lob_a["slots"][0]["name"] == "host" and lob_a["slots"][1]["name"] == "joiner",
          json.dumps(lob_a))
    a.drain(); b.drain()

    # relayed message: `from` stamped by the relay (host-forwarded marker),
    # client-supplied `from` overwritten (anti-spoof)
    await b.send({"t": "chat", "msg": "hello", "from": 99})
    for _ in range(100):
        if a.find("chat"):
            break
        await asyncio.sleep(0.01)
    chat = a.find("chat")
    check("relay-stamps-from", bool(chat) and chat["from"] == 1 and chat["msg"] == "hello",
          json.dumps(chat))
    check("no-echo-to-sender", b.find("chat") is None, "")
    a.drain()

    # targeted delivery: `to` reaches only that slot
    await c.connect(port)
    await c.send({"t": "join", "code": code, "name": "third"})
    for _ in range(100):
        if c.find("room"):
            break
        await asyncio.sleep(0.01)
    rc = c.find("room")
    check("third-joins-slot2", bool(rc) and rc["slot"] == 2, json.dumps(rc))
    a.drain(); b.drain(); c.drain()
    await a.send({"t": "chat", "msg": "secret", "to": 2})
    for _ in range(100):
        if c.find("chat"):
            break
        await asyncio.sleep(0.01)
    check("to-targeted-delivery",
          bool(c.find("chat", msg="secret")) and not b.find("chat") and not a.find("chat"),
          f"c={c.inbox} b={b.inbox}")
    a.drain(); b.drain(); c.drain()

    # ping/pong through the relay
    await b.send({"t": "ping", "ts": 1234})
    for _ in range(100):
        if b.find("pong"):
            break
        await asyncio.sleep(0.01)
    check("ping-pong", bool(b.find("pong", ts=1234)), json.dumps(b.inbox))
    b.drain()

    # drop notice: third client disconnects -> host + joiner get {t:'bye', slot:2}
    await c.close()
    for _ in range(200):
        if a.find("bye", slot=2) and b.find("bye", slot=2):
            break
        await asyncio.sleep(0.01)
    check("drop-notice-broadcast",
          bool(a.find("bye", slot=2)) and bool(b.find("bye", slot=2)),
          f"a={a.inbox} b={b.inbox}")
    # membership update after the drop
    lob2 = a.find("lobby")
    check("lobby-after-drop", bool(lob2) and [s["slot"] for s in lob2["slots"]] == [0, 1],
          json.dumps(lob2))
    a.drain(); b.drain()

    # host leaving closes the room: joiner gets bye with reason 'host-left'
    await a.close()
    for _ in range(200):
        if b.find("bye", reason="host-left"):
            break
        await asyncio.sleep(0.01)
    check("host-leave-closes-room", bool(b.find("bye", reason="host-left")),
          json.dumps(b.inbox))
    await b.close()
    server.close()
    await server.wait_closed()


def main():
    errs = run_async_tests(body)
    for e in errs:
        check("async-body", False, e)
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    print(f"{passed}/{len(RESULTS)} passed")
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
