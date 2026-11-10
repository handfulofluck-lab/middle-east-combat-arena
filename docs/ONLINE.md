# MCA online: hosting, multiplayer, deployment

One Node process (`server/index.js`) does everything the game needs online:

| Path | What it is |
|---|---|
| `/` and everything else | the built client from `dist/web` (static files, SPA fallback) |
| `/config.js` | runtime configuration for the client, generated from the environment |
| `/ws` and `/` (WebSocket) | the multiplayer relay (wire-compatible with `tools/mca_relay.py`) |
| `/healthz` | health check (JSON) |
| `/api/rooms`, `/api/stats` | public room list for a lobby browser, online counts |
| `/api/checkout`, `/api/stripe/webhook`, `/api/license/*`, `/api/admin/license` | payments and license keys — **off until configured**, see [MONETIZATION.md](MONETIZATION.md) |

It needs Node 22+ and one npm package (`ws`). It is meant to sit behind a
TLS-terminating proxy (Render, Fly.io, Railway, nginx, Caddy…); it speaks plain
HTTP itself.

Contents: [Run locally](#a-run-locally) · [Deploy the full server](#b-deploy-the-full-server) ·
[Static hosting](#c-host-the-client-statically) · [Environment variables](#d-environment-variables) ·
[Capacity and scaling](#e-capacity-and-scaling-limits) · [Security notes](#f-security-notes) ·
[Protocol](#relay-protocol) · [Tests](#tests) · [Troubleshooting](#troubleshooting)

---

## (a) Run locally

```bash
npm ci            # once
npm run build     # client -> dist/web
npm start         # http://localhost:8790
```

Open `http://localhost:8790`, choose **Multiplayer → Host** in one tab and
**Join** with the room code in another. The relay address field can stay
empty/default: a client served by this server uses the same origin
(`ws://localhost:8790/ws`).

Playing over a LAN: other machines open `http://<your-LAN-IP>:8790`.

Useful while developing:

```bash
PORT=8791 LOG_LEVEL=debug npm start          # another port, verbose logs
WEB_ROOT=/some/other/build npm start         # serve a different build
curl -s localhost:8790/healthz               # {"status":"ok","uptime":…,"rooms":0,"peers":0,…}
node --test server/test/                     # the server test suite (about 15 s)
```

`npm run dev` (Vite, port 5173) serves the client only. A client loaded from
the Vite dev server looks for a relay on `ws://127.0.0.1:8790`, so run
`npm start` next to it.

The old Python relay (`python tools/mca_relay.py`) still works and old clients
work against the new server: the wire protocol is the same.

---

## (b) Deploy the full server

Anything that runs a Docker image works. The image is built by the `Dockerfile`
in the repository root (multi-stage: build the client, install production
dependencies only, run as the unprivileged `node` user, built-in health check).

Three things matter on every host:

1. **Exactly one instance.** Rooms live in the process's memory. Two instances
   behind a load balancer would put the host and the joiner of a room on
   different machines. See [Capacity](#e-capacity-and-scaling-limits).
2. **`TRUST_PROXY=1`** when a proxy is in front (always, on a PaaS). Without it
   every player appears to come from the proxy's address and the per-address
   connection cap (`MAX_CONNS_PER_IP`, default 16) applies to *all players
   together*. After the first deploy, open the game, then check that the `ip`
   field of the `conn.open` log line is your own public address.
3. **A persistent `DATA_DIR`** as soon as you issue license keys. The license
   ledger (`licenses.jsonl`) lives there; if it is lost, previously revoked
   keys become valid again.

### Render

`render.yaml` is a ready Blueprint.

1. Push the repository to GitHub/GitLab.
2. Render dashboard → **New → Blueprint** → pick the repository.
3. Render asks for the variables marked `sync: false`. For a first deploy
   leave the `STRIPE_*` ones empty and set `PUBLIC_URL` to the service URL
   (`https://<name>.onrender.com`, or your custom domain).
4. Deploy. The health check is `/healthz`. WebSockets need no extra setting.

Notes: the Blueprint requests the `starter` plan because a persistent disk
needs a paid instance; `LICENSE_SECRET` and `ADMIN_TOKEN` are generated once by
Render (`generateValue`). A service with a disk restarts with a short
interruption on every deploy — running matches are closed (players are told
"the server is restarting"). The Blueprint also sets `RUNTIME_USER=root`, a
*build argument* of the Dockerfile (not a server setting): the container
starts as root just long enough to make the disk writable for the unprivileged
`node` user, then drops privileges. After the first deploy check the log: a
`license.ledger.loaded` line means the disk is writable; `license.disabled …
EACCES` means it is not (see Troubleshooting).

### Fly.io

`fly.toml` is ready apart from the app name.

```bash
fly launch --copy-config --no-deploy          # choose a unique name and a region
fly volumes create mca_data --size 1 --region <region>
fly secrets set LICENSE_SECRET="$(openssl rand -base64 48)" ADMIN_TOKEN="$(openssl rand -base64 36)"
fly deploy
fly scale count 1                              # never more than one machine
```

`fly.toml` builds the image with `RUNTIME_USER=root`: Fly mounts volumes owned
by root, so the entrypoint hands `/data` to the `node` user and then drops
privileges permanently — the server itself never runs as root.

### Any Docker host

```bash
docker build -t mca .
docker run -d --name mca --restart unless-stopped \
  -p 127.0.0.1:8790:8790 \
  -v mca-data:/data \
  -e TRUST_PROXY=1 \
  -e PUBLIC_URL=https://play.example.com \
  -e LICENSE_SECRET="$(openssl rand -base64 48)" \
  -e ADMIN_TOKEN="$(openssl rand -base64 36)" \
  mca
```

(Keep the generated secrets somewhere safe — changing `LICENSE_SECRET` later
invalidates every key ever issued.) Put a TLS proxy in front. It must forward
WebSocket upgrades and set `X-Forwarded-For`. Caddy does both by default:

```
play.example.com {
    reverse_proxy 127.0.0.1:8790
}
```

nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:8790;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 120s;
}
```

If Docker Hub rate-limits the base image, build with
`--build-arg NODE_IMAGE=mirror.gcr.io/library/node:22-bookworm-slim`.
If your volume is mounted owned by root and the logs say
`license.disabled … EACCES`, build with `--build-arg RUNTIME_USER=root`.

Without Docker: `npm ci && npm run build && NODE_ENV=production npm start`
under systemd/pm2, same environment variables.

---

## (c) Host the client statically

The client is plain static files (`dist/web`). It can live on GitHub Pages,
Netlify, Cloudflare Pages, itch.io… Single-player then needs no server at all.
For multiplayer (and the store) the static client must be told where your
server is, through `config.js`:

```bash
npm run build
node server/static-config.mjs dist/web/config.js --server https://mca.example.com
```

`--server` reads `https://mca.example.com/config.js` and bakes the same
settings (paywall, store, product) into the static file, with `relayUrl`
(`wss://mca.example.com/ws`) and `apiBase` filled in. Re-run it whenever the
server's configuration changes. For a relay-only setup:
`--relay wss://relay.example.com/ws`. Or edit `dist/web/config.js` by hand —
the shape is in `client/public/config.js`.

On the **server**, allow the static site:

| Variable | Value |
|---|---|
| `ALLOWED_ORIGINS` | the static site's origin(s), comma-separated, e.g. `https://you.github.io,https://html-classic.itch.zone` |
| `PUBLIC_URL` | the URL players open, e.g. `https://you.github.io/mca` (Stripe Checkout returns there) |

`ALLOWED_ORIGINS` does two things: browsers on those origins may call the API
(CORS), and — once it is set — the relay only accepts WebSocket connections
from those origins and from the server's own pages.

A page served over `https://` can only use a `wss://` relay (browsers block
mixed content), so the server needs TLS even if the static host provides its
own.

### GitHub Pages

1. Repository → Settings → Pages → Source: **GitHub Actions**.
2. Actions → **Deploy client to GitHub Pages** → Run workflow. Enter your
   server URL (or leave it empty for a single-player-only build).

The workflow (`.github/workflows/pages.yml`) only ever runs when started by
hand, so pushes never fail because Pages is not enabled.

### Netlify / Cloudflare Pages

Build command `npm run build && node server/static-config.mjs dist/web/config.js --server https://mca.example.com`,
publish directory `dist/web`.

### itch.io

Zip the *contents* of `dist/web` (after writing `config.js` as above) and
upload it as an HTML5 game. itch.io serves the game from its own origin inside
an iframe: add that origin to `ALLOWED_ORIGINS` (open the game on itch.io, look
at the iframe's address — currently `https://html-classic.itch.zone`). Stripe's
Checkout page cannot be shown inside the iframe and the return trip would land
outside itch.io, so for itch.io sell through itch.io itself and hand out
license keys (see MONETIZATION.md, "Other storefronts").

---

## (d) Environment variables

Everything is optional; with no variables at all you get a free game server on
port 8790 with payments switched off.

### Core

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8790` | Port to listen on. |
| `HOST` | `0.0.0.0` | Address to bind. |
| `WEB_ROOT` | `dist/web` | Directory with the built client. |
| `DATA_DIR` | `data` | Where the license ledger is stored. Must be persistent once keys are issued. Only created when licensing is on. |
| `PUBLIC_URL` | – | Public URL where players load the game. Used for the Stripe Checkout return URLs, same-origin checks and HSTS. Required for the store. |
| `RELAY_URL` | – | Advertise a different relay in `/config.js` (`wss://…`). Empty = same origin `/ws`. |
| `API_BASE` | – | Advertise a different API base in `/config.js`. Empty = same origin. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent`. Logs are one JSON object per line on stdout. |

### Behind a proxy / browser security

| Variable | Default | Meaning |
|---|---|---|
| `TRUST_PROXY` | `0` | Number of trusted reverse-proxy hops in front of the server (`1` on Render/Fly/Railway/nginx). The client address is then taken from `X-Forwarded-For`, counting from the right. `0`: forwarding headers are ignored. |
| `CLIENT_IP_HEADER` | – | A single-value header your platform sets with the real client address (`fly-client-ip`, `cf-connecting-ip`). Used instead of `X-Forwarded-For` when present. Only honoured with `TRUST_PROXY`. |
| `ALLOWED_ORIGINS` | – | Comma-separated origins of separately hosted clients. Enables CORS for them and restricts WebSocket upgrades to them plus the server's own origin. Empty: same-origin API only, relay open to any origin. |
| `FRAME_ANCESTORS` | `'self'` | CSP `frame-ancestors` source list, to allow embedding the game in other sites' iframes. |
| `CSP_EXTRA` | – | Extra sources merged into the generated Content-Security-Policy, e.g. `connect-src wss://eu.example.com; script-src https://plausible.io`. |
| `CSP` | – | Replace the whole Content-Security-Policy (you then maintain it yourself). |
| `CSP_REPORT_ONLY` | `0` | `1`: send the policy as `Content-Security-Policy-Report-Only` (for testing a policy). |
| `HSTS` | on with an `https://` `PUBLIC_URL` | `0` disables the `Strict-Transport-Security` header. |

### Relay limits

| Variable | Default | Meaning |
|---|---|---|
| `MAX_ROOMS` | `500` | Rooms that may exist at once. |
| `MAX_CONNECTIONS` | `2000` | Open WebSocket connections. |
| `MAX_CONNS_PER_IP` | `16` | Open connections per client address (IPv6: per /64). |
| `MAX_MSG_BYTES` | `65536` | Largest accepted message; a bigger one closes the connection (code 1009). |
| `RATE_MSGS_PER_SEC` | `100` | Sustained messages per second per connection. |
| `RATE_BURST` | `400` | Burst allowance (messages). |
| `RATE_BYTES_PER_SEC` | `131072` | Sustained bytes per second per connection. |
| `RATE_BYTES_BURST` | `524288` | Burst allowance (bytes); must be ≥ `MAX_MSG_BYTES`. |
| `MAX_BUFFERED_BYTES` | `1048576` | A peer with more than this queued for it (it stopped reading) is disconnected. |
| `HEARTBEAT_MS` | `20000` | Ping interval; a socket that misses a ping is dropped at the next one. |
| `ROOM_IDLE_MS` | `1800000` | A room with no traffic for this long is closed. |
| `UNJOINED_TIMEOUT_MS` | `30000` | A connection that never creates/joins a room is closed after this long. |
| `JOIN_FAILS_PER_MIN` | `20` | Wrong room codes — and, with a paywall, forged license keys — allowed per address per minute before the connection is dropped. |
| `MAX_CONNS_PER_LICENSE` | `3` | Paywall only: concurrent sessions per license key (`0` = unlimited). |

For scale: a lockstep client sends about 11 messages per second (one
end-of-input marker per 10 Hz tick plus commands, checksums and pings; while
it waits for another player, two keepalives per second instead). The defaults
leave roughly 9× headroom sustained and a 400-message burst for catch-up
after a hiccup.

### Payments and licenses (all off by default — see MONETIZATION.md)

| Variable | Default | Meaning |
|---|---|---|
| `MCA_PAYWALL` | `off` | `off`, `multiplayer` or `full`. Anything but `off` requires `LICENSE_SECRET`, or the server refuses to start. |
| `PRODUCT_NAME` | `Founder's Pass` | Display name of the product. |
| `PRICE_LABEL` | – | Display price, e.g. `$9.99`. The charged amount is whatever the Stripe Price says. |
| `PRODUCT_ID` | `founders-pass` | Identifier embedded in license keys. Changing it invalidates existing keys. |
| `LICENSE_SECRET` | – | Secret the license signing key is derived from. 32+ random characters. **Changing it invalidates every key.** |
| `ADMIN_TOKEN` | – | Bearer token for `POST /api/admin/license`. 24+ random characters. Unset = endpoint disabled. |
| `STRIPE_SECRET_KEY` | – | `sk_test_…` / `sk_live_…` (or a restricted `rk_…` key). |
| `STRIPE_PRICE_ID` | – | `price_…` of the one-time price to sell. |
| `STRIPE_WEBHOOK_SECRET` | – | `whsec_…` signing secret of the webhook endpoint. |
| `STRIPE_AUTOMATIC_TAX` | `0` | `1`: ask Stripe Checkout to calculate tax (requires Stripe Tax to be set up). |
| `STRIPE_API_BASE` | `https://api.stripe.com` | For tests only (a local mock). Must be `https://`, or `http://` on loopback. |

---

## (e) Capacity and scaling limits

**The design is one process.** Rooms and their members are plain objects in
memory; nothing is shared between processes and nothing about a room is
written to disk.

What that means in practice:

* A restart or deploy ends every running match. The server tells each room
  (`server-shutdown`) and closes the sockets cleanly; players go back to the
  menu. Deploy at quiet times.
* You cannot add a second instance behind a load balancer. If you need more
  than one machine can do, see "Beyond one instance" below.

**How much one instance can do.** The relay only parses, stamps and forwards
small JSON messages. A synthetic run on a 4-vCPU 2.1 GHz Xeon VM (loopback, no
TLS, every peer sending real lockstep-shaped traffic at 10 Hz):

| Load | Messages in / out per second | Server CPU (one core) | Memory |
|---|---|---|---|
| 250 two-player rooms (500 connections) | 5.8k / 5.9k | ~10% | ~90 MB |
| 100 six-player rooms (600 connections) | 7k / 35k | ~22% | ~90 MB |
| 1000 two-player rooms (2000 connections) | 20k / 21k | ~27% | ~120 MB |
| 333 six-player rooms (2000 connections) | 20k / 96k | ~38% | ~130 MB |

So the default caps (2000 connections, 500 rooms) fit a small instance
(1 shared vCPU, 512 MB) with room to spare. Treat these as an order of
magnitude, not a promise: real networks, TLS at the proxy and your host's CPU
all differ. Watch `/api/stats`, CPU and memory, and raise `MAX_CONNECTIONS` /
`MAX_ROOMS` only after you have seen real numbers. Static file traffic is
light after the first visit (hashed assets are cached "immutable", everything
else revalidates with ETags).

**Latency** is what players feel. Lockstep waits for the slowest peer every
tick, and every message makes two hops (peer → relay → peer). Host the server
in the region where most players are; the lobby's delay setting (2 ticks on a
LAN, 4 online) trades input latency for smoothness.

**Beyond one instance** (not implemented — options, in order of effort):

1. *Scale up* first: the relay is single-threaded, so a faster core helps more
   than more cores.
2. *Regional servers:* run independent deployments (`eu.example.com`,
   `us.example.com`), each with its own rooms, and let players pick. Give all
   of them the same `LICENSE_SECRET` so one key works everywhere; revocations
   then need to be applied to each (or share the ledger file).
3. *Room-affinity routing:* several relay instances behind a router that sends
   every connection of a room to the same instance (for example by encoding
   the instance in the room code, or with Fly's `fly-replay`). This needs code
   in the relay (room-code namespaces) and in the client's join path.
4. *Split static from relay:* put the client on a CDN/static host (section c)
   so the relay box only relays.

---

## (f) Security notes

What the server does:

* **Transport.** It speaks plain HTTP; TLS is the proxy's job. With an
  `https://` `PUBLIC_URL` it sends HSTS. Never expose port 8790 directly on
  the internet for a paid deployment: license keys travel in WebSocket
  messages and must be encrypted in transit.
* **Static files.** Paths are decoded and validated, must resolve inside
  `WEB_ROOT` (symlinks included), and dotfiles are never served. Only `GET`
  and `HEAD`.
* **Browser hardening.** A strict Content-Security-Policy (scripts: same
  origin plus the exact hashes of the page's inline scripts — no
  `unsafe-inline`, no `eval`; connections: same origin, the relay and the API),
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `frame-ancestors 'self'` / `X-Frame-Options`, `Cross-Origin-Opener-Policy`,
  a `Permissions-Policy`.
  Consequence: a relay address typed into the multiplayer menu that is not this
  server is blocked by the browser. Allow more with
  `CSP_EXTRA="connect-src wss://other.example.com"`.
* **Relay abuse limits.** 64 KiB message cap; per-connection message and byte
  rate limits (exceeding them disconnects — silently dropping lockstep
  messages would desync a match); caps on rooms, connections and connections
  per address; wrong-room-code throttling; sockets that never join, stop
  answering pings or stop reading are dropped; idle rooms are closed. Malformed
  input is ignored and can never crash the process.
* **The relay is a dumb pipe.** It stamps the sender's slot on every message
  (a client cannot impersonate another slot) but does not inspect game
  messages. It cannot stop a modified client from sending illegal commands;
  the simulation validates commands on every peer, and state checksums freeze
  a match that diverges. There is no anti-cheat beyond that (a lockstep peer
  necessarily knows the whole game state — maphacks are possible in any
  lockstep RTS).
* **Room codes** are 4 characters (1.7 million combinations) and are the only
  thing protecting a private room. Guessing is throttled per address
  (`JOIN_FAILS_PER_MIN`), not impossible. Public rooms (`/api/rooms`) publish
  their code on purpose.
* **Player-supplied text** (names, chat, room titles) is relayed as data. The
  relay strips control characters from names/titles and caps their length; the
  client must (and does) render them as text, never as HTML.
* **Logs** contain client IP addresses (for abuse handling) and never contain
  license keys, Stripe secrets, session ids or e-mail addresses. Mention the
  IP logging in your privacy policy and set a retention period on your log
  platform.
* **Secrets** come from the environment only. Weak or missing secrets disable
  the feature they belong to; nothing runs with a default secret. Do not
  commit `.env` files (`.gitignore` already excludes `.env` and `data/`).
* **Admin endpoint.** Disabled without a strong `ADMIN_TOKEN`; five wrong
  tokens lock the calling address out for minutes. Treat the token like a
  password, call the endpoint only over HTTPS, and rotate it by changing the
  variable.
* **Uncaught errors** are logged and the process keeps running (crashing would
  end every match). Watch the logs for `uncaught.exception`.

What you still have to do:

* Keep Node and `ws` updated (`npm audit`, rebuild the image).
* Put the server behind TLS and set `TRUST_PROXY`.
* Back up `DATA_DIR` if you sell keys.
* DDoS protection at the network level is the platform's job (Cloudflare, Fly,
  Render); the limits above only bound what a single connection or address can
  cost.

---

## Relay protocol

JSON text messages `{t:'…', …}`; the same wire protocol as
`tools/mca_relay.py`, plus the optional additions listed below.

| Client sends | Relay answers |
|---|---|
| `{t:'create', name}` | `{t:'room', code, slot:0, host:true}`, then `{t:'lobby', slots:[{slot,name}…]}` |
| `{t:'join', code, name}` | `{t:'room', code, slot, host:false}`; everyone in the room gets `{t:'lobby', …}`. Errors: `{t:'error', reason:'no-such-room'\|'room-full', code}` |
| `{t:'leave'}` | the socket is closed; the others get `{t:'bye', slot, reason:'disconnected'}` and a new `lobby` |
| `{t:'ping', ts}` | `{t:'pong', ts}` (also before joining) |
| anything else, inside a room | relayed to the other members with `from:<sender slot>`; with `to:<slot>` only to that member; with `echo:true` (and no `to`) also back to the sender |

Room codes: 4 characters from `A–Z0–9`, case-insensitive. Up to 6 slots; the
lowest free slot is assigned. The creator is the host (slot 0); when the host
leaves the room closes and the others get `{t:'bye', slot:0, reason:'host-left'}`.

Additions (optional; old clients never see or need them):

* `create` may carry `public:true, title, map` — the room is then listed by
  `GET /api/rooms` as `{code, title, map, players, max}` until it is full or
  its match has started. The listed map follows the host's `cfg` messages.
* `create`/`join` may carry `license:<key>`; required when `MCA_PAYWALL` is
  `multiplayer` or `full`.
* Any room broadcast may carry `echo:true` (exactly `true`): the relay then
  also returns it to its sender — the same envelope, with the relay-stamped
  `from`, at the same point of the room's message order as everyone else's
  copy. It is how a peer learns where its own message landed relative to the
  others'. Messages addressed with `to` are never echoed, and an echoed
  message counts against the sender's rate limits exactly once, like any
  other. The game uses it for one thing: the host's `drop` declaration (see
  below) takes effect when it comes back, so that the host stops listening
  to the dropped player at the same point of the stream as every other peer.
  Against a relay without echo (the Python one) the client falls back to
  applying its declaration locally after 2.5 s.
* `error` envelopes carry a human-readable `message` next to `reason`. New
  reasons: `license-required`, `license-invalid`, `license-revoked`,
  `license-in-use`, `server-full`, `too-many-connections`, `too-many-attempts`,
  `rate-limited`, `already-in-room`, `idle-timeout`, `room-idle`,
  `server-shutdown`.

Deliberate differences from the Python relay (none affect a well-behaved client):

| Situation | Python relay | This server |
|---|---|---|
| `create`/`join` sent while already in a room | relayed to the room like any message | answered with `error: already-in-room`, never relayed (the envelope may contain a license key) |
| Messages after the host left | the remaining peers keep relaying to each other in a "ghost" room | the room is gone; the sockets stay open and may `create`/`join` again |
| `to` that is not an integer (`true`, `"1"`, `null`) | `true`/`false` address slots 1/0; others dropped | all dropped |
| `name` that is not a string | the connection crashes | default name `P<slot+1>` |
| Control characters in names | kept | removed |
| A peer whose socket cannot be written | `bye` with reason `send-failed` | the socket is terminated; `bye` with reason `disconnected` |
| Limits (size, rate, caps, idle) | none | as listed above |

`GET /api/stats` → `{online, rooms, publicRooms, inMatch, connections}`.

**What the game sends through it.** The relay looks at none of this (it only
reads the host's `cfg`/`start` to keep the public room list current); the
list is here so that traffic in a capture or a log makes sense.

| Phase | Message | Meaning |
|---|---|---|
| lobby | `slot` (guest → host), `lobby2`, `cfg`, `start` (host) | faction/team/ready, the merged lobby, match settings (map, seed, input delay, players), go |
| match | `cmd {tick, slot, seq, cmd}` | a player command, stamped for a future tick (current tick + input delay) |
| match | `eoi {tick}` | end-of-input marker: "you now hold every command I will ever send for ticks ≤ `tick`". A tick runs only when every player's marker covers it. Cumulative, so a lost one is repaired by the next; a peer that is waiting re-sends its latest every 500 ms |
| match | `csum {tick, sum}` | state checksum every 25 ticks; a mismatch freezes the match (desync) |
| match | `drop {slot, at, echo:true}` (host) | a player who disconnected, or was silent for 8 s (45 s if it never started), is replaced by an AI from tick `at`; that player's commands count below `at` only |
| any | `pause {on}` (host), `chat {msg}`, `nping`/`npong {ts}` | pause/resume, chat, peer-to-peer round-trip probes |
| match | `needlog {fromTick}`, `log {cmds}` | command-log request and reply (catch-up; not used by the shipped client flow) |

(`stall`, the pre-1.0 name of the per-tick message, is still understood by
the client as an `eoi`.)

---

## Tests

```bash
node --test server/test/                 # whole server suite, one process
node --test "server/test/*.test.mjs"     # same tests, one process per file
node --test server/test/relay.test.mjs   # a single file
```

(`node --test server/test/` works because Node 22 resolves the directory to
`server/test/index.js`, which imports every test file.)

What is covered: relay protocol conformance and every limit; static hosting
(path traversal, caching, compression, ranges, fallback, security headers);
`/config.js`, `/healthz`; license tokens and the ledger; Stripe signature
verification; the complete purchase flow against a local Stripe mock
(checkout → webhook → claim → verify → relay join → refund); the paywall; the
admin endpoint; CORS; the client's `net.js`/`store.js`; process start-up and
shutdown; and **headless lockstep matches through the real relay** using the
real client networking (`net.js`), scheduler (`lockstep.js`) and simulation,
plus `main.js`'s own drop logic (`hostDropWatch`, `processPendingDrops`,
lifted from its source and run as it is). Tests listen on
`127.0.0.1:8800–8899`.

The lockstep tests (`server/test/lockstep.e2e.test.mjs`) run on a virtual
clock, with a relay ping/pong barrier deciding what has arrived where, so
their outcome does not depend on the speed of the machine:

* whole matches: 2 humans + AI for 600 ticks with every checksum compared; a
  desync negative control; a mid-match disconnect with AI takeover; 6 players
  at real-time pace under the default rate limits;
* a missing peer holds the room (nothing is forced; the old "force after
  1.5 s" rule is shown to desync in the same scenario) and waiting peers keep
  each other informed with keepalives;
* drops: disconnect with orders in flight while the remaining peers sit on
  different ticks; a drop line cutting through those orders; the silence
  timeout, the loading grace, a peer that never starts; bystanders and
  returning peers that are *not* dropped; pause/resume longer than the
  timeout, with and without latency;
* the timeout race (the silent peer speaks again while the host's verdict is
  on its way), on both sides of the relay's ordering;
* several orders for one tick (a frame apart; a backlogged receiver), a
  client sending commands for ticks it already closed, lost markers (one, and
  all of them until the room is stuck);
* latency on every link: input delay 2 at 150 ms and delay 4 at 350 ms run at
  the full 10 Hz without a single gate wait after start-up; delay 2 at 250 ms
  (beyond the budget) is shown to slow the room down, in sync.

Scenarios the client does not handle yet are kept as `todo` subtests: they
are reported (`# todo N` in the summary) without failing the run.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Could not reach relay…" on a deployed site | The page is `https://` but the relay URL is `ws://`; or the proxy does not forward WebSocket upgrades; or `ALLOWED_ORIGINS` is set and does not include the site. |
| Players get `too-many-connections` | `TRUST_PROXY` is not set behind a proxy (look for the `proxy.untrusted` warning in the logs), or many players really share one address — raise `MAX_CONNS_PER_IP`. |
| `Relay error: license-required` | `MCA_PAYWALL` is on and the player has no key stored. They open **Support / Founder's Pass** and buy or redeem. |
| Store says "Purchases are not available in this build" | The server has no complete Stripe configuration. The boot log lists exactly what is missing (`feature.off`). |
| `license.disabled … EACCES` in the logs | `DATA_DIR` is not writable by the `node` user (volume mounted as root). Build the image with `--build-arg RUNTIME_USER=root` (`fly.toml` and `render.yaml` already ask for this; if your platform ignores it, run the container as root — the entrypoint drops to `node` by itself). |
| Server exits at start with "invalid configuration" | Read the list it prints. Typical: `MCA_PAYWALL` set without `LICENSE_SECRET`. |
| A custom relay address typed into the menu does not connect | Blocked by the page's Content-Security-Policy. Add it with `CSP_EXTRA="connect-src wss://that.host"`. |
| Blank page, console shows CSP errors | Something in the client needs a source the policy does not allow. Run with `CSP_REPORT_ONLY=1` to confirm, then extend with `CSP_EXTRA`. |
