// Relay protocol conformance (wire-compatible with tools/mca_relay.py) plus
// the hardening the Node relay adds. Every test drives the real server over
// real sockets.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  Client, flush, hostRoom, http, joinRoom, rawWebSocket, sleep, startServer,
} from './helpers/harness.mjs';

describe('relay protocol (python-compatible)', () => {
  let srv;
  const clients = [];
  const track = (c) => { clients.push(c); return c; };
  const open = async (url) => track(await Client.open(url || srv.wsUrl));

  // every test here shares one server and one source address
  before(async () => { srv = await startServer({ MAX_CONNS_PER_IP: '500' }); });
  after(async () => {
    for (const c of clients) c.terminate();
    await srv.close();
  });

  test('create -> room{code,slot:0,host:true} then lobby', async () => {
    const a = await open();
    a.send({ t: 'create', name: 'host' });
    const room = await a.next('room');
    assert.match(room.code, /^[A-Z0-9]{4}$/);
    assert.deepEqual(room, { t: 'room', code: room.code, slot: 0, host: true });
    const lobby = await a.next('lobby');
    assert.deepEqual(lobby, { t: 'lobby', slots: [{ slot: 0, name: 'host' }] });
  });

  test('join with an unknown code -> error, connection stays usable; then a real join', async () => {
    const { host, code } = await hostRoom(srv.wsUrl);
    track(host);
    const b = await open();
    b.send({ t: 'join', code: 'zzzz', name: 'joiner' });
    assert.deepEqual(await b.next('error'), { t: 'error', reason: 'no-such-room', code: 'ZZZZ' });

    b.send({ t: 'join', code: code.toLowerCase(), name: 'joiner' }); // codes are case-insensitive
    assert.deepEqual(await b.next('room'), { t: 'room', code, slot: 1, host: false });
    const expected = { t: 'lobby', slots: [{ slot: 0, name: 'host' }, { slot: 1, name: 'joiner' }] };
    assert.deepEqual(await b.next('lobby'), expected);
    assert.deepEqual(await host.next('lobby'), expected);
  });

  test('relayed messages are stamped with `from`; spoofed `from` is overwritten; no echo', async () => {
    const { host, code } = await hostRoom(srv.wsUrl);
    track(host);
    const { peer: b } = await joinRoom(srv.wsUrl, code);
    track(b);
    await flush(host, b);
    b.send({ t: 'chat', msg: 'hello', from: 99, extra: { nested: [1, 2, 3] } });
    assert.deepEqual(await host.next('chat'), { t: 'chat', msg: 'hello', from: 1, extra: { nested: [1, 2, 3] } });
    assert.ok(await b.quiet('chat'), 'sender must not get its own message back');
    // unknown message types are relayed untouched (the relay is a dumb pipe)
    host.send({ t: 'cmd', tick: 12, slot: 0, seq: 3, cmd: { type: 'move', x: 1.5, y: -2 } });
    assert.deepEqual(await b.next('cmd'), { t: 'cmd', tick: 12, slot: 0, seq: 3, cmd: { type: 'move', x: 1.5, y: -2 }, from: 0 });
  });

  test('`to` delivers to that slot only; bad or unknown `to` is dropped', async () => {
    const { host, code } = await hostRoom(srv.wsUrl);
    track(host);
    const { peer: b } = await joinRoom(srv.wsUrl, code, 'b');
    const { peer: c } = await joinRoom(srv.wsUrl, code, 'c');
    track(b); track(c);
    await flush(host, b, c);

    host.send({ t: 'chat', msg: 'secret', to: 2 });
    assert.deepEqual(await c.next('chat'), { t: 'chat', msg: 'secret', to: 2, from: 0 });
    assert.ok(await b.quiet('chat'));

    // not a member / not an integer / self: nobody receives anything
    for (const to of [5, 99, -1, null, '1', 1.5, true, [1], {}]) host.send({ t: 'chat', msg: 'void', to });
    b.send({ t: 'chat', msg: 'self', to: 1 });
    await sleep(150);
    assert.equal(b.inbox.filter((m) => m.t === 'chat').length, 0);
    assert.equal(c.inbox.filter((m) => m.t === 'chat').length, 0);
    assert.equal(host.inbox.filter((m) => m.t === 'chat').length, 0);

    // a later well-formed message still flows (the bad ones did no damage)
    c.send({ t: 'npong', ts: 7, to: 0 });
    assert.deepEqual(await host.next('npong'), { t: 'npong', ts: 7, to: 0, from: 2 });
  });

  test('ping/pong before joining and inside a room', async () => {
    const a = await open();
    a.send({ t: 'ping', ts: 1234 });
    assert.deepEqual(await a.next('pong'), { t: 'pong', ts: 1234 });
    a.send({ t: 'ping' });
    assert.deepEqual(await a.next('pong'), { t: 'pong', ts: 0 });
    a.send({ t: 'create', name: 'x' });
    await a.next('room');
    a.send({ t: 'ping', ts: 'abc' });
    assert.deepEqual(await a.next('pong'), { t: 'pong', ts: 'abc' });
  });

  test('a peer dropping -> bye{slot,reason:disconnected} + lobby; graceful leave closes the socket', async () => {
    const { host, code } = await hostRoom(srv.wsUrl);
    track(host);
    const { peer: b } = await joinRoom(srv.wsUrl, code, 'b');
    const { peer: c } = await joinRoom(srv.wsUrl, code, 'c');
    track(b); track(c);
    await flush(host, b);

    c.terminate(); // abrupt disconnect
    for (const peer of [host, b]) {
      assert.deepEqual(await peer.next('bye'), { t: 'bye', slot: 2, reason: 'disconnected' });
      assert.deepEqual(await peer.next('lobby'), { t: 'lobby', slots: [{ slot: 0, name: 'host' }, { slot: 1, name: 'b' }] });
    }

    b.send({ t: 'leave' }); // graceful
    assert.deepEqual(await host.next('bye'), { t: 'bye', slot: 1, reason: 'disconnected' });
    assert.deepEqual(await host.next('lobby'), { t: 'lobby', slots: [{ slot: 0, name: 'host' }] });
    assert.equal((await b.waitClose()).code, 1000);

    // the freed slot is handed out again, lowest first
    const d = await joinRoom(srv.wsUrl, code, 'd');
    track(d.peer);
    assert.equal(d.room.slot, 1);
  });

  test('host leaving closes the room: bye{slot:0,reason:host-left}', async () => {
    const { host, code } = await hostRoom(srv.wsUrl);
    const { peer: b } = await joinRoom(srv.wsUrl, code, 'b');
    const { peer: c } = await joinRoom(srv.wsUrl, code, 'c');
    track(b); track(c);
    await flush(b, c);
    host.close();
    assert.deepEqual(await b.next('bye'), { t: 'bye', slot: 0, reason: 'host-left' });
    assert.deepEqual(await c.next('bye'), { t: 'bye', slot: 0, reason: 'host-left' });
    assert.ok(await b.quiet('lobby'), 'no lobby update follows a room close');

    // the room is gone
    const d = await open();
    d.send({ t: 'join', code, name: 'late' });
    assert.equal((await d.next('error')).reason, 'no-such-room');

    // survivors keep their socket (as with the Python relay) and may start over
    assert.ok(b.open);
    b.send({ t: 'chat', msg: 'into the void' });
    assert.ok(await c.quiet('chat'), 'a closed room relays nothing');
    b.send({ t: 'create', name: 'b' });
    assert.equal((await b.next('room')).slot, 0);
  });

  test('rooms hold 6 slots; the 7th join -> room-full; names default and are capped', async () => {
    const host = await open();
    host.send({ t: 'create' }); // no name
    const { code } = await host.next('room');
    const names = ['x'.repeat(40), '', 123, null, '😀'.repeat(30)];
    const peers = [];
    for (let i = 0; i < names.length; i++) {
      const p = await open();
      p.send({ t: 'join', code, name: names[i] });
      const room = await p.next('room');
      assert.equal(room.slot, i + 1);
      peers.push(p);
    }
    const seventh = await open();
    seventh.send({ t: 'join', code, name: 'late' });
    assert.deepEqual(await seventh.next('error'), { t: 'error', reason: 'room-full', code });

    const last = peers[peers.length - 1];
    let lobby = null;
    for (;;) { // the final lobby broadcast lists all six
      lobby = await last.next('lobby');
      if (lobby.slots.length === 6) break;
    }
    assert.deepEqual(lobby.slots.map((s) => s.slot), [0, 1, 2, 3, 4, 5]);
    assert.equal(lobby.slots[0].name, 'P1');            // missing name -> "P<slot+1>"
    assert.equal(lobby.slots[1].name, 'x'.repeat(24));  // capped at 24
    assert.equal(lobby.slots[2].name, 'P3');            // empty
    assert.equal(lobby.slots[3].name, 'P4');            // non-string
    assert.equal(lobby.slots[4].name, 'P5');            // null
    assert.equal(lobby.slots[5].name, '😀'.repeat(24)); // 24 code points, not UTF-16 units
  });

  test('garbage input is ignored and never hurts the connection or the server', async () => {
    const { host, code } = await hostRoom(srv.wsUrl);
    track(host);
    const { peer: b } = await joinRoom(srv.wsUrl, code, 'b');
    track(b);
    await flush(host, b);
    const junk = [
      'not json at all', '', '   ', '{', '[1,2,3]', '42', 'null', '"str"', 'true',
      '{}', '{"t":5}', '{"t":null}', '{"t":["chat"]}', '{"x":"no t"}',
      '{"__proto__":{"t":"chat"},"msg":"pp"}',
      '['.repeat(20000) + ']'.repeat(20000),               // deep nesting
      '{"t":"chat","a":' + '{"a":'.repeat(5000) + '1' + '}'.repeat(5000) + '}',
      '\u0000\u0001\u0002',
    ];
    for (const j of junk) b.sendRaw(j);
    b.sendRaw(Buffer.from([0xff, 0xfe, 0x00, 0x80]), { binary: true }); // invalid UTF-8, binary frame
    b.sendRaw(Buffer.from('{"t":"chat","msg":"binary json"}'), { binary: true }); // JSON in a binary frame is fine
    b.send({ t: 'chat', msg: 'still alive' });

    const got = [];
    for (;;) {
      const m = await host.next('chat');
      got.push(m);
      if (m.msg === 'still alive') break;
    }
    // exactly the well-formed ones came through. (The 5000-level object is
    // valid JSON with a string `t`; whether the JSON engine accepts that depth
    // is its business -- it must simply not hurt anything either way.)
    assert.deepEqual(got.filter((m) => m.msg !== undefined).map((m) => m.msg), ['binary json', 'still alive']);
    assert.ok(got.length <= 3 && got.every((m) => m.from === 1));
    assert.ok(b.open);
    assert.equal((await http(srv.origin + '/healthz')).json.status, 'ok');
  });

  test('messages before joining are ignored (except ping)', async () => {
    const a = await open();
    a.send({ t: 'chat', msg: 'nobody home' });
    a.send({ t: 'leave' });
    a.send({ t: 'cmd', tick: 1 });
    a.send({ t: 'ping', ts: 5 });
    assert.deepEqual(await a.next('pong'), { t: 'pong', ts: 5 });
    assert.equal(a.inbox.length, 0);
    assert.ok(a.open);
  });

  test('create/join inside a room -> error already-in-room and is NOT relayed', async () => {
    const { host, code } = await hostRoom(srv.wsUrl);
    track(host);
    const { peer: b } = await joinRoom(srv.wsUrl, code, 'b');
    track(b);
    await flush(host, b);
    b.send({ t: 'join', code, name: 'again', license: 'MCA1.secret.token' });
    b.send({ t: 'create', name: 'again', license: 'MCA1.secret.token' });
    assert.equal((await b.next('error')).reason, 'already-in-room');
    assert.equal((await b.next('error')).reason, 'already-in-room');
    await sleep(100);
    assert.deepEqual(host.inbox, [], 'license-bearing envelopes must never reach other peers');
  });

  test('the relay answers on /ws and on / (bare URL) and both share rooms; other paths are refused', async () => {
    const { host, code } = await hostRoom(srv.bareWsUrl); // Python-style bare URL
    track(host);
    const { peer: b, room } = await joinRoom(srv.wsUrl, code, 'b');
    track(b);
    assert.equal(room.slot, 1);
    const viaSlash = await joinRoom(srv.bareWsUrl + '/', code, 'c');
    track(viaSlash.peer);
    assert.equal(viaSlash.room.slot, 2);
    const withQuery = await joinRoom(srv.wsUrl + '?x=1', code, 'd');
    track(withQuery.peer);
    assert.equal(withQuery.room.slot, 3);
    await assert.rejects(Client.open(srv.bareWsUrl + '/elsewhere'), (e) => e.statusCode === 404);
    await assert.rejects(Client.open(srv.bareWsUrl + '/api/rooms'), (e) => e.statusCode === 404);
  });
});

