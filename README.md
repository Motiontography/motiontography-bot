# Motiontography Website Assistant (Bot v3)

Cloudflare Worker powering the chat widget on [motiontography.com](https://motiontography.com).
Live at `https://motiontography-bot.vanzandt2030.workers.dev`.

## How it works

- **Grounded answers**: every reply is generated from `motiontography_kb.json` (this repo, fetched from GitHub main with a 5-minute cache). The model may not state facts that aren't in the KB; unknowns escalate to Roger (call/text 757-759-8454 or the contact page).
- **Model**: OpenAI Responses API. The model is set by the `OPENAI_MODEL` Cloudflare variable (currently `gpt-5.5`) — change it in the dashboard, no deploy needed. Multi-turn memory via `previous_response_id`.
- **Never goes dark**: if OpenAI is unreachable, a keyword-intent fallback answers from the same KB.
- **Booking**: all booking intent routes to the live booking app — `https://motiontography-pwa-production.up.railway.app/app/booking`.
- **Safety**: untrusted-input delimiters, JSON output contract, code-level URL allowlist (the bot can only ever link to motiontography.com properties and the booking app), street-address scrubbing, CORS origin allowlist, per-IP rate limiting (10/min).
- **Leads**: messages containing contact details are stored in KV (`lead:*`); unanswerable questions are stored as `unanswered:*` for FAQ review.

## Knowledge base pipeline (single source of truth)

```
data/source/*.json   (curated facts — edit these, never the generated KB)
        │
        ▼
npm run build:kb     (also pulls LIVE package pricing from the booking app API;
        │             fails closed if the API is down or data looks wrong)
        ▼
motiontography_kb.json            → live bot picks it up ≤5 min after `git push`
dist/site/motiontography_kb.json  → copy for the static website root
```

- `npm run check` — warns if booking.html / pricing.html prices drift from the live API.
- Pricing is **never hand-typed**: the booking app's admin-edited database is the truth.
- To change packages/prices: edit them in the booking app admin, then `npm run build:kb && git push`.
- To change policies/FAQ/intents: edit `data/source/*.json`, then `npm run build:kb && git push`.

## Endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/health` | none | version, KB version, model |
| `POST /api/chat` | none (rate-limited, origin-allowlisted) | `{message, session_id, previous_response_id?}` → `{ok, reply, response_id, followups, route_url}` |
| `GET /api/admin/leads` | `Authorization: Bearer <ADMIN_TOKEN>` | captured leads (newest first, `?limit=`) |
| `GET /api/admin/unanswered` | `Authorization: Bearer <ADMIN_TOKEN>` | unanswered questions for FAQ review |

## Deploy

KB-only changes: just `git push` (the worker fetches from GitHub main).

Code changes:
```sh
npx wrangler login                                  # once
npx wrangler kv namespace create BOT_STORE          # once; paste id into wrangler.toml
npx wrangler secret put OPENAI_API_KEY              # once / on rotation
npx wrangler secret put ADMIN_TOKEN                 # once; generate with: openssl rand -hex 32
npx wrangler deploy
```
No wrangler? Paste `worker.js` into the Cloudflare dashboard (Workers → motiontography-bot → Edit code) and set the vars/secrets/KV binding in Settings. Rollback: Workers → Deployments → roll back.

## Tests

`npm test` — 22 unit tests over CORS, validation, URL filtering, address scrubbing, keyword fallback, lead detection, and prompt construction.

## Legacy

`server.js` + `lib/openai.js` are the old Express/local variant (v2), kept for reference. The Worker is the production system.
