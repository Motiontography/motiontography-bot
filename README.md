# Motiontography website chat

The Cloudflare worker keeps the existing widget contract, origin checks, rate limits, leads and unanswered-question inbox. Answers now come from the authenticated booking-app `/api/website-chat` endpoint using the existing worker `ADMIN_TOKEN` / app `BOT_ADMIN_TOKEN` pair. No new secret is required.

The booking app uses GPT-6 Luna with current package and recommendation-rule records, canonical editing policy, bounded signed conversation history, no provider-side conversation storage, a 12-second model deadline, and the existing essential-client-service spending reserve. Unknown holiday sets, dates, existing purchases and special arrangements go to Roger. It never books, charges, or promises a callback. A gateway outage returns contact options and stores the question for review; it never falls back to old prices in the generated June knowledge base.

Deploy the tested booking-app endpoint first, then `npx wrangler deploy` here, then the tested marketing widget. Verify `/api/health` and a Christmas question plus a follow-up. Roll back the worker to its prior deployment if the gateway is unavailable. Existing generated KB files and legacy helper exports remain for rollback; the chat handler does not use them.

`npm test` covers the gateway, failure behavior, CORS, validation and legacy helpers. Credentials must never appear in test output.
