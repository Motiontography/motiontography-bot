# Motiontography website chat

The Cloudflare worker keeps the existing widget contract, origin checks, rate limits, leads and unanswered-question inbox. Answers now come from the authenticated booking-app `/api/website-chat` endpoint using the existing worker `ADMIN_TOKEN` / app `BOT_ADMIN_TOKEN` pair. No new secret is required.

The booking app uses GPT-6 Luna with current package and recommendation-rule records, canonical editing policy, bounded signed conversation history, no provider-side conversation storage, a 12-second model deadline, and the existing essential-client-service spending reserve. Unknown holiday sets, dates, existing purchases and special arrangements go to Roger. It never books, charges, or promises a callback. A gateway outage returns contact options and stores the question for review; it never falls back to old prices in the generated June knowledge base.

Deploy the tested booking-app endpoint first, then `npx wrangler deploy` here, then the tested marketing widget. Verify `/api/health` and a Christmas question plus a follow-up. Roll back the worker to its prior deployment if the gateway is unavailable. Existing generated KB files and legacy helper exports remain for rollback; the chat handler does not use them.

`npm test` covers the gateway, failure behavior, CORS, validation and legacy helpers. Credentials must never appear in test output.

## Deployment account record (verified 2026-10-03)

- Cloudflare account ID: `e8fa03c1fd0bcf7273c0c0a85c314f58`.
- Worker name: `motiontography-bot`.
- Workers subdomain: `vanzandt2030.workers.dev` (a subdomain, not proof of a login email).
- Production: https://motiontography-bot.vanzandt2030.workers.dev
- Dashboard: https://dash.cloudflare.com/e8fa03c1fd0bcf7273c0c0a85c314f58/workers/services/view/motiontography-bot/production
- Connected repository: `Motiontography/motiontography-bot`. Cloudflare Workers Builds publishes branch previews; verify the main-branch deployment result and production health before claiming release.
- Verified account display name: **Vanzandt2030@gmail.com's Account**.
- Verified signed-in user: **fstop@motiontography.com**. This user can access the account above after selecting it in the account switcher; verified against the actual Worker dashboard and deployment history on 2026-10-03.
- The separate **Fstop@motiontography.com's Account**, ID `7fbf5f247ae98cc4f80df30c2d64d32a`, is not the Worker host. Select **Vanzandt2030@gmail.com's Account**; do not confuse the signed-in user with the selected account or deploy a duplicate Worker.
- Existing CLI OAuth session was expired. No new Wrangler access was granted in that other account.

Recheck the selected account ID before future deployments. Never store passwords, API tokens, OAuth codes, or refresh tokens in project documentation.
