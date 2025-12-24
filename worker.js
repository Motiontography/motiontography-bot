/**
 * Motiontography KB-Only Bot - Cloudflare Worker
 * With OpenAI GPT-powered intelligent routing
 * Falls back to keyword matching if OpenAI fails
 */

// KB will be fetched from GitHub
const KB_URL = "https://raw.githubusercontent.com/Motiontography/motiontography-bot/main/motiontography_kb.json";
const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

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

// -------------------- OpenAI Integration --------------------

function buildSystemPrompt(kb) {
  // Sanitize KB to remove sensitive data before sending to model
  const sanitizedKB = JSON.parse(JSON.stringify(kb));

  // Remove exact studio address from KB sent to model
  if (sanitizedKB.business?.studio?.address) {
    sanitizedKB.business.studio.address = "[REDACTED - Say 'Studio in Suffolk, VA']";
  }

  return `You are a friendly, professional customer support assistant for Motiontography LLC, a photography studio in Hampton Roads, VA owned by Roger Mitchell.

## CRITICAL RULES - MUST FOLLOW:

1. **STRICT GROUNDING**: You may ONLY use facts present in the Knowledge Base (KB) provided below. If a fact is NOT in the KB, you MUST escalate.

2. **NEVER REVEAL STUDIO ADDRESS**: Even if you see an address in the KB, NEVER output it. Always say "Studio in Suffolk, VA" and mention the address is shared after booking and payment.

3. **ESCALATION**: If you cannot answer with KB facts, respond with escalation. Set "escalated" to true in your response.

4. **NO HALLUCINATION**: Do not invent galleries, pricing, policies, or any information not explicitly in the KB.

5. **FRIENDLY BUT CONCISE**: Be warm and helpful, but keep responses short and actionable.

6. **LINKS**: Only share URLs that exist in the KB (official_pages, square_booking_links, or explicitly in intent answers).

## YOUR TASK:

Given a user message:
1. Identify which intent from "intents_and_answers" best matches (if any)
2. Generate a grounded response using ONLY KB facts
3. Include relevant followup questions from the intent (if available)
4. Include relevant booking/page links from the KB (if applicable)
5. Track which KB keys you referenced for transparency

## OUTPUT FORMAT (JSON ONLY - NO MARKDOWN):

{
  "intent_id": "string or null if no match",
  "confidence": 0.0 to 1.0,
  "reply": "Your response text here",
  "followups": ["Optional followup question 1", "Optional followup question 2"],
  "links_shared": ["https://...", "https://..."],
  "escalated": false,
  "kb_evidence": ["packages[0].name", "official_pages.booking_page_url"]
}

If escalating, use this reply format:
"I don't want to guess and give you the wrong info. Please contact Roger directly at ${kb.business?.primary_phone || '+1-757-759-8454'} (call/text), or use the contact page: ${kb.official_pages?.contact_page_url || 'https://motiontography.com/contact.html'}"

## KNOWLEDGE BASE:

${JSON.stringify(sanitizedKB, null, 2)}

Remember: Output ONLY valid JSON. No markdown, no explanation, no code blocks.`;
}

async function callOpenAI(message, kb, apiKey) {
  const systemPrompt = buildSystemPrompt(kb);

  const requestBody = {
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: message }
    ],
    max_tokens: 500,
    temperature: 0.3
  };

  const response = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}

function parseModelResponse(rawText) {
  let cleaned = rawText.trim();

  // Remove markdown code block wrappers if present
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.slice(0, -3);
  }
  cleaned = cleaned.trim();

  try {
    const parsed = JSON.parse(cleaned);

    return {
      intent_id: parsed.intent_id || null,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
      reply: String(parsed.reply || ""),
      followups: Array.isArray(parsed.followups) ? parsed.followups : [],
      links_shared: Array.isArray(parsed.links_shared) ? parsed.links_shared : [],
      escalated: Boolean(parsed.escalated),
      kb_evidence: Array.isArray(parsed.kb_evidence) ? parsed.kb_evidence : []
    };
  } catch (e) {
    throw new Error(`Failed to parse model JSON: ${e.message}`);
  }
}

function scrubAddress(text) {
  if (!text) return text;
  // Remove any potential address leaks
  let scrubbed = text.replace(/109\s*Abbey\s*R(oa)?d[^,]*/gi, "Studio in Suffolk, VA");
  scrubbed = scrubbed.replace(/\d+\s+Abbey\s+R(oa)?d/gi, "Studio in Suffolk, VA");
  return scrubbed;
}

async function openAiRouteAndAnswer(message, kb, apiKey) {
  const rawResponse = await callOpenAI(message, kb, apiKey);
  const parsed = parseModelResponse(rawResponse);

  // Double-check: scrub any leaked address from reply
  if (parsed.reply) {
    parsed.reply = scrubAddress(parsed.reply);
  }

  return parsed;
}

// -------------------- Heuristic Fallback --------------------
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
async function handleChat(request, env) {
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

  let response;
  let matched_intent_id = null;
  let match_score = 0;
  let used_openai = false;
  let escalated = false;

  // Try OpenAI first if API key is available
  if (env.OPENAI_API_KEY) {
    try {
      const aiResult = await openAiRouteAndAnswer(message, kb, env.OPENAI_API_KEY);
      used_openai = true;
      matched_intent_id = aiResult.intent_id;
      match_score = aiResult.confidence;
      escalated = aiResult.escalated;

      response = {
        reply: aiResult.reply,
        followups: aiResult.followups,
        links_shared: aiResult.links_shared,
        kb_evidence: aiResult.kb_evidence
      };
    } catch (err) {
      console.error("[OpenAI Error]", err.message);
      // Fall through to heuristic fallback
    }
  }

  // Heuristic fallback if OpenAI failed or not available
  if (!used_openai) {
    const { intent, score } = findBestIntent(message, kb);
    match_score = score;

    if (intent) {
      matched_intent_id = intent.id || intent.intent_id || intent.name || null;
      response = formatIntentAnswer(intent, kb);

      if (!response.reply) {
        response = { reply: buildEscalationReply(kb), followups: [], route_url: null };
        escalated = true;
      }
    } else {
      response = { reply: buildEscalationReply(kb), followups: [], route_url: null };
      escalated = true;
    }
  }

  return jsonResponse({
    ok: true,
    session_id,
    matched_intent_id,
    match_score,
    used_openai,
    escalated,
    ...response,
  });
}

async function handleHealth(env) {
  const kb = await loadKB();
  return jsonResponse({
    ok: true,
    kb_version: kb.kb_version,
    last_updated_local: kb.last_updated_local,
    openai_enabled: Boolean(env.OPENAI_API_KEY)
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
      return handleHealth(env);
    }

    if (url.pathname === "/api/chat" && method === "POST") {
      return handleChat(request, env);
    }

    // 404 for unknown routes
    return jsonResponse({ ok: false, error: "Not found" }, 404);
  },
};
