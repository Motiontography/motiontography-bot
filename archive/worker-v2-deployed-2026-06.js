--238f8485fc120279be0c094ee5b2652129cef12e080ea94df22e8c892b1f
Content-Disposition: form-data; name="worker.js"

var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var KB_URL = "https://raw.githubusercontent.com/Motiontography/motiontography-bot/main/motiontography_kb.json";
var OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
var OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
var USE_GPT_5_2 = true;
var GPT_4O_MODEL = "gpt-4o";
var GPT_5_2_MODEL = "gpt-5.2-chat-latest";
var KB_CACHE = null;
var KB_CACHE_TIME = 0;
var CACHE_TTL_MS = 2 * 60 * 1e3;
async function loadKB() {
  const now = Date.now();
  if (KB_CACHE && now - KB_CACHE_TIME < CACHE_TTL_MS) {
    return KB_CACHE;
  }
  const resp = await fetch(KB_URL);
  if (!resp.ok) throw new Error(`Failed to fetch KB: ${resp.status}`);
  const kb = await resp.json();
  const requiredKeys = ["business", "square_booking_links", "packages", "booking_policies", "intents_and_answers", "bot_guardrails"];
  for (const k of requiredKeys) {
    if (!(k in kb)) throw new Error(`KB missing required key: ${k}`);
  }
  KB_CACHE = kb;
  KB_CACHE_TIME = now;
  return kb;
}
__name(loadKB, "loadKB");
function norm(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
}
__name(norm, "norm");
function isRegexTrigger(t) {
  return typeof t === "string" && t.startsWith("/") && t.lastIndexOf("/") > 0;
}
__name(isRegexTrigger, "isRegexTrigger");
function compileRegex(trigger) {
  const lastSlash = trigger.lastIndexOf("/");
  const pattern = trigger.slice(1, lastSlash);
  const flags = trigger.slice(lastSlash + 1) || "";
  return new RegExp(pattern, flags);
}
__name(compileRegex, "compileRegex");
function scoreIntent(message, intent) {
  const msg = norm(message);
  const triggers = intent.triggers || [];
  let bestTriggerScore = 0;
  for (const t of triggers) {
    if (!t) continue;
    if (isRegexTrigger(t)) {
      try {
        const r = compileRegex(t);
        if (r.test(message)) bestTriggerScore = Math.max(bestTriggerScore, 10);
      } catch (_) {
      }
      continue;
    }
    const trig = norm(t);
    if (!trig) continue;
    if (msg.includes(trig)) {
      const triggerLength = trig.length;
      const messageLength = msg.length;
      const coverage = triggerLength / messageLength;
      const wordCount = trig.split(" ").filter(Boolean).length;
      const triggerScore = 2 + wordCount + Math.floor(coverage * 5);
      bestTriggerScore = Math.max(bestTriggerScore, triggerScore);
    }
  }
  return bestTriggerScore;
}
__name(scoreIntent, "scoreIntent");
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
__name(findBestIntent, "findBestIntent");
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
__name(resolveRouteUrl, "resolveRouteUrl");
function formatIntentAnswer(intent, kb) {
  const answer = intent.answer;
  const followups = intent.followups || [];
  const routeUrl = resolveRouteUrl(intent.route, kb);
  let reply = "";
  if (Array.isArray(answer)) reply = answer.filter(Boolean).join("\n\n");
  else reply = String(answer || "").trim();
  return { reply, followups, route_url: routeUrl };
}
__name(formatIntentAnswer, "formatIntentAnswer");
function buildSystemPrompt(kb) {
  const sanitizedKB = JSON.parse(JSON.stringify(kb));
  if (sanitizedKB.business?.studio?.address) {
    sanitizedKB.business.studio.address = "[REDACTED - Say 'Studio in Suffolk, VA']";
  }
  return `You are a friendly customer support assistant for Motiontography LLC, a photography studio in Hampton Roads, VA.

CRITICAL RULES:
1. **BE BRIEF** - Keep replies under 3 sentences. Answer the specific question asked, nothing more.
2. **DIRECT ANSWERS** - If asked about price, give the price first. If asked about a service, confirm yes/no first.
3. Only use facts from the Knowledge Base. Never invent prices or policies.
4. Never reveal the exact studio address. Say "Studio in Suffolk, VA".
5. If unsure, ask ONE short clarifying question.

EXAMPLES OF GOOD RESPONSES:
- Q: "How much for maternity?" \u2192 A: "Maternity Signature is $750 (studio) or $900 (on-location), 3 hours, 15 images with composites. Book here: https://motiontography.com/booking.html"
- Q: "Do you do graduation photos?" \u2192 A: "Yes! Classic Portrait ($250 studio / $400 on-location) is perfect for graduation. Book: https://motiontography.com/booking.html"
- Q: "Where are you located?" \u2192 A: "Studio in Suffolk, VA. Address shared after booking."

OUTPUT FORMAT (JSON only):
{
  "reply": "Short, direct answer",
  "followups": ["One question max"],
  "escalated": false
}

KNOWLEDGE BASE:
${JSON.stringify(sanitizedKB, null, 2)}`;
}
__name(buildSystemPrompt, "buildSystemPrompt");
async function callGPT4o(message, kb, apiKey) {
  const response = await fetch(OPENAI_CHAT_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: GPT_4O_MODEL,
      messages: [
        { role: "system", content: buildSystemPrompt(kb) },
        { role: "user", content: message }
      ],
      max_tokens: 500,
      temperature: 0.3
    })
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GPT-4o API error ${response.status}: ${errorText}`);
  }
  const data = await response.json();
  return {
    content: data.choices?.[0]?.message?.content || "",
    response_id: null
  };
}
__name(callGPT4o, "callGPT4o");
async function callGPT52(message, kb, apiKey, previousResponseId = null) {
  const requestBody = {
    model: GPT_5_2_MODEL,
    instructions: buildSystemPrompt(kb),
    input: [
      { role: "user", content: message }
    ],
    reasoning: { effort: "medium" },
    max_output_tokens: 500
  };
  if (previousResponseId) {
    requestBody.previous_response_id = previousResponseId;
  }
  console.log(`[GPT-5.2] Calling API with model: ${GPT_5_2_MODEL}`);
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(requestBody)
  });
  const responseText = await response.text();
  if (!response.ok) {
    console.error(`[GPT-5.2 ERROR] Status: ${response.status}`);
    console.error(`[GPT-5.2 ERROR] Body: ${responseText}`);
    throw new Error(`GPT-5.2 API error ${response.status}: ${responseText}`);
  }
  console.log(`[GPT-5.2] Success! Response received.`);
  const data = JSON.parse(responseText);
  let content = "";
  if (data.output_text) {
    content = data.output_text;
  } else if (data.output && Array.isArray(data.output)) {
    const messageOutput = data.output.find((o) => o.type === "message");
    if (messageOutput && messageOutput.content && messageOutput.content[0]) {
      content = messageOutput.content[0].text || "";
    }
  }
  console.log(`[GPT-5.2] Extracted content length: ${content.length}`);
  return {
    content,
    response_id: data.id || null
  };
}
__name(callGPT52, "callGPT52");
async function callLLM(message, kb, apiKey, previousResponseId = null) {
  if (USE_GPT_5_2) {
    return await callGPT52(message, kb, apiKey, previousResponseId);
  } else {
    return await callGPT4o(message, kb, apiKey);
  }
}
__name(callLLM, "callLLM");
function parseModelResponse(rawText) {
  let cleaned = rawText.trim();
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
      reply: String(parsed.reply || ""),
      followups: Array.isArray(parsed.followups) ? parsed.followups : [],
      escalated: Boolean(parsed.escalated)
    };
  } catch (e) {
    return {
      reply: rawText.trim(),
      followups: [],
      escalated: false
    };
  }
}
__name(parseModelResponse, "parseModelResponse");
function scrubAddress(text) {
  if (!text) return text;
  let scrubbed = text.replace(/109\s*Abbey\s*R(oa)?d[^,]*/gi, "Studio in Suffolk, VA");
  scrubbed = scrubbed.replace(/\d+\s+Abbey\s+R(oa)?d/gi, "Studio in Suffolk, VA");
  return scrubbed;
}
__name(scrubAddress, "scrubAddress");
function buildSafeFallback(kb) {
  const phone = kb.business?.primary_phone || "+1-757-759-8454";
  return {
    reply: `I'd be happy to help! Could you tell me a bit more about what you're looking for? Or feel free to contact Roger directly at ${phone} - he can answer any questions!`,
    followups: ["What type of session are you interested in?", "Studio or on-location?"],
    escalated: true
  };
}
__name(buildSafeFallback, "buildSafeFallback");
function buildEscalationReply(kb) {
  const phone = kb.business?.primary_phone || "+1-757-759-8454";
  const contactUrl = kb.official_pages?.contact_page_url || "https://motiontography.com/contact.html";
  return `I don't want to guess and give you the wrong info. Please contact Roger directly at ${phone} (call/text), or use the contact page: ${contactUrl}`;
}
__name(buildEscalationReply, "buildEscalationReply");
function generateUUID() {
  return crypto.randomUUID();
}
__name(generateUUID, "generateUUID");
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
  const previous_response_id = body?.previous_response_id || null;
  if (!message || typeof message !== "string") {
    return jsonResponse({ ok: false, error: "message (string) is required" }, 400);
  }
  let response;
  let matched_intent_id = null;
  let match_score = 0;
  let used_openai = false;
  let escalated = false;
  let response_id = null;
  let model_used = null;
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
    if (env.OPENAI_API_KEY) {
      try {
        const llmResult = await callLLM(message, kb, env.OPENAI_API_KEY, previous_response_id);
        used_openai = true;
        model_used = USE_GPT_5_2 ? GPT_5_2_MODEL : GPT_4O_MODEL;
        response_id = llmResult.response_id;
        const parsed = parseModelResponse(llmResult.content);
        if (parsed.reply) {
          parsed.reply = scrubAddress(parsed.reply);
        }
        response = {
          reply: parsed.reply,
          followups: parsed.followups,
          route_url: null
        };
        escalated = parsed.escalated;
      } catch (err) {
        console.error("[LLM Error]", err.message);
        const safeFallback = buildSafeFallback(kb);
        response = {
          reply: safeFallback.reply,
          followups: safeFallback.followups,
          route_url: null
        };
        escalated = true;
      }
    } else {
      const safeFallback = buildSafeFallback(kb);
      response = {
        reply: safeFallback.reply,
        followups: safeFallback.followups,
        route_url: null
      };
      escalated = true;
    }
  }
  return jsonResponse({
    ok: true,
    session_id,
    response_id,
    matched_intent_id,
    match_score,
    used_openai,
    model_used,
    escalated,
    ...response
  });
}
__name(handleChat, "handleChat");
async function handleHealth(env) {
  const kb = await loadKB();
  return jsonResponse({
    ok: true,
    kb_version: kb.kb_version,
    last_updated_local: kb.last_updated_local,
    openai_enabled: Boolean(env.OPENAI_API_KEY),
    llm_fallback_model: USE_GPT_5_2 ? GPT_5_2_MODEL : GPT_4O_MODEL,
    gpt52_enabled: USE_GPT_5_2
  });
}
__name(handleHealth, "handleHealth");
async function handleTestGPT52(env) {
  if (!env.OPENAI_API_KEY) {
    return jsonResponse({ ok: false, error: "No OPENAI_API_KEY configured" });
  }
  const testPayload = {
    model: GPT_5_2_MODEL,
    instructions: "You are a helpful assistant. Respond with a short greeting.",
    input: [{ role: "user", content: "Hello" }],
    reasoning: { effort: "medium" },
    max_output_tokens: 100
  };
  try {
    const response = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(testPayload)
    });
    const responseText = await response.text();
    return jsonResponse({
      ok: response.ok,
      status: response.status,
      model_tested: GPT_5_2_MODEL,
      endpoint: OPENAI_RESPONSES_URL,
      request_payload: testPayload,
      response_body: responseText.substring(0, 2e3)
      // Truncate if too long
    });
  } catch (err) {
    return jsonResponse({
      ok: false,
      error: err.message,
      model_tested: GPT_5_2_MODEL,
      endpoint: OPENAI_RESPONSES_URL
    });
  }
}
__name(handleTestGPT52, "handleTestGPT52");
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}
__name(jsonResponse, "jsonResponse");
var worker_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;
    if (method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }
    if (url.pathname === "/api/health" && method === "GET") {
      return handleHealth(env);
    }
    if (url.pathname === "/api/chat" && method === "POST") {
      return handleChat(request, env);
    }
    if (url.pathname === "/api/test-gpt52" && method === "GET") {
      return handleTestGPT52(env);
    }
    return jsonResponse({ ok: false, error: "Not found" }, 404);
  }
};
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map

--238f8485fc120279be0c094ee5b2652129cef12e080ea94df22e8c892b1f--
