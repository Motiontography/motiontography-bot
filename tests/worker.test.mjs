/**
 * Unit tests for worker.js v3 internals. Run: npm test
 * (node --test; no Cloudflare runtime needed — pure functions + mocked env.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAllowedOrigins, corsHeadersFor, validateChatBody, scrubAddress, filterLinks,
  scoreIntent, keywordAnswer, detectLead, parseModelJSON, isReasoningModel, buildInstructions,
} from "../worker.js";

const ENV = { ALLOWED_ORIGINS: "https://motiontography.com,https://www.motiontography.com" };
const req = (origin) => ({ headers: { get: (h) => (h === "Origin" ? origin : null) } });

// ---------- CORS ----------
test("allowed origin is reflected", () => {
  const h = corsHeadersFor(req("https://motiontography.com"), ENV);
  assert.equal(h["Access-Control-Allow-Origin"], "https://motiontography.com");
});

test("foreign origin gets null (refused)", () => {
  assert.equal(corsHeadersFor(req("https://evil.example.com"), ENV), null);
});

test("no Origin header (curl/server) passes with no CORS headers", () => {
  assert.deepEqual(corsHeadersFor(req(null), ENV), {});
});

test("defaults apply when ALLOWED_ORIGINS unset", () => {
  assert.ok(parseAllowedOrigins({}).includes("https://www.motiontography.com"));
});

// ---------- validation ----------
test("rejects missing message", () => {
  assert.match(validateChatBody({}), /message/);
});

test("rejects oversized message", () => {
  assert.match(validateChatBody({ message: "x".repeat(1001) }), /too long/);
});

test("rejects malformed previous_response_id", () => {
  assert.match(validateChatBody({ message: "hi", previous_response_id: "javascript:alert(1)" }), /invalid/);
});

test("accepts valid body", () => {
  assert.equal(validateChatBody({ message: "hi", previous_response_id: "resp_abc123" }), null);
});

// ---------- output safety ----------
test("address scrubber removes street address", () => {
  const out = scrubAddress("Visit us at 109 Abbey Rd, Suffolk, VA 23434 today");
  assert.ok(!out.includes("Abbey"));
  assert.ok(out.includes("Suffolk, VA studio"));
});

test("link filter strips attacker URLs but keeps allowed ones", () => {
  const contact = "https://motiontography.com/contact.html";
  const input = "Book at https://motiontography-pwa-production.up.railway.app/app/booking or https://phishing.example.com/steal";
  const out = filterLinks(input, contact);
  assert.ok(out.includes("railway.app/app/booking"));
  assert.ok(!out.includes("phishing.example.com"));
  assert.ok(out.includes(contact));
});

test("link filter keeps motiontography.com pages", () => {
  const out = filterLinks("See https://motiontography.com/pricing.html", "x");
  assert.ok(out.includes("pricing.html"));
});

// ---------- keyword fallback ----------
const KB = {
  business: { primary_phone: "+1-757-759-8454" },
  intents_and_answers: [
    { id: "maternity_pricing", triggers: ["maternity price", "how much maternity"], answer: "Maternity Signature is $750 studio / $900 on-location.", followups: ["Studio or on-location?"] },
    { id: "regex_intent", triggers: ["/\\bheadshots?\\b/i"], answer: "We offer headshots." },
  ],
};

test("keyword scorer matches phrase triggers", () => {
  assert.ok(scoreIntent("hi, how much maternity?", KB.intents_and_answers[0]) >= 2);
});

test("keyword scorer matches regex triggers", () => {
  assert.ok(scoreIntent("do you do a headshot?", KB.intents_and_answers[1]) >= 3);
});

test("fallback answers from KB when intent matches", () => {
  const r = keywordAnswer("how much maternity?", KB);
  assert.ok(r.reply.includes("$750"));
  assert.equal(r.escalated, false);
  assert.equal(r.intent_id, "maternity_pricing");
});

test("fallback escalates with contact info when nothing matches", () => {
  const r = keywordAnswer("do you sell spaceships?", KB);
  assert.equal(r.escalated, true);
  assert.ok(r.reply.includes("757-759-8454"));
});

// ---------- leads ----------
test("detects email in message", () => {
  assert.equal(detectLead("reach me at jane.doe@example.com please").email, "jane.doe@example.com");
});

test("detects phone in message", () => {
  assert.ok(detectLead("call me at (757) 555-1234").phone);
});

test("no false lead on plain text", () => {
  assert.equal(detectLead("how much is a session?"), null);
});

// ---------- model plumbing ----------
test("parses clean model JSON", () => {
  const r = parseModelJSON('{"reply":"Hi","followups":["a","b","c","d"],"wants_booking":true,"escalated":false}');
  assert.equal(r.reply, "Hi");
  assert.equal(r.followups.length, 3); // capped
  assert.equal(r.wants_booking, true);
});

test("parses fenced model JSON", () => {
  const r = parseModelJSON('```json\n{"reply":"ok"}\n```');
  assert.equal(r.reply, "ok");
});

test("reasoning model detection", () => {
  assert.equal(isReasoningModel("gpt-5.5"), true);
  assert.equal(isReasoningModel("gpt-5.2-chat-latest"), false);
  assert.equal(isReasoningModel("gpt-4o"), false);
  assert.equal(isReasoningModel("o3-mini"), true);
});

// ---------- prompt ----------
test("instructions redact address and pin booking URL", () => {
  const kb = {
    booking_destination: "https://motiontography-pwa-production.up.railway.app/app/booking",
    business: { primary_phone: "+1-757-759-8454", studio: { address: "109 Abbey Rd, Suffolk, VA 23434" } },
    packages: [],
    intents_and_answers: [],
  };
  const inst = buildInstructions(kb);
  assert.ok(!inst.includes("109 Abbey"));
  assert.ok(inst.includes("/app/booking"));
  assert.ok(inst.includes("UNTRUSTED DATA"));
  assert.ok(!inst.toLowerCase().includes("/app/admin"));
});