describe('relay hardening', () => {
  test('oversize message closes the sender (1009) and the room is told', async (t) => {
    const srv = await startServer({ MAX_MSG_BYTES: '4096', RATE_BYTES_BURST: '65536' });
    t.after(() => srv.close());
    const { host, code } = await hostRoom(srv.wsUrl);
    const { peer: b } = await joinRoom(srv.wsUrl, code, 'b');
    await flush(host, b);
    b.send({ t: 'chat', msg: 'x'.repeat(4000) }); // just under: relayed
    assert.equal((await host.next('chat')).msg.length, 4000);
    b.send({ t: 'chat', msg: 'x'.repeat(5000) }); // over the cap
    assert.equal((await b.waitClose()).code, 1009);
    assert.deepEqual(await host.next('bye'), { t: 'bye', slot: 1, reason: 'disconnected' });
    assert.ok(await host.quiet('chat'));
    assert.equal((await http(srv.origin + '/healthz')).json.rooms, 1);
    host.terminate();
  });

  test('default cap is 64 KiB', async (t) => {
    const srv = await startServer();
    t.after(() => srv.close());
    assert.equal(srv.config.limits.maxMsgBytes, 65536);
    const { host, code } = await hostRoom(srv.wsUrl);
    const { peer: b } = await joinRoom(srv.wsUrl, code, 'b');
    await flush(host, b);
    b.send({ t: 'log', cmds: 'y'.repeat(60000) });
    assert.equal((await host.next('log')).cmds.length, 60000);
    b.send({ t: 'log', cmds: 'y'.repeat(70000) });
    assert.equal((await b.waitClose()).code, 1009);
    host.terminate();
  });

  test('message flood -> error rate-limited, close 1008, room told; normal lockstep rates pass', async (t) => {
    const srv = await startServer({ RATE_MSGS_PER_SEC: '50', RATE_BURST: '120' });
    t.after(() => srv.close());
    const { host, code } = await hostRoom(srv.wsUrl);
    const { peer: b } = await joinRoom(srv.wsUrl, code, 'b');
    await flush(host, b);

    // 100 messages in one burst is inside the burst allowance
    for (let i = 0; i < 100; i++) b.send({ t: 'stall', tick: i });
    let last = null;
    for (let i = 0; i < 100; i++) last = await host.next('stall');
    assert.equal(last.tick, 99);
    assert.ok(b.open);

    // ...but an unbounded flood is cut off
    for (let i = 0; i < 400; i++) b.send({ t: 'stall', tick: 1000 + i });
    const err = await b.next('error');
    assert.equal(err.reason, 'rate-limited');
    assert.equal((await b.waitClose()).code, 1008);
    assert.deepEqual(await host.next('bye'), { t: 'bye', slot: 1, reason: 'disconnected' });
    const relayed = host.drain().filter((m) => m.t === 'stall').length;
    assert.ok(relayed < 150, 'flood must be truncated, relayed=' + relayed);
    assert.ok(srv.logs.some((l) => l.evt === 'conn.kick' && l.reason === 'rate-limited'));
    host.terminate();
  });

  test('byte-rate limit catches a few huge messages too', async (t) => {
    const srv = await startServer({ RATE_BYTES_PER_SEC: '1024', RATE_BYTES_BURST: '70000' });
    t.after(() => srv.close());
    const { host } = await hostRoom(srv.wsUrl);
    host.send({ t: 'log', cmds: 'z'.repeat(60000) });
    host.send({ t: 'log', cmds: 'z'.repeat(60000) });
    assert.equal((await host.next('error')).reason, 'rate-limited');
    assert.equal((await host.waitClose()).code, 1008);
  });

  test('wrong-code guessing is throttled per address', async (t) => {
    const srv = await startServer({ JOIN_FAILS_PER_MIN: '3' });
    t.after(() => srv.close());
    const a = await Client.open(srv.wsUrl);
    for (let i = 0; i < 3; i++) {
      a.send({ t: 'join', code: 'NO' + i + 'X' });
      assert.equal((await a.next('error')).reason, 'no-such-room');
    }
    a.send({ t: 'join', code: 'NO9X' });
    assert.equal((await a.next('error')).reason, 'too-many-attempts');
    assert.equal((await a.waitClose()).code, 1008);
    // the budget is per address, so a fresh socket does not reset it...
    const b = await Client.open(srv.wsUrl);
    b.send({ t: 'join', code: 'AAAA' });
    assert.equal((await b.next('error')).reason, 'too-many-attempts');
    // ...while hosting is unaffected
    const { host } = await hostRoom(srv.wsUrl);
    assert.ok(host.open);
    host.terminate();
  });

  test('room cap -> server-full (the connection stays usable)', async (t) => {
    const srv = await startServer({ MAX_ROOMS: '2' });
    t.after(() => srv.close());
    const r1 = await hostRoom(srv.wsUrl);
    const r2 = await hostRoom(srv.wsUrl);
    const c = await Client.open(srv.wsUrl);
    c.send({ t: 'create', name: 'third' });
    const err = await c.next('error');
    assert.equal(err.reason, 'server-full');
    assert.equal(typeof err.message, 'string');
    r1.host.close();
    await sleep(100);
    c.send({ t: 'create', name: 'third' }); // a slot freed up
    assert.equal((await c.next('room')).slot, 0);
    r2.host.terminate(); c.terminate();
  });

  test('per-IP and global connection caps answer in-band, then close (1013)', async (t) => {
    const srv = await startServer({ MAX_CONNS_PER_IP: '2' });
    t.after(() => srv.close());
    const a = await Client.open(srv.wsUrl);
    const b = await Client.open(srv.wsUrl);
    const c = await Client.open(srv.wsUrl);
    assert.equal((await c.next('error')).reason, 'too-many-connections');
    assert.equal((await c.waitClose()).code, 1013);
    a.close();
    await a.waitClose();
    await sleep(50);
    const d = await Client.open(srv.wsUrl); // the freed slot is usable again
    d.send({ t: 'ping', ts: 1 });
    assert.equal((await d.next('pong')).ts, 1);
    b.terminate(); d.terminate();

    const srv2 = await startServer({ MAX_CONNECTIONS: '1' });
    t.after(() => srv2.close());
    const x = await Client.open(srv2.wsUrl);
    const y = await Client.open(srv2.wsUrl);
    assert.equal((await y.next('error')).reason, 'server-full');
    assert.equal((await y.waitClose()).code, 1013);
    x.terminate();
  });

  test('X-Forwarded-For is honoured only with TRUST_PROXY', async (t) => {
    const untrusted = await startServer({ MAX_CONNS_PER_IP: '1' });
    t.after(() => untrusted.close());
    const a = await Client.open(untrusted.wsUrl, { headers: { 'X-Forwarded-For': '203.0.113.1' } });
    const b = await Client.open(untrusted.wsUrl, { headers: { 'X-Forwarded-For': '203.0.113.2' } });
    assert.equal((await b.next('error')).reason, 'too-many-connections', 'a spoofed header must not dodge the cap');
    a.terminate();

    const trusted = await startServer({ MAX_CONNS_PER_IP: '1', TRUST_PROXY: '1' });
    t.after(() => trusted.close());
    // the proxy appends the address it saw: the RIGHTMOST entry is the client
    const c = await Client.open(trusted.wsUrl, { headers: { 'X-Forwarded-For': '10.9.9.9, 203.0.113.1' } });
    const d = await Client.open(trusted.wsUrl, { headers: { 'X-Forwarded-For': '10.9.9.9, 203.0.113.2' } });
    d.send({ t: 'ping', ts: 2 });
    assert.equal((await d.next('pong')).ts, 2);
    // same real client, different self-reported left-most entry: still capped
    const e = await Client.open(trusted.wsUrl, { headers: { 'X-Forwarded-For': '1.2.3.4, 203.0.113.2' } });
    assert.equal((await e.next('error')).reason, 'too-many-connections');
    assert.ok(trusted.logs.some((l) => l.evt === 'conn.open' && l.ip === '203.0.113.1'));
    c.terminate(); d.terminate();
  });

  test('ALLOWED_ORIGINS gates the WebSocket upgrade', async (t) => {
    const srv = await startServer({ ALLOWED_ORIGINS: 'https://play.example.com, https://itch.zone' });
    t.after(() => srv.close());
    const ok = await Client.open(srv.wsUrl, { origin: 'https://play.example.com' });
    ok.send({ t: 'ping', ts: 1 });
    assert.equal((await ok.next('pong')).ts, 1);
    const same = await Client.open(srv.wsUrl, { origin: srv.origin }); // the page we serve ourselves
    assert.ok(same.open);
    await assert.rejects(Client.open(srv.wsUrl, { origin: 'https://evil.example' }), (e) => e.statusCode === 403);
    await assert.rejects(Client.open(srv.wsUrl, { origin: 'https://play.example.com.evil.example' }), (e) => e.statusCode === 403);
    await assert.rejects(Client.open(srv.wsUrl), (e) => e.statusCode === 403); // no Origin at all
    ok.terminate(); same.terminate();

    const open = await startServer(); // default: no allowlist, any origin
    t.after(() => open.close());
    const any = await Client.open(open.wsUrl, { origin: 'https://anything.example' });
    assert.ok(any.open);
    any.terminate();
  });

  test('heartbeat drops a socket that stops answering pings and frees its room', async (t) => {
    const srv = await startServer({ HEARTBEAT_MS: '80' });
    t.after(() => srv.close());
    const raw = await rawWebSocket(srv.port);       // never answers pings
    raw.sendText(JSON.stringify({ t: 'create', name: 'zombie' }));
    const live = await Client.open(srv.wsUrl);      // a real client answers them
    live.send({ t: 'create', name: 'alive' });
    await live.next('room');
    await sleep(60);
    assert.equal(srv.app.relay.stats().rooms, 2);
    await raw.waitClosed(2000);
    await sleep(50);
    assert.equal(srv.app.relay.stats().rooms, 1, 'the dead host’s room is gone, the live one stays');
    assert.ok(live.open);
    assert.ok(srv.logs.some((l) => l.evt === 'conn.dead'));
    live.terminate();
  });

  test('a socket that never joins a room is reaped', async (t) => {
    const srv = await startServer({ HEARTBEAT_MS: '60', UNJOINED_TIMEOUT_MS: '150' });
    t.after(() => srv.close());
    const idle = await Client.open(srv.wsUrl);
    const { host } = await hostRoom(srv.wsUrl);
    assert.equal((await idle.next('error')).reason, 'idle-timeout');
    await idle.waitClose();
    await sleep(200);
    assert.ok(host.open, 'a joined connection is not subject to the unjoined timeout');
    host.terminate();
  });

  test('idle rooms are reaped: host gets error, others get error + bye{slot:0}', async (t) => {
    const srv = await startServer({ HEARTBEAT_MS: '60', ROOM_IDLE_MS: '250' });
    t.after(() => srv.close());
    const { host, code } = await hostRoom(srv.wsUrl);
    const { peer: b } = await joinRoom(srv.wsUrl, code, 'b');
    await flush(host, b);
    // traffic keeps the room alive past the idle window
    for (let i = 0; i < 6; i++) { b.send({ t: 'stall', tick: i }); await sleep(80); }
    assert.equal(srv.app.relay.stats().rooms, 1);
    // silence: reaped
    assert.equal((await host.next('error')).reason, 'room-idle');
    assert.equal((await b.next('error')).reason, 'room-idle');
    assert.deepEqual(await b.next('bye'), { t: 'bye', slot: 0, reason: 'room-idle' });
    await host.waitClose(); await b.waitClose();
    assert.equal(srv.app.relay.stats().rooms, 0);
  });

  test('a peer that stops reading is cut off instead of exhausting server memory', async (t) => {
    const srv = await startServer({
      MAX_BUFFERED_BYTES: '65536', RATE_MSGS_PER_SEC: '100000', RATE_BURST: '100000',
      RATE_BYTES_PER_SEC: '1000000000', RATE_BYTES_BURST: '1000000000',
    });
    t.after(() => srv.close());
    const { host, code } = await hostRoom(srv.wsUrl);
    const slow = await rawWebSocket(srv.port);
    slow.sendText(JSON.stringify({ t: 'join', code, name: 'slow' }));
    await host.next((m) => m.t === 'lobby' && m.slots.length === 2);
    slow.socket.pause(); // stops reading: kernel buffers fill, then the server's
    const big = 'q'.repeat(60000);
    let sent = 0;
    const bye = host.next('bye', 15000);
    const pump = setInterval(() => {
      for (let i = 0; i < 20 && host.open; i++) { host.send({ t: 'log', cmds: big }); sent++; }
    }, 5);
    t.after(() => clearInterval(pump));
    assert.deepEqual(await bye, { t: 'bye', slot: 1, reason: 'disconnected' });
    clearInterval(pump);
    assert.ok(srv.logs.some((l) => l.evt === 'conn.slow'), 'server logged the slow consumer');
    assert.ok(host.open, 'the sender is unaffected');
    assert.ok(sent > 0);
    slow.socket.destroy(); host.terminate();
  });

  test('graceful shutdown tells every room, then closes with 1001', async () => {
    const srv = await startServer();
    const { host, code } = await hostRoom(srv.wsUrl);
    const { peer: b } = await joinRoom(srv.wsUrl, code, 'b');
    const lurker = await Client.open(srv.wsUrl);
    await flush(host, b);
    const closing = srv.close();
    const he = await host.next('error');
    assert.equal(he.reason, 'server-shutdown');
    assert.match(he.message, /restart/i);
    assert.equal((await b.next('error')).reason, 'server-shutdown');
    assert.deepEqual(await b.next('bye'), { t: 'bye', slot: 0, reason: 'server-shutdown' });
    assert.equal((await lurker.next('error')).reason, 'server-shutdown');
    for (const c of [host, b, lurker]) assert.equal((await c.waitClose()).code, 1001);
    await closing;
    await assert.rejects(Client.open(srv.wsUrl));
  });
});

