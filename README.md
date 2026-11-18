# AtomConnect

P2P messenger with chat, voice and adaptive video, built on WebRTC and Cloudflare.

See [FEASIBILITY.md](FEASIBILITY.md) for the design study.

## Layout

| Path | What |
|---|---|
| `server/` | Cloudflare Worker: WebRTC signaling (one Durable Object per room), TURN credential minting (`/ice`), session registry and admin API (`/admin/api/*`) |
| `client/public/` | Static web client (`index.html`) and admin dashboard (`admin.html`), served as Workers assets |
| `scripts/cf-usage.sh` | Checks Cloudflare Free-plan usage (Workers requests, Durable Objects, TURN egress) |

## Setup

Requires Node.js and a Cloudflare account (Free plan works).

```bash
cd server
npm install
cp wrangler.example.jsonc wrangler.jsonc   # then fill in TURN_KEY_ID and CF_ACCOUNT_ID
npx wrangler login
```

Secrets are never stored in the repo; set them with Wrangler:

```bash
npx wrangler secret put TURN_API_TOKEN   # Cloudflare Realtime TURN API token (without it, STUN only)
npx wrangler secret put ADMIN_TOKEN      # bearer token for the admin dashboard (required, else admin returns 503)
npx wrangler secret put CF_API_TOKEN     # optional, Account Analytics: Read, for the usage panel
```

## Run and deploy

```bash
cd server && npm run dev        # local signaling server
cd server && npm run deploy     # deploy the Worker
cd client && npx wrangler deploy  # deploy the static client
```

## Usage check

```bash
CF_ACCOUNT_ID=<your account id> scripts/cf-usage.sh [--notify]
```

## Notes

- 1:1 calls only for now (`MAX_PEERS = 2`); group calls would need an SFU.
- `server/wrangler.jsonc`, `.wrangler/`, `logs/` and `.dev.vars` are git-ignored.
