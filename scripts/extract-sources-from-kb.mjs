#!/usr/bin/env node
/**
 * One-time extraction: split motiontography_kb.json (v2.0) into curated
 * source files under data/source/, applying the two approved corrections:
 *   1. Every booking destination (Square widgets, booking.html CTAs) is
 *      rewritten to the live Railway booking app.
 *   2. The studio street address is redacted (city-level only).
 * Nothing else is invented or altered — values are carried over verbatim.
 *
 * Run once: node scripts/extract-sources-from-kb.mjs
 * After this, data/source/* is the hand-curated truth and build-kb.mjs
 * regenerates motiontography_kb.json from it (+ live pricing API).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BOOKING_APP_URL = "https://motiontography-pwa-production.up.railway.app/app/booking";

const kb = JSON.parse(readFileSync(join(root, "motiontography_kb.json"), "utf8"));
if (kb.kb_version !== "2.0.0") {
  console.error(`Expected KB v2.0.0, found ${kb.kb_version}. Aborting to avoid clobbering curated sources.`);
  process.exit(1);
}

/** Rewrite any Square widget URL or booking.html booking CTA to the live booking app. */
function rewriteBookingUrls(value) {
  if (typeof value === "string") {
    return value
      .replaceAll(/https:\/\/app\.squareup\.com\/appointments\/buyer\/widget\/[A-Za-z0-9/]+/g, BOOKING_APP_URL)
      .replaceAll("https://motiontography.com/booking.html", BOOKING_APP_URL);
  }
  if (Array.isArray(value)) return value.map(rewriteBookingUrls);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewriteBookingUrls(v)]));
  }
  return value;
}

// ---- business (address redacted) ----
const business = structuredClone(kb.business);
business.studio.address = "Private Suffolk, VA studio — exact address is shared after your booking is confirmed";

// ---- official pages: booking action -> app; keep the bridge page reachable as package info ----
const officialPages = structuredClone(kb.official_pages);
officialPages.booking_page_url = BOOKING_APP_URL;
officialPages.packages_info_url = "https://motiontography.com/booking.html";
officialPages.pricing_page_url = "https://motiontography.com/pricing.html";

// ---- booking links: keep the key/shape the deployed worker requires, values -> booking app ----
const bookingLinks = rewriteBookingUrls(kb.square_booking_links);

// ---- intents: rewrite booking URLs inside answers and routes ----
const intents = rewriteBookingUrls(kb.intents_and_answers);

const out = {
  "business.json": business,
  "official-pages.json": officialPages,
  "booking-links.json": bookingLinks,
  "wedding.json": rewriteBookingUrls(kb.wedding_packages),
  "boudoir.json": rewriteBookingUrls(kb.boudoir_info),
  "onlocation.json": rewriteBookingUrls(kb.on_location_info),
  "editing-levels.json": kb.editing_levels,
  "add-ons.json": kb.add_ons,
  "packages-curated.json": kb.packages,
  "policies.json": {
    booking_policies: kb.booking_policies,
    client_experience_guidelines: kb.client_experience_guidelines,
    tone_and_messaging_rules: kb.tone_and_messaging_rules,
  },
  "guardrails.json": {
    bot_guardrails: rewriteBookingUrls(kb.bot_guardrails),
    learning_and_review_workflow: kb.learning_and_review_workflow,
  },
  "intents.json": intents,
  "booking-routes.json": {
    booking_app_url: BOOKING_APP_URL,
    packages_bridge_page: "https://motiontography.com/booking.html",
    pricing_page: "https://motiontography.com/pricing.html",
    contact_page: "https://motiontography.com/contact.html",
    website: "https://motiontography.com",
    phone: kb.business.primary_phone,
    admin_note: "The booking/admin app admin route is private. Never reference it in any public output.",
  },
};

const dir = join(root, "data", "source");
mkdirSync(dir, { recursive: true });
for (const [file, data] of Object.entries(out)) {
  writeFileSync(join(dir, file), JSON.stringify(data, null, 2) + "\n");
  console.log(`wrote data/source/${file}`);
}
console.log("Extraction complete. Review diffs, then use scripts/build-kb.mjs from now on.");
