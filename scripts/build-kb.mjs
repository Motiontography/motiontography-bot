#!/usr/bin/env node
/**
 * Build the Motiontography knowledge base from the curated sources in
 * data/source/ plus LIVE pricing from the booking app API (the admin-edited
 * database clients actually pay against — pricing is never hand-typed here).
 *
 * Emits:
 *   motiontography_kb.json        (repo root — the live worker fetches this from GitHub main)
 *   dist/site/motiontography_kb.json  (copy for the static website root)
 *
 * Fails closed: if the packages API is unreachable or returns implausible
 * data, nothing is written and the previous KB stays in place.
 *
 * Usage: node scripts/build-kb.mjs [--offline]   (--offline keeps curated pricing, for emergencies)
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "data", "source");
const PACKAGES_API = "https://motiontography-pwa-production.up.railway.app/api/booking/packages";
const KB_VERSION = "2.1.0";
const OFFLINE = process.argv.includes("--offline");

const load = (f) => JSON.parse(readFileSync(join(srcDir, f), "utf8"));

const business = load("business.json");
const officialPages = load("official-pages.json");
const bookingLinks = load("booking-links.json");
const wedding = load("wedding.json");
const boudoir = load("boudoir.json");
const onlocation = load("onlocation.json");
const editingLevels = load("editing-levels.json");
const addOns = load("add-ons.json");
const packagesCurated = load("packages-curated.json");
const policies = load("policies.json");
const guardrails = load("guardrails.json");
const intents = load("intents.json");
const routes = load("booking-routes.json");

// ---------- live pricing ----------
const normalize = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const API_NAME_TO_ID = {
  [normalize("Little Moments Mini (Kids)")]: "kids_little_moments_mini",
  [normalize("Playtime Portrait")]: "kids_playtime_portrait",
  [normalize("Event Coverage Photography")]: "event_coverage_photography",
};
const ADDON_NAME_TO_KEY = {
  [normalize("Extra Standard Image")]: "extra_standard_image_usd",
  [normalize("Extra Advanced Image")]: "extra_advanced_image_usd",
  [normalize("Creative Composite Add-On")]: "creative_composite_add_on_usd",
  [normalize("Rush Turnaround")]: "rush_turnaround_usd",
};

async function fetchLivePackages() {
  const res = await fetch(PACKAGES_API, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`packages API returned ${res.status}`);
  const json = await res.json();
  const list = json?.data;
  if (!Array.isArray(list) || list.length < 10) {
    throw new Error(`packages API returned ${Array.isArray(list) ? list.length : "no"} entries — implausible, refusing to build`);
  }
  for (const p of list) {
    if (typeof p.price_cents !== "number" || p.price_cents <= 0 || p.price_cents > 2_000_000) {
      throw new Error(`implausible price for "${p.name}": ${p.price_cents}`);
    }
  }
  return list;
}

function matchCuratedId(apiName, curatedById) {
  const n = normalize(apiName);
  if (API_NAME_TO_ID[n]) return API_NAME_TO_ID[n];
  for (const id of Object.keys(curatedById)) {
    if (normalize(curatedById[id].name) === n) return id;
  }
  return null;
}

function mergeLivePricing(curated, apiPackages) {
  const curatedById = Object.fromEntries(curated.map((p) => [p.id, p]));
  const drift = [];
  const unmatchedApi = [];

  for (const api of apiPackages.filter((p) => !p.is_addon)) {
    const id = matchCuratedId(api.name, curatedById);
    if (!id) { unmatchedApi.push(api.name); continue; }
    const pkg = curatedById[id];

    const studio = api.price_cents / 100;
    const onLocation = api.location_price_cents > 0 ? api.location_price_cents / 100 : null;
    const newPrice = onLocation ? { studio, on_location: onLocation } : studio;
    if (JSON.stringify(newPrice) !== JSON.stringify(pkg.price_usd)) {
      drift.push(`${id}: price ${JSON.stringify(pkg.price_usd)} -> ${JSON.stringify(newPrice)}`);
    }
    pkg.price_usd = newPrice;

    if (api.duration_minutes > 0 && api.duration_minutes !== pkg.duration_minutes) {
      drift.push(`${id}: duration ${pkg.duration_minutes} -> ${api.duration_minutes}`);
      pkg.duration_minutes = api.duration_minutes;
    }

    const totalImages = (api.included_edits || 0) + (api.included_composites || 0);
    if (totalImages > 0 && totalImages !== pkg.included_final_images) {
      drift.push(`${id}: included images ${pkg.included_final_images} -> ${totalImages}`);
      pkg.included_final_images = totalImages;
    }

    const tDays = parseInt(String(api.turnaround_text || ""), 10);
    if (Number.isFinite(tDays) && tDays > 0 && tDays !== pkg.turnaround_finals_days) {
      drift.push(`${id}: turnaround ${pkg.turnaround_finals_days} -> ${tDays} days`);
      pkg.turnaround_finals_days = tDays;
    }

    pkg.deposit_usd = api.deposit_cents > 0 ? api.deposit_cents / 100 : pkg.deposit_usd;
  }

  const addOnDrift = [];
  for (const api of apiPackages.filter((p) => p.is_addon)) {
    const key = ADDON_NAME_TO_KEY[normalize(api.name)];
    if (!key) { unmatchedApi.push(api.name); continue; }
    const usd = api.price_cents / 100;
    if (addOns[key] !== usd) {
      addOnDrift.push(`${key}: ${addOns[key]} -> ${usd}`);
      addOns[key] = usd;
    }
  }

  return { drift: [...drift, ...addOnDrift], unmatchedApi };
}

// ---------- assemble ----------
const main = async () => {
  let pricingNote = "live API";
  if (OFFLINE) {
    console.warn("⚠ --offline: using curated pricing without live API verification");
    pricingNote = "curated (offline build)";
  } else {
    const apiPackages = await fetchLivePackages();
    const { drift, unmatchedApi } = mergeLivePricing(packagesCurated, apiPackages);
    if (drift.length) {
      console.log("Live API corrections applied (API is the source of truth):");
      for (const d of drift) console.log("  •", d);
    } else {
      console.log("Curated pricing already matches the live API — no corrections needed.");
    }
    if (unmatchedApi.length) {
      console.warn("⚠ API entries with no curated match (add them to packages-curated.json):");
      for (const u of unmatchedApi) console.warn("  •", u);
    }
  }

  const kb = {
    kb_version: KB_VERSION,
    last_updated_local: new Date().toISOString().slice(0, 10),
    generated_by: "scripts/build-kb.mjs — do not edit by hand; edit data/source/* and rebuild",
    pricing_source: pricingNote,
    booking_destination: routes.booking_app_url,
    business,
    official_pages: officialPages,
    wedding_packages: wedding,
    boudoir_info: boudoir,
    on_location_info: onlocation,
    square_booking_links: bookingLinks, // key name kept for deployed-worker compatibility; values are the live booking app
    editing_levels: editingLevels,
    add_ons: addOns,
    packages: packagesCurated,
    booking_policies: policies.booking_policies,
    client_experience_guidelines: policies.client_experience_guidelines,
    tone_and_messaging_rules: policies.tone_and_messaging_rules,
    bot_guardrails: guardrails.bot_guardrails,
    learning_and_review_workflow: guardrails.learning_and_review_workflow,
    intents_and_answers: intents,
  };

  // Hard safety gates before writing anything
  const required = ["business", "square_booking_links", "packages", "booking_policies", "intents_and_answers", "bot_guardrails"];
  for (const k of required) if (!(k in kb)) throw new Error(`generated KB missing required key: ${k}`);
  const flat = JSON.stringify(kb);
  if (flat.includes("squareup.com")) throw new Error("generated KB still contains Square links — aborting");
  if (/\d+\s+Abbey/i.test(flat)) throw new Error("generated KB contains the street address — aborting");
  if (!flat.includes(routes.booking_app_url)) throw new Error("generated KB missing the booking app URL — aborting");

  writeFileSync(join(root, "motiontography_kb.json"), JSON.stringify(kb, null, 2) + "\n");
  mkdirSync(join(root, "dist", "site"), { recursive: true });
  writeFileSync(join(root, "dist", "site", "motiontography_kb.json"), JSON.stringify(kb, null, 2) + "\n");
  console.log(`✔ motiontography_kb.json v${KB_VERSION} written (root + dist/site copy)`);
};

main().catch((e) => { console.error("BUILD FAILED — no files written:", e.message); process.exit(1); });
