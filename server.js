/**
 * Motiontography KB-Only Bot API
 * - Loads ./motiontography_kb.json as the ONLY source of truth
 * - Matches questions to intents via keyword/regex triggers
 * - Returns the approved answer + optional followups + optional Square link
 * - If no match: escalates to Roger and logs to NEW_FAQ_CANDIDATES
 * - Logs every interaction with client identifiers (if provided)
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// -------------------- Load KB --------------------
const KB_PATH = path.join(__dirname, "motiontography_kb.json");

function loadKB() {
  const raw = fs.readFileSync(KB_PATH, "utf8");
  const kb = JSON.parse(raw);

  // Minimal sanity checks so we fail fast instead of hallucinating
  const requiredTopKeys = [
    "business",
    "square_booking_links",
    "packages",
    "booking_policies",
    "intents_and_answers",
    "bot_guardrails",
    "learning_and_review_workflow"
  ];
  for (const k of requiredTopKeys) {
    if (!(k in kb)) throw new Error(`KB missing required key: ${k}`);
  }
  if (!Array.isArray(kb.intents_and_answers)) throw new Error("KB intents_and_answers must be an array");
  if (!Array.isArray(kb.packages)) throw new Error("KB packages must be an array");
  return kb;
}

let KB = loadKB();

// Middleware to check admin token
function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"] || req.query.token;
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

// Optional: reload KB without restarting server (admin only)
app.post("/api/reload-kb", requireAdmin, (req, res) => {
  try {
    KB = loadKB();
    return res.json({ ok: true, kb_version: KB.kb_version, last_updated_local: KB.last_updated_local });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// -------------------- Logging --------------------
const LOG_DIR = path.join(__dirname, "logs");
const TRANSCRIPTS_PATH = () => path.join(LOG_DIR, `transcripts_${new Date().toISOString().slice(0, 10)}.jsonl`);
const FAQ_CANDIDATES_PATH = () => path.join(LOG_DIR, `NEW_FAQ_CANDIDATES_${new Date().toISOString().slice(0, 10)}.jsonl`);

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function appendJsonl(filePath, obj) {
  ensureLogDir();
  fs.appendFileSync(filePath, JSON.stringify(obj) + "\n", "utf8");
}

// -------------------- Matching (KB-only) --------------------
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function isRegexTrigger(t) {
  // supports "/pattern/flags" format
  return typeof t === "string" && t.startsWith("/") && t.lastIndexOf("/") > 0;
}

function compileRegex(trigger) {
  // "/hello\\s+world/i" -> new RegExp("hello\\s+world", "i")
  const lastSlash = trigger.lastIndexOf("/");
  const pattern = trigger.slice(1, lastSlash);
  const flags = trigger.slice(lastSlash + 1) || "";
  return new RegExp(pattern, flags);
}

function scoreIntent(message, intent) {
  const msg = norm(message);
  const triggers = intent.triggers || [];
  let score = 0;

  for (const t of triggers) {
    if (!t) continue;

    if (isRegexTrigger(t)) {
      try {
        const r = compileRegex(t);
        if (r.test(message)) score += 3;
      } catch (_) {}
      continue;
    }

    const trig = norm(t);
    if (!trig) continue;

    // simple keyword scoring
    if (msg.includes(trig)) score += 2;

    // multi-word partial scoring
    const words = trig.split(" ").filter(Boolean);
    if (words.length >= 2) {
      let hits = 0;
      for (const w of words) if (msg.includes(w)) hits++;
      if (hits >= Math.ceil(words.length * 0.7)) score += 1;
    }
  }

  return score;
}

function normalizeUrl(url) {
  // Collapses accidental double slashes while preserving https://
  return String(url || "").replace(/([^:]\/)\/+/g, "$1");
}

function resolveRouteUrl(route) {
  // route may be:
  // { type: "square_package", package_id: "classic_portrait", mode: "studio"|"on_location" }
  // OR { type: "url", url: "https://..." }
  if (!route || typeof route !== "object") return null;

  if (route.type === "url" && route.url) return route.url;

  if (route.type === "square_package" && route.package_id) {
    const entry = KB.square_booking_links?.[route.package_id];
    if (!entry) return null;

    // some entries may be a string URL, others {studio, on_location}
    if (typeof entry === "string") return entry;

    const mode = route.mode || "studio";
    if (entry[mode]) return entry[mode];

    // fallback to any URL inside the object
    const first = Object.values(entry).find((v) => typeof v === "string");
    return first || null;
  }

  return null;
}

function buildEscalationReply() {
  const phone = KB.business?.primary_phone || "+1-757-759-8454";
  const site = KB.business?.website || "https://motiontography.com";
  const contactUrl = normalizeUrl(`${site}/contact.html`);
  return `I don't want to guess and give you the wrong info. Please contact Roger directly at ${phone} (call/text), or use the contact page: ${contactUrl}`;
}

function findBestIntent(message) {
  const intents = KB.intents_and_answers;
  let best = null;
  let bestScore = 0;

  for (const intent of intents) {
    const s = scoreIntent(message, intent);
    if (s > bestScore) {
      bestScore = s;
      best = intent;
    }
  }

  // threshold prevents random matches -> prevents "hallucination by matching"
  if (!best || bestScore < 2) return { intent: null, score: bestScore };
  return { intent: best, score: bestScore };
}

function formatIntentAnswer(intent) {
  // allow answer to be string or array of strings
  const answer = intent.answer;
  const followups = intent.followups || [];
  const routeUrl = resolveRouteUrl(intent.route);

  let reply = "";
  if (Array.isArray(answer)) reply = answer.filter(Boolean).join("\n\n");
  else reply = String(answer || "").trim();

  return {
    reply,
    followups,
    route_url: routeUrl,
  };
}

// -------------------- API --------------------
app.get("/api/health", (req, res) => {
  res.json({ ok: true, kb_version: KB.kb_version, last_updated_local: KB.last_updated_local });
});

app.post("/api/chat", (req, res) => {
  const startedAt = new Date().toISOString();

  const message = req.body?.message;
  const client = req.body?.client || {};
  const session_id = req.body?.session_id || crypto.randomUUID();

  if (!message || typeof message !== "string") {
    return res.status(400).json({ ok: false, error: "message (string) is required" });
  }

  const { intent, score } = findBestIntent(message);

  let response;
  let matched_intent_id = null;

  if (intent) {
    matched_intent_id = intent.id || intent.intent_id || intent.name || null;
    response = formatIntentAnswer(intent);

    // If somehow reply is empty, we still refuse to guess
    if (!response.reply) {
      response = { reply: buildEscalationReply(), followups: [], route_url: null };
      // log as candidate
      appendJsonl(FAQ_CANDIDATES_PATH(), {
        ts: startedAt,
        session_id,
        client,
        question: message,
        reason: "Matched intent but empty answer",
      });
    }
  } else {
    response = { reply: buildEscalationReply(), followups: [], route_url: null };

    // log as FAQ candidate for review
    appendJsonl(FAQ_CANDIDATES_PATH(), {
      ts: startedAt,
      session_id,
      client,
      question: message,
      reason: "No intent match",
      score,
    });
  }

  // Always log the transcript (as requested)
  appendJsonl(TRANSCRIPTS_PATH(), {
    ts: startedAt,
    session_id,
    client,
    user_message: message,
    bot_reply: response.reply,
    bot_followups: response.followups,
    route_url: response.route_url,
    matched_intent_id,
    match_score: score,
  });

  return res.json({
    ok: true,
    session_id,
    matched_intent_id,
    match_score: score,
    ...response,
  });
});

// -------------------- Start --------------------
const PORT = process.env.PORT || 5050;
app.listen(PORT, () => {
  console.log(`[motiontography-bot] running on http://localhost:${PORT}`);
  console.log(`[motiontography-bot] KB: ${path.basename(KB_PATH)} v${KB.kb_version} (${KB.last_updated_local})`);
});
