/**
 * Motiontography KB-Only Bot - Cloudflare Worker
 * Converted from Express server.js for 24/7 production deployment
 */

// KB will be embedded at build time or fetched from GitHub
const KB_URL = "https://raw.githubusercontent.com/Motiontography/motiontography-bot/main/motiontography_kb.json";

let KB_CACHE = null;
let KB_CACHE_TIME = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function loadKB() {
  const now = Date.now();
  if (KB_CACHE && (now - KB_CACHE_TIME) < CACHE_TTL_MS) {
    return KB_CACHE;
  }

  const resp = await fetch(KB_URL);
  if (!resp.ok) throw new Error(`Failed to fetch KB: ${resp.status}`);

  const kb = await resp.json();

  // Sanity checks
  const requiredKeys = ["business", "square_booking_links", "packages", "booking_policies", "intents_and_answers", "bot_guardrails"];
  for (const k of requiredKeys) {
    if (!(k in kb)) throw new Error(`KB missing required key: ${k}`);
  }

  KB_CACHE = kb;
  KB_CACHE_TIME = now;
  return kb;
}

// -------------------- Matching --------------------
function norm(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
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

  return { reply, followups, route_url: routeUrl };
}

function generateUUID() {
  return crypto.randomUUID();
}

// -------------------- Request Handler --------------------
async function handleChat(request) {
  const kb = await loadKB();

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const message = body?.message;
  const session_id = body?.session_id || generateUUID();

  if (!message || typeof message !== "string") {
    return jsonResponse({ ok: false, error: "message (string) is required" }, 400);
  }

  const { intent, score } = findBestIntent(message, kb);

  let response;
  let matched_intent_id = null;

  if (intent) {
    matched_intent_id = intent.id || intent.intent_id || intent.name || null;
    response = formatIntentAnswer(intent, kb);

    if (!response.reply) {
      response = { reply: buildEscalationReply(kb), followups: [], route_url: null };
    }
  } else {
    response = { reply: buildEscalationReply(kb), followups: [], route_url: null };
  }

  return jsonResponse({
    ok: true,
    session_id,
    matched_intent_id,
    match_score: score,
    ...response,
  });
}

async function handleHealth() {
  const kb = await loadKB();
  return jsonResponse({
    ok: true,
    kb_version: kb.kb_version,
    last_updated_local: kb.last_updated_local
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

// -------------------- Main Handler --------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;

    // Handle CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // Routes
    if (url.pathname === "/api/health" && method === "GET") {
      return handleHealth();
    }

    if (url.pathname === "/api/chat" && method === "POST") {
      return handleChat(request);
    }

    // 404 for unknown routes
    return jsonResponse({ ok: false, error: "Not found" }, 404);
  },
};
