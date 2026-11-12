# MCA monetization: Founder's Pass, Stripe, license keys

**Status in one paragraph.** The payment integration is complete and tested
against a simulated Stripe, and it is **switched off** until you supply your
own Stripe keys. No Stripe account exists for this project yet, so nothing here
has ever talked to the real Stripe API or moved real money. Until it is
configured, the server answers every payment request with "purchases are not
available" and the in-game store says the same. Turning it on is a
configuration task (the checklist below) plus legal/tax groundwork that only
you — the seller — can do.

Contents: [The model](#the-model) · [Paywall modes and their real limits](#paywall-modes-and-their-real-limits) ·
[Stripe setup checklist](#stripe-setup-checklist) · [How a purchase works](#how-a-purchase-works) ·
[License keys](#license-keys) · [Key operations](#key-operations-admin-endpoint) ·
[Refunds and disputes](#refunds-and-disputes) · [Legal and tax](#legal-and-tax-what-you-must-supply) ·
[Other storefronts](#other-storefronts) · [What is and is not verified](#what-is-and-is-not-verified)

---

## The model

* The base game is **free to play**.
* One product, bought once: the **Founder's Pass** (name and displayed price
  are configurable: `PRODUCT_NAME`, `PRICE_LABEL`).
* Buying it yields a **license key** — a signed token stored in the buyer's
  browser and shown to them so they can keep it. The key can be redeemed in
  any browser.
* What the pass unlocks is one setting, `MCA_PAYWALL`.

There are no accounts, no subscriptions, no stored card data, no e-mails sent
by this server.

## Paywall modes and their real limits

| `MCA_PAYWALL` | What is gated | Who enforces it | How strong it is |
|---|---|---|---|
| `off` (default) | Nothing. The pass is a supporter purchase: it funds development and unlocks nothing. The store says so in those words. | – | – |
| `multiplayer` | Hosting and joining online rooms **on your server**. | The relay: `create`/`join` without a valid, unrevoked key is refused with `license-required` / `license-invalid` / `license-revoked`. | **Real.** The check runs on the server; a modified client cannot bypass it. |
| `full` | The whole game: the client shows a purchase gate that cannot be dismissed until a key is redeemed. The relay also requires a key. | The gate: the client itself. Multiplayer: the relay. | **Multiplayer: real. Single-player: a courtesy lock only** — see below. |

**Why `full` cannot truly lock single-player.** The game is a static web
client: every visitor's browser downloads all of the game's code and data
before any gate appears. The gate is JavaScript running on the visitor's
machine; anyone can skip it with the browser's developer tools, or download
the files and run them elsewhere. No setting changes that. Really locking the
game would mean *not sending the game* to people who have not paid — serving
the client bundle only to requests that present a valid key, or moving
essential logic to the server. Neither is implemented. `full` therefore stops
honest visitors and casual sharing, and nothing more. If you need real
protection, the practical options are `multiplayer` (which genuinely protects
the online part) or selling a downloadable build through a store (below).

Also note, for `multiplayer`:

* A key is a bearer token. Someone who has a copy can use it. Each key is
  limited to `MAX_CONNS_PER_LICENSE` (default 3) simultaneous sessions, and a
  leaked key can be revoked (below) — its owner then needs a new one.
* Only *your* relay enforces it. Players can still run their own relay
  (`tools/mca_relay.py` is in the repository) and play each other for free.
  You are selling access to your hosted service, not the ability to play.
* A key is not sent to relays other than the one named in the client's
  configuration.
* Starting the server with `MCA_PAYWALL` on but without a usable
  `LICENSE_SECRET` is refused (it would either lock everyone out or give the
  game away).

## Stripe setup checklist

Do everything in **test mode** first; switch to live keys only after a full
test purchase and a test refund have worked.

1. **Create a Stripe account** and complete the business profile (Stripe needs
   this before live payments).
2. **Create the product.** Product catalogue → add a product ("Founder's
   Pass") with a **one-time** price. Copy the price id (`price_…`) →
   `STRIPE_PRICE_ID`.
3. **API key.** Developers → API keys → secret key (`sk_test_…`) →
   `STRIPE_SECRET_KEY`. Better: create a *restricted* key (`rk_…`) limited to
   Checkout Sessions (write) and PaymentIntents + Charges (read) — that should
   be all this server uses; confirm with a test purchase.
4. **Webhook endpoint.** Developers → Webhooks → add an endpoint:
   * URL: `https://<your-domain>/api/stripe/webhook`
   * Events:
     `checkout.session.completed`,
     `checkout.session.async_payment_succeeded`,
     `charge.refunded`,
     `charge.dispute.created`,
     `charge.dispute.closed`
   * Copy the endpoint's signing secret (`whsec_…`) → `STRIPE_WEBHOOK_SECRET`.
5. **Server configuration** (all of these, or the store stays off):

   | Variable | Value |
   |---|---|
   | `STRIPE_SECRET_KEY` | from step 3 |
   | `STRIPE_PRICE_ID` | from step 2 |
   | `STRIPE_WEBHOOK_SECRET` | from step 4 |
   | `PUBLIC_URL` | the URL players open (`https://…`); Checkout returns there |
   | `LICENSE_SECRET` | 32+ random characters, e.g. `openssl rand -base64 48`. **Never change it afterwards.** |
   | `PRICE_LABEL` | what the Buy button shows, e.g. `$9.99` — keep it equal to the Stripe price |
   | `ADMIN_TOKEN` | optional but recommended (refund handling, lost keys) |
   | `DATA_DIR` | on a persistent disk |

6. **Check the boot log.** It must show `"store":true,"storeMode":"test"`. If
   not, the `feature.off` line lists exactly which value is missing or
   rejected. `GET /config.js` then shows `"storeEnabled": true`.
7. **Test purchase.** Open the game → Support / Founder's Pass → Buy. Pay with
   Stripe's test card `4242 4242 4242 4242` (any future date, any CVC). You
   should land back in the game with "Thank you" and a key. In the server log:
   `stripe.checkout.created`, `stripe.webhook … outcome:"issued"`,
   `license.issue`.
8. **Test refund.** Refund the test payment in the Stripe dashboard. The log
   shows `stripe.webhook … charge.refunded … outcome:"revoked"`; reloading the
   game removes the key ("no longer valid").
9. **Go live.** Repeat steps 2–4 in live mode (live price id, live key, a live
   webhook endpoint with its own signing secret), replace the three variables,
   redeploy, and make one real purchase and refund yourself.

Local testing without a public URL: the Stripe CLI can forward webhooks —
`stripe listen --forward-to localhost:8790/api/stripe/webhook` prints a
`whsec_…` secret to use as `STRIPE_WEBHOOK_SECRET` (test keys may use an
`http://localhost` `PUBLIC_URL`; live keys require `https://`).

Things this integration deliberately does **not** do: promotion codes
(not enabled on the Checkout Session), multiple products, subscriptions,
e-mailing keys. Tax calculation is off unless you set `STRIPE_AUTOMATIC_TAX=1`
*and* have configured Stripe Tax.

## How a purchase works

```
browser                         your server                         Stripe
   |  click Buy                      |                                 |
   |-- POST /api/checkout ---------->|-- create Checkout Session ----->|
   |<------------- { url } ----------|<------------ session ----------|
   |-- redirect to Stripe's hosted payment page ---------------------->|
   |                                 |<-- webhook checkout.session.completed (signed)
   |                                 |    verify signature, issue license (ledger)
   |<-- redirect back: PUBLIC_URL/?session_id=cs_… --------------------|
   |-- GET /api/license/claim?session_id=cs_… -->|
   |                                 |  (if the webhook has not arrived yet:
   |                                 |   ask Stripe whether the session is paid)
   |<------------ { token } ---------|
   |  key stored in the browser, shown to the buyer, URL cleaned
```

Properties worth knowing:

* **No card data touches your server.** The buyer pays on Stripe's page.
* The price, the product and the return URLs are fixed by the server; nothing
  the browser sends reaches Stripe.
* Webhooks are verified exactly as Stripe specifies (HMAC-SHA256 over
  `timestamp.raw-body` with the endpoint secret, 5-minute tolerance,
  constant-time comparison). Unsigned, stale or altered events are rejected.
* Everything is idempotent: Stripe may deliver an event several times and the
  buyer may reload the return page; one payment yields exactly one key.
* Delayed payment methods (bank debits…): no key until Stripe reports the
  money as received; the store shows "payment has not completed yet" with a
  "Check again" button.
* Only Checkout Sessions created by this server for this product are honoured
  (a metadata marker); other payments on the same Stripe account are ignored.
  A live-mode event is never honoured by a test-mode server and vice versa.
* If the buyer closes the tab on Stripe's page after paying, the key is still
  issued (by the webhook) but they never see it. See "A buyer lost their key".

### API reference

| Route | Purpose | When disabled |
|---|---|---|
| `POST /api/checkout` → `{url}` | start a purchase (rate-limited per address) | 503 `store-disabled` |
| `POST /api/stripe/webhook` | Stripe → server events (signature required) | 503 |
| `GET /api/license/claim?session_id=…` → `{ok, token, license}` | fetch the key for a paid session. 402 not paid yet · 404 unknown · 410 refunded/disputed | 503 |
| `POST /api/license/verify` `{token}` → `{valid, reason?, license?}` | check a key (used by "Redeem") | 503 `licensing-disabled` |
| `GET /api/license/pubkey` | the public key keys are signed with | 503 |
| `POST /api/admin/license` | mint / revoke / reinstate / lookup / list (bearer `ADMIN_TOKEN`) | 503 `admin-disabled` |

The API is same-origin by default. A separately hosted client needs its origin
in `ALLOWED_ORIGINS` (see ONLINE.md). The webhook and admin routes are never
open to cross-origin browsers.

## License keys

A key looks like `MCA1.<payload>.<signature>` (about 240 characters).

* **Signed, not stored.** The payload (license id, product id, issue time,
  source, and — if known — a keyed hash of the buyer's e-mail) is signed with
  Ed25519. The signing key is derived from `LICENSE_SECRET`; only your server
  can create keys, anyone with the public key can check one.
* **No personal data.** No name, no e-mail, no payment id. The e-mail hash is
  keyed with a secret derived from `LICENSE_SECRET`; it cannot be reversed or
  tested against a list of addresses without that secret. It exists so that
  *you* can find a buyer's key by e-mail (below).
* **The ledger.** `DATA_DIR/licenses.jsonl` records every issued key and every
  revocation, one JSON line each, append-only, flushed to disk before the
  operation is confirmed. It contains no keys, e-mails or Stripe ids in
  readable form. **Back it up**, and keep it on persistent storage:
  * if the ledger is lost, all issued keys still verify (the signature is
    enough), but **revocations are forgotten** — refunded keys work again;
  * if `LICENSE_SECRET` is lost or changed, **every key becomes invalid** and
    cannot be recreated. Store the secret in a password manager.
* **Where the buyer's key lives.** In their browser's local storage, and
  wherever they saved the copy the store showed them. Clearing site data
  removes it; redeeming it again restores it.
* Keys do not expire.

## Key operations (admin endpoint)

Enabled when `ADMIN_TOKEN` is set (24+ random characters). Always call it over
HTTPS. Examples use `$URL=https://your-domain` and `$TOKEN`.

```bash
# mint keys (gifts, press, backers, another storefront's buyers): 1–100 per call
curl -sS -X POST "$URL/api/admin/license" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"mint","count":25,"note":"itch.io batch 2026-03"}'
# -> {"ok":true,"licenses":[{"id":"lic_…","token":"MCA1.…"}, …]}

# mint one key tied to a buyer's e-mail (so it can be looked up later)
  -d '{"action":"mint","email":"buyer@example.com","note":"manual sale"}'

# a buyer lost their key: find it by the e-mail they paid with
  -d '{"action":"lookup","email":"buyer@example.com"}'

# revoke (leaked key, chargeback handled outside Stripe) / undo
  -d '{"action":"revoke","id":"lic_…","reason":"leaked"}'      # or "token":"MCA1.…"
  -d '{"action":"reinstate","id":"lic_…"}'

# overview (never returns keys)
  -d '{"action":"list","offset":0,"limit":100}'
```

**A buyer lost their key** (or never saw it): ask for the e-mail address used
at checkout, run `lookup`, send them the `token`. If lookup finds nothing (they
paid with a different address), find the payment in the Stripe dashboard to
confirm it, then `mint` a replacement with their e-mail and a note. Put a
support address in your Stripe receipt/branding settings so buyers know where
to ask — this server does not send e-mail.

**A key was leaked/shared:** `revoke` it and `mint` a replacement for the
rightful owner.

Wrong admin tokens are throttled per address (five failures, then one attempt
per minute). Rotate the token by changing the variable and redeploying.

## Refunds and disputes

| Event | What the server does |
|---|---|
| Full refund (`charge.refunded`, fully refunded) | The key is revoked. The relay refuses it; the buyer's browser drops it at the next load; a new claim answers 410. |
| Partial refund | Nothing — the key stays valid. Revoke manually if you want to. |
| Dispute opened (`charge.dispute.created`) | The key is revoked. |
| Dispute won (`charge.dispute.closed`, status `won`) | The key is reinstated (only if the dispute was the reason it was revoked). |
| Dispute lost | Stays revoked. |
| Refund issued before any key was claimed | No key will ever be issued for that payment. |

Refund *decisions* are yours and are made in the Stripe dashboard; the server
only follows the events. Revocation takes effect for new sessions; a match in
progress is not interrupted. Revocations depend on the webhook being
delivered: keep the endpoint healthy (Stripe shows failed deliveries and
retries for days) and the ledger persistent.

## Legal and tax: what you must supply

None of this is provided by the software, and nothing in this document is
legal or tax advice. **These need you and, realistically, a professional's
review before you take real money:**

* **Terms of sale / terms of service** — what the buyer gets (a license key;
  access to your hosted multiplayer service while you operate it), what
  happens if the service ends, acceptable use, governing law.
* **Refund policy** — and it must respect consumer law where your buyers are.
  For example, EU/UK consumers have a 14-day withdrawal right for digital
  purchases unless they expressly agree to immediate delivery and acknowledge
  losing that right; other countries have their own rules.
* **Privacy policy** — you are the data controller. What this server holds:
  IP addresses in logs; a non-reversible hash of the buyer's e-mail in the
  ledger; a license key in the buyer's browser storage. Stripe holds the
  payment and customer data. The policy must say so, name Stripe as a
  processor, state retention periods, and explain how to exercise data rights.
  GDPR, UK GDPR, CCPA and others may apply depending on where players are.
* **Tax** — you are the seller of record with Stripe. Digital goods are
  subject to VAT/GST/sales tax in the *buyer's* location in many countries
  (EU VAT from the first sale, with the One-Stop-Shop scheme; UK VAT;
  US state sales tax thresholds; and more). Stripe Tax can calculate and
  collect (`STRIPE_AUTOMATIC_TAX=1` after configuring it) but registrations
  and filings remain your responsibility. If you do not want that burden, use
  a *merchant of record* instead (below).
* **Business basics** — a legal entity or sole-trader status as your country
  requires, invoices/receipts (Stripe can send receipts), contact details on
  the site (an imprint is mandatory in some countries).
* **Store copy** — the in-game store states only what is true for the current
  `MCA_PAYWALL` mode. If you promise anything more elsewhere ("supporter
  perks", future content), you are making a commitment the software does not
  fulfil by itself.
* **Age and content** — if you market to or knowingly sell to children,
  additional rules apply (COPPA, age-appropriate design codes).
* **Third-party rights** — make sure you hold the rights to everything you
  sell (art, audio, fonts, names).

Links to your terms, privacy policy and refund policy should be visible before
purchase: add them to your site and to the Stripe Checkout settings (Stripe
lets you show policy links and require agreement on the payment page).

## Other storefronts

The license system does not care where the money came from: any sale can be
turned into a key with the admin endpoint.

**itch.io** — The simplest alternative; itch.io is the storefront and payment
processor (it can also act as merchant of record for tax in many cases — check
their seller terms).
* Upload the contents of `dist/web` as an HTML5 game (see ONLINE.md), or a
  downloadable build.
* For a paid page that should unlock your *hosted* multiplayer: mint a batch
  of keys (`{"action":"mint","count":100,"note":"itch batch 1"}`) and upload
  them to itch.io as external keys handed to buyers; buyers paste the key into
  **Redeem a key** in the game. Top the batch up before it runs out.
* Refunds on itch.io do not reach this server: revoke the key by hand.

**Steam** — Steam only distributes desktop applications, so the web client
needs a wrapper (Electron, Tauri, NW.js) and a Steamworks integration; that is
a separate project (Steam Direct fee, store page review, build pipeline).
Ownership would normally be checked through Steamworks rather than these keys.
Simplest bridge if you want Steam buyers on your relay: build the wrapper with
your server in `config.js`, and give Steam buyers a key through the same
mint-a-batch route, or run a relay with `MCA_PAYWALL=off` for the Steam build.

**Merchant-of-record services** (Paddle, Lemon Squeezy, FastSpring…) — they
sell on your behalf and handle tax registration and filing, for a higher fee.
Not integrated. The integration point would be small: their "order completed"
webhook calls a little script that mints a key through `/api/admin/license`
and their "refund" webhook revokes it.

**Donations / "pay what you want"** — with `MCA_PAYWALL=off` the Founder's Pass
already is a donation with a receipt-like key. Dedicated donation platforms
(Ko-fi, GitHub Sponsors, Patreon) need no integration at all.

## What is and is not verified

Verified by the automated tests (`node --test server/test/`), against a local
stand-in for Stripe's API:

* webhook signature verification (valid, wrong secret, altered body, stale
  timestamp, malformed headers, plus one vector computed with an independent
  HMAC implementation);
* the whole flow: checkout → webhook → claim → verify → relay join, idempotent
  at every step; claim-before-webhook; delayed payments; refunds; disputes;
  out-of-order events; foreign and malformed sessions; Stripe being down;
* license keys: signing, tampering, wrong product, revocation, persistence
  across restarts, a torn ledger write;
* the paywall on the relay (`multiplayer` and `full`), the per-key session cap;
* the disabled state (503s, `storeEnabled:false`), weak-secret rejection, the
  refusal to start with an unsatisfiable paywall;
* the admin endpoint (authentication, throttling, every action), CORS;
* the store UI logic (and, by hand, the same flows in headless Chrome).

**Not verified, because it cannot be without your account:**

* any call to the real Stripe API (request format follows Stripe's documented
  API; field names in real responses and events were not observed live);
* the Stripe dashboard steps above (menu names change over time);
* real cards, 3-D Secure, delayed payment methods, real refunds and disputes;
* restricted-key permissions (step 3);
* tax behaviour.

Treat the first test-mode purchase and refund (checklist steps 7 and 8) as the
real acceptance test of this integration.
