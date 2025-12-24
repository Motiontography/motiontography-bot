/**
 * OpenAI GPT-5.2 Router + Responder for Motiontography Bot
 * Uses OpenAI Responses API with reasoning/thinking capabilities
 *
 * STRICT GROUNDING: Only uses facts from the KB JSON. Never hallucinate.
 */

const OPENAI_API_URL = "https://api.openai.com/v1/responses";

/**
 * Build the system prompt with strict grounding rules
 */
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

/**
 * Call OpenAI Responses API with GPT-5.2 and reasoning
 */
async function callOpenAI(message, kb, config) {
  const {
    apiKey,
    model = "gpt-4o",
    reasoningEffort = "high",
    textVerbosity = "low",
    maxOutputTokens = 500
  } = config;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const systemPrompt = buildSystemPrompt(kb);

  // Build request body for OpenAI Responses API
  const requestBody = {
    model: model,
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: message }
    ],
    max_output_tokens: maxOutputTokens
  };

  // Add reasoning config if model supports it (gpt-4o and later)
  if (model.includes("gpt-4") || model.includes("gpt-5") || model.includes("o1") || model.includes("o3")) {
    requestBody.reasoning = { effort: reasoningEffort };
    if (textVerbosity) {
      requestBody.text = { format: { type: "text" } };
    }
  }

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

  // Extract the text content from the response
  // Responses API returns output array with content
  let textContent = "";

  if (data.output && Array.isArray(data.output)) {
    for (const item of data.output) {
      if (item.type === "message" && item.content) {
        for (const content of item.content) {
          if (content.type === "output_text" || content.type === "text") {
            textContent += content.text || "";
          }
        }
      }
    }
  }

  // Fallback for different response formats
  if (!textContent && data.choices?.[0]?.message?.content) {
    textContent = data.choices[0].message.content;
  }

  if (!textContent) {
    throw new Error("No text content in OpenAI response");
  }

  return textContent;
}

/**
 * Parse the model's JSON response safely
 */
function parseModelResponse(rawText) {
  // Clean up potential markdown code blocks
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

    // Validate required fields
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

/**
 * Main function: Route and answer using OpenAI GPT-5.2
 * Returns structured response or throws error for fallback handling
 */
async function openAiRouteAndAnswer(message, kb, config) {
  const rawResponse = await callOpenAI(message, kb, config);
  const parsed = parseModelResponse(rawResponse);

  // Double-check: scrub any leaked address from reply
  if (parsed.reply) {
    // Remove any potential address leaks (109 Abbey Rd pattern)
    parsed.reply = parsed.reply.replace(/109\s*Abbey\s*R(oa)?d[^,]*/gi, "Studio in Suffolk, VA");
    parsed.reply = parsed.reply.replace(/\d+\s+Abbey\s+R(oa)?d/gi, "Studio in Suffolk, VA");
  }

  return parsed;
}

module.exports = {
  openAiRouteAndAnswer,
  buildSystemPrompt,
  parseModelResponse
};