describe('lobby browser + stats (additive)', () => {
  test('public rooms are listed, private ones are not; map follows the host; started/full rooms drop out', async (t) => {
    const srv = await startServer();
    t.after(() => srv.close());
    const priv = await hostRoom(srv.wsUrl); // old-style create: never listed
    const pub = await hostRoom(srv.wsUrl, { public: true, title: 'Friday night\u0007 <b>RTS</b>', map: 'sinai' });
    const anon = await hostRoom(srv.wsUrl, { public: true, name: 'Rommel' });

    let list = (await http(srv.origin + '/api/rooms')).json.rooms;
    assert.equal(list.length, 2);
    const mine = list.find((r) => r.code === pub.code);
    assert.deepEqual(mine, { code: pub.code, title: 'Friday night <b>RTS</b>', map: 'sinai', players: 1, max: 6 });
    assert.equal(list.find((r) => r.code === anon.code).title, "Rommel's room");
    assert.ok(!list.some((r) => r.code === priv.code));

    const { peer: b } = await joinRoom(srv.wsUrl, pub.code, 'b');
    pub.host.send({ t: 'cfg', cfg: { map: 'gulf', seed: 1, delay: 2 } }); // host picks another map
    await b.next('cfg');
    list = (await http(srv.origin + '/api/rooms')).json.rooms;
    assert.deepEqual(list.find((r) => r.code === pub.code), { code: pub.code, title: 'Friday night <b>RTS</b>', map: 'gulf', players: 2, max: 6 });

    const stats = (await http(srv.origin + '/api/stats')).json;
    assert.deepEqual(stats, { online: 4, rooms: 3, publicRooms: 2, inMatch: 0, connections: 4 });

    b.send({ t: 'start', epoch: 1 }); // only the HOST's start counts
    await pub.host.next('start');
    assert.ok((await http(srv.origin + '/api/rooms')).json.rooms.some((r) => r.code === pub.code));
    pub.host.send({ t: 'start', epoch: 1 });
    await b.next('start');
    list = (await http(srv.origin + '/api/rooms')).json.rooms;
    assert.ok(!list.some((r) => r.code === pub.code), 'a started match is no longer joinable from the browser');
    assert.equal((await http(srv.origin + '/api/stats')).json.inMatch, 1);

    // a full room is not listed either
    const extra = [];
    for (let i = 0; i < 5; i++) extra.push((await joinRoom(srv.wsUrl, anon.code, 'p' + i)).peer);
    list = (await http(srv.origin + '/api/rooms')).json.rooms;
    assert.equal(list.length, 0);

    for (const c of [priv.host, pub.host, anon.host, b, ...extra]) c.terminate();
    await sleep(100);
    assert.deepEqual((await http(srv.origin + '/api/stats')).json, { online: 0, rooms: 0, publicRooms: 0, inMatch: 0, connections: 0 });
  });
});
