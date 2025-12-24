/**
 * Motiontography KB-Only Bot API
 * - Loads ./motiontography_kb.json as the ONLY source of truth
 * - Uses OpenAI GPT-5.2 (or configured model) for intelligent intent routing
 * - Falls back to keyword matching if OpenAI fails
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
const { openAiRouteAndAnswer } = require("./lib/openai");

// -------------------- Config --------------------
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const OPENAI_CONFIG = {
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL || "gpt-4o",
  reasoningEffort: process.env.OPENAI_REASONING_EFFORT || "high",
  textVerbosity: process.env.OPENAI_TEXT_VERBOSITY || "low",
  maxOutputTokens: parseInt(process.env.OPENAI_MAX_OUTPUT_TOKENS, 10) || 500
};

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

// -------------------- Fallback Heuristic Matching (KB-only) --------------------
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function isRegexTrigger(t) {
  return typeof t === "string" && t.startsWith("/") && t.lastIndexOf("/") > 0;
}

function compileRegex(trigger) {
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

    if (msg.includes(trig)) score += 2;

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
  return String(url || "").replace(/([^:]\/)\/+/g, "$1");
}

function resolveRouteUrl(route, kb) {
  if (!route || typeof route !== "object") return null;

  if (route.type === "url" && route.url) return route.url;

  if (route.type === "square_package" && route.package_id) {
    const entry = kb.square_booking_links?.[route.package_id];
    if (!entry) return null;

    if (typeof entry === "string") return entry;

    const mode = route.mode || "studio";
    if (entry[mode]) return entry[mode];

    const first = Object.values(entry).find((v) => typeof v === "string");
    return first || null;
  }

  return null;
}

function buildEscalationReply(kb) {
  const phone = kb.business?.primary_phone || "+1-757-759-8454";
  const site = kb.business?.website || "https://motiontography.com";
  const contactUrl = normalizeUrl(`${site}/contact.html`);
  return `I don't want to guess and give you the wrong info. Please contact Roger directly at ${phone} (call/text), or use the contact page: ${contactUrl}`;
}

function findBestIntent(message, kb) {
  const intents = kb.intents_and_answers;
  let best = null;
  let bestScore = 0;

  for (const intent of intents) {
    const s = scoreIntent(message, intent);
    if (s > bestScore) {
      bestScore = s;
      best = intent;
    }
  }

  if (!best || bestScore < 2) return { intent: null, score: bestScore };
  return { intent: best, score: bestScore };
}

function formatIntentAnswer(intent, kb) {
  const answer = intent.answer;
  const followups = intent.followups || [];
  const routeUrl = resolveRouteUrl(intent.route, kb);

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
  res.json({
    ok: true,
    kb_version: KB.kb_version,
    last_updated_local: KB.last_updated_local,
    openai_model: OPENAI_CONFIG.model,
    openai_enabled: !!OPENAI_CONFIG.apiKey
  });
});

app.post("/api/chat", async (req, res) => {
  const startedAt = new Date().toISOString();

  const message = req.body?.message;
  const client = req.body?.client || {};
  const session_id = req.body?.session_id || crypto.randomUUID();

  if (!message || typeof message !== "string") {
    return res.status(400).json({ ok: false, error: "message (string) is required" });
  }

  let response;
  let matched_intent_id = null;
  let match_score = 0;
  let used_openai = false;
  let escalated = false;
  let kb_evidence = [];
  let links_shared = [];

  // Try OpenAI first if configured
  if (OPENAI_CONFIG.apiKey) {
    try {
      const aiResult = await openAiRouteAndAnswer(message, KB, OPENAI_CONFIG);
      used_openai = true;
      matched_intent_id = aiResult.intent_id;
      match_score = aiResult.confidence;
      escalated = aiResult.escalated;
      kb_evidence = aiResult.kb_evidence || [];
      links_shared = aiResult.links_shared || [];

      response = {
        reply: aiResult.reply,
        followups: aiResult.followups,
        route_url: links_shared.length > 0 ? links_shared[0] : null
      };

      // If AI escalated, log to FAQ candidates
      if (escalated) {
        appendJsonl(FAQ_CANDIDATES_PATH(), {
          ts: startedAt,
          session_id,
          client,
          question: message,
          reason: "AI escalated - not in KB",
          ai_intent_id: matched_intent_id,
          ai_confidence: match_score
        });
      }

    } catch (err) {
      console.error("[OpenAI Error]", err.message);
      // Fall through to heuristic fallback
    }
  }

  // Fallback to heuristic matching if OpenAI wasn't used or failed
  if (!response) {
    const { intent, score } = findBestIntent(message, KB);
    match_score = score;

    if (intent) {
      matched_intent_id = intent.id || intent.intent_id || intent.name || null;
      response = formatIntentAnswer(intent, KB);

      if (!response.reply) {
        response = { reply: buildEscalationReply(KB), followups: [], route_url: null };
        escalated = true;
        appendJsonl(FAQ_CANDIDATES_PATH(), {
          ts: startedAt,
          session_id,
          client,
          question: message,
          reason: "Matched intent but empty answer (heuristic)",
        });
      }
    } else {
      response = { reply: buildEscalationReply(KB), followups: [], route_url: null };
      escalated = true;

      appendJsonl(FAQ_CANDIDATES_PATH(), {
        ts: startedAt,
        session_id,
        client,
        question: message,
        reason: "No intent match (heuristic fallback)",
        score,
      });
    }
  }

  // Final safety: scrub any address leak from reply
  if (response.reply) {
    response.reply = response.reply.replace(/109\s*Abbey\s*R(oa)?d[^,]*/gi, "Studio in Suffolk, VA");
    response.reply = response.reply.replace(/\d+\s+Abbey\s+R(oa)?d/gi, "Studio in Suffolk, VA");
  }

  // Always log the transcript
  appendJsonl(TRANSCRIPTS_PATH(), {
    ts: startedAt,
    session_id,
    client,
    user_message: message,
    bot_reply: response.reply,
    bot_followups: response.followups,
    route_url: response.route_url,
    matched_intent_id,
    match_score,
    used_openai,
    escalated,
    kb_evidence,
    links_shared
  });

  return res.json({
    ok: true,
    session_id,
    matched_intent_id,
    match_score,
    used_openai,
    escalated,
    kb_evidence,
    ...response,
  });
});

// -------------------- Start --------------------
const PORT = process.env.PORT || 5050;
app.listen(PORT, () => {
  console.log(`[motiontography-bot] running on http://localhost:${PORT}`);
  console.log(`[motiontography-bot] KB: ${path.basename(KB_PATH)} v${KB.kb_version} (${KB.last_updated_local})`);
  console.log(`[motiontography-bot] OpenAI: ${OPENAI_CONFIG.apiKey ? `enabled (${OPENAI_CONFIG.model}, reasoning=${OPENAI_CONFIG.reasoningEffort})` : "disabled (using heuristic only)"}`);
});
