# MCA multiplayer relay (v0.10.0): a dumb WebSocket relay with room membership.
# No game logic lives here — clients exchange JSON envelopes
# ({t:'...', from?, to?, ...}); the relay stamps `from` with the sender's room
# slot and delivers to the other room members (or to `to` only, when set).
#
# Relay-level messages (consumed here, never relayed):
#   {t:'create', name}            -> {t:'room', code, slot:0, host:true}
#   {t:'join',   code, name}      -> {t:'room', code, slot, host:false}
#                                    (room members get {t:'lobby', slots:[...]})
#   {t:'leave'}                   -> graceful exit (peers get {t:'bye', slot})
#   {t:'ping', ts}                -> {t:'pong', ts}            (relay RTT)
# Everything else is relayed to the sender's room (minus the sender).
#
# First joiner is the HOST. Host leaving closes the room (peers are told with
# {t:'bye', slot:<hostSlot>, reason:'host-left'} then dropped).
#
# Usage: python tools/mca_relay.py [--port 8790] [--local-only]
# Stdlib + websockets only.

import argparse
import asyncio
import json
import secrets
import string
import sys

try:
    import websockets
except ImportError:
    sys.exit("websockets not installed — run: .venv/Scripts/python -m pip install websockets")

ROOM_CODE_ALPHABET = string.ascii_uppercase + string.digits
ROOM_CODE_LEN = 4
MAX_SLOTS = 6                 # matches the 6-spawn maps
PING_INTERVAL_S = 20          # server-side liveness ping
PING_TIMEOUT_S = 10
def LOG(*args):
    print(*args, flush=True)


def make_code(rooms):
    for _ in range(100):
        code = "".join(secrets.choice(ROOM_CODE_ALPHABET) for _ in range(ROOM_CODE_LEN))
        if code not in rooms:
            return code
    raise RuntimeError("could not allocate a room code")


class Peer:
    def __init__(self, ws, slot, name):
        self.ws = ws
        self.slot = slot
        self.name = (name or ("P" + str(slot + 1)))[:24]
        self.alive = True

    async def send(self, msg):
        await self.ws.send(json.dumps(msg))


class Room:
    def __init__(self, code, host_peer):
        self.code = code
        self.peers = {}            # slot -> Peer
        self.host_slot = host_peer.slot
        self.add(host_peer)

    def add(self, peer):
        self.peers[peer.slot] = peer

    def slots_payload(self):
        return [{"slot": p.slot, "name": p.name} for p in sorted(self.peers.values(), key=lambda p: p.slot)]

    async def broadcast(self, msg, exclude=None):
        dead = []
        only = msg.get("to")
        for slot, peer in self.peers.items():
            if exclude is not None and slot == exclude:
                continue
            if only is not None and slot != only:
                continue
            try:
                await peer.send(msg)
            except Exception:
                dead.append(slot)
        for slot in dead:
            await self.drop_slot(slot, reason="send-failed")

    async def drop_slot(self, slot, reason="left"):
        peer = self.peers.pop(slot, None)
        if peer is None:
            return
        LOG(f"[room {self.code}] slot {slot} ({peer.name}) left: {reason}")
        if not self.peers:
            return False  # room empty: caller removes it
        await self.broadcast({"t": "bye", "slot": slot, "reason": reason}, exclude=None)
        await self.broadcast({"t": "lobby", "slots": self.slots_payload()})
        return True


class Relay:
    def __init__(self):
        self.rooms = {}            # code -> Room
        self.peer_room = {}        # id(websocket) -> (code, slot)

    async def handle(self, ws):
        me = None  # (room, peer)
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue  # dumb pipe: ignore non-JSON, never crash
                if not isinstance(msg, dict) or not isinstance(msg.get("t"), str):
                    continue
                t = msg["t"]
                if me is None:
                    me = await self.handle_join(ws, msg, t)
                    continue
                room, peer = me
                if t == "leave":
                    break
                if t == "ping":
                    await peer.send({"t": "pong", "ts": msg.get("ts", 0)})
                    continue
                # everything else: relay to the room (minus the sender).
                # `from` is stamped by the relay; client-supplied from/to that
                # are not the sender's slot are overwritten (anti-spoof).
                out = dict(msg)
                out["from"] = peer.slot
                if "to" in out and out["to"] not in room.peers:
                    continue
                await room.broadcast(out, exclude=peer.slot)
        except websockets.ConnectionClosed:
            pass
        finally:
            if me is not None:
                room, peer = me
                await self.remove_peer(room, peer, reason="disconnected")

    async def handle_join(self, ws, msg, t):
        if t == "create":
            code = make_code(self.rooms)
            slot = 0
        elif t == "join":
            code = str(msg.get("code", "")).upper()
            if code not in self.rooms:
                await ws.send(json.dumps({"t": "error", "reason": "no-such-room", "code": code}))
                return None
            room = self.rooms[code]
            used = set(room.peers)
            free = [s for s in range(MAX_SLOTS) if s not in used]
            if not free:
                await ws.send(json.dumps({"t": "error", "reason": "room-full", "code": code}))
                return None
            slot = free[0]
        else:
            # hello/ping before joining: answer liveness, stay unjoined
            if t == "ping":
                await ws.send(json.dumps({"t": "pong", "ts": msg.get("ts", 0)}))
            return None

        peer = Peer(ws, slot, msg.get("name", ""))
        if t == "create":
            room = Room(code, peer)
            self.rooms[code] = room
            LOG(f"[room {code}] created by {peer.name} (slot 0, host)")
        else:
            room = self.rooms[code]
            room.add(peer)
            LOG(f"[room {code}] {peer.name} joined as slot {slot}")
        self.peer_room[id(ws)] = (code, slot)
        await peer.send({"t": "room", "code": code, "slot": slot, "host": slot == room.host_slot})
        await room.broadcast({"t": "lobby", "slots": room.slots_payload()}, exclude=None)
        return room, peer

    async def remove_peer(self, room, peer, reason):
        self.peer_room.pop(id(peer.ws), None)
        if room.code not in self.rooms:
            return
        if peer.slot == room.host_slot and reason != "room-closed":
            # host gone: close the room, tell everyone
            LOG(f"[room {room.code}] host left — closing room")
            others = [p for s, p in sorted(room.peers.items()) if s != peer.slot]
            room.peers.pop(peer.slot, None)
            for other in others:
                try:
                    await other.send({"t": "bye", "slot": peer.slot, "reason": "host-left"})
                except Exception:
                    pass
            self.rooms.pop(room.code, None)
            return
        if await room.drop_slot(peer.slot, reason=reason):
            pass
        if not room.peers:
            self.rooms.pop(room.code, None)

    async def serve(self, host, port):
        async with websockets.serve(self.handle, host, port, ping_interval=PING_INTERVAL_S, ping_timeout=PING_TIMEOUT_S):
            LOG(f"MCA relay listening on {'127.0.0.1' if host == '127.0.0.1' else host}:{port}"
                f"{' (local-only)' if host == '127.0.0.1' else ''}")
            await asyncio.Future()  # run forever


def main():
    ap = argparse.ArgumentParser(description="MCA multiplayer relay")
    ap.add_argument("--port", type=int, default=8790)
    ap.add_argument("--local-only", action="store_true",
                    help="bind 127.0.0.1 only (LAN games: omit this)")
    args = ap.parse_args()
    host = "127.0.0.1" if args.local_only else "0.0.0.0"
    relay = Relay()
    try:
        asyncio.run(relay.serve(host, args.port))
    except KeyboardInterrupt:
        LOG("relay stopped")


if __name__ == "__main__":
    main()
