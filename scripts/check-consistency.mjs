#!/usr/bin/env node
/**
 * Warn-only drift detector: compares prices in the live booking API against
 * the prices written in the static site's booking.html and pricing.html text.
 * Run: node scripts/check-consistency.mjs [path-to-MOTIONTOGRAPHY]
 * Exit code is always 0 unless the API itself is unreachable — this reports,
 * it does not block.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const PACKAGES_API = "https://motiontography-pwa-production.up.railway.app/api/booking/packages";
const siteDir = process.argv[2] || "/Users/rogermitchell/Desktop/MOTIONTOGRAPHY";

const res = await fetch(PACKAGES_API, { signal: AbortSignal.timeout(30000) });
if (!res.ok) { console.error(`packages API returned ${res.status}`); process.exit(1); }
const { data: packages } = await res.json();

let warnings = 0;
for (const page of ["booking.html", "pricing.html"]) {
  const file = join(siteDir, page);
  if (!existsSync(file)) { console.warn(`⚠ ${page} not found at ${file}`); continue; }
  const html = readFileSync(file, "utf8");
  console.log(`\n— ${page} —`);
  for (const p of packages.filter((x) => !x.is_addon)) {
    const price = `$${(p.price_cents / 100).toLocaleString("en-US")}`;
    // Page must mention the package's studio price somewhere near its name,
    // or at minimum contain the price string at all.
    const nameMentioned = html.toLowerCase().includes(p.name.toLowerCase().replace(" (kids)", ""));
    const priceMentioned = html.includes(price);
    if (nameMentioned && !priceMentioned) {
      console.warn(`  ⚠ "${p.name}" is on the page but its live price ${price} is not — possible drift`);
      warnings++;
    } else if (nameMentioned) {
      console.log(`  ✔ ${p.name} ${price}`);
    }
  }
}
console.log(warnings ? `\n${warnings} possible drift(s) — review the pages above.` : "\nNo price drift detected.");
