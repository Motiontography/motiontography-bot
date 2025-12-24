# motiontography-bot

KB-driven FAQ bot API for Motiontography with OpenAI GPT-powered intelligent routing.

## Features

- **Strict KB Grounding**: Only answers from `motiontography_kb.json` — no hallucinations
- **OpenAI GPT Integration**: Understands varied phrasing (e.g., "What do I wear?" matches wardrobe intent)
- **Automatic Fallback**: Falls back to keyword matching if OpenAI is unavailable
- **Privacy Protection**: Never reveals studio address until client has booked/paid
- **FAQ Candidate Logging**: Unanswered questions logged for review

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
```

Edit `.env` and add your OpenAI API key:
```
OPENAI_API_KEY=sk-your-actual-key-here
OPENAI_MODEL=gpt-4o
OPENAI_REASONING_EFFORT=high
```

### 3. Run the server
```bash
node server.js
```

Or use the start script:
```bash
./start.sh
```

## Endpoints

### POST /api/chat
Send a message and get a response.

```bash
curl -X POST http://localhost:5050/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "What should I wear?", "session_id": "test-001"}'
```

Response:
```json
{
  "ok": true,
  "session_id": "test-001",
  "matched_intent_id": "what_to_wear",
  "match_score": 0.92,
  "used_openai": true,
  "escalated": false,
  "reply": "Great question! Here are some general tips...",
  "followups": ["What type of session are you booking?"]
}
```

### POST /api/reload-kb (admin)
Reload the knowledge base without restarting.

```bash
curl -X POST http://localhost:5050/api/reload-kb \
  -H "x-admin-token: YOUR_ADMIN_TOKEN"
```

### GET /api/health
Check server status and configuration.

## Acceptance Tests

Test these queries to verify the bot works correctly:

```bash
# 1. Gift cards (should match gift_cards intent)
curl -X POST http://localhost:5050/api/chat -H "Content-Type: application/json" \
  -d '{"message": "Do you have gift cards?"}'

# 2. Wardrobe (should match what_to_wear intent)
curl -X POST http://localhost:5050/api/chat -H "Content-Type: application/json" \
  -d '{"message": "What do I wear for a maternity shoot?"}'

# 3. Alcohol (should match alcohol_policy and escalate)
curl -X POST http://localhost:5050/api/chat -H "Content-Type: application/json" \
  -d '{"message": "Can I bring champagne?"}'

# 4. Travel (should match travel_outside_area)
curl -X POST http://localhost:5050/api/chat -H "Content-Type: application/json" \
  -d '{"message": "Do you travel to Richmond?"}'

# 5. Portfolio (should match portfolio_examples)
curl -X POST http://localhost:5050/api/chat -H "Content-Type: application/json" \
  -d '{"message": "Can I see more examples?"}'

# 6. Address protection (should NOT reveal exact address)
curl -X POST http://localhost:5050/api/chat -H "Content-Type: application/json" \
  -d '{"message": "What is your studio address?"}'
```

## File Structure

```
motiontography-bot/
├── server.js                 # Main Express server
├── lib/
│   └── openai.js             # OpenAI API integration
├── motiontography_kb.json    # Knowledge base (source of truth)
├── logs/                     # Transcripts & FAQ candidates
├── .env                      # Local config (gitignored)
├── .env.example              # Template for .env
└── README.md
```

## Adding New Q&As

Edit `motiontography_kb.json` and add to `intents_and_answers`:

```json
{
  "id": "my_new_intent",
  "intent": "description",
  "triggers": ["keyword1", "keyword2", "phrase to match"],
  "answer": "Your response here. Include links from official_pages if relevant.",
  "followups": ["Optional follow-up question?"]
}
```

Then reload: `POST /api/reload-kb` or restart the server.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| PORT | No | 5050 | Server port |
| ADMIN_TOKEN | No | - | Token for admin endpoints |
| OPENAI_API_KEY | No | - | Enables AI routing (falls back to keywords if not set) |
| OPENAI_MODEL | No | gpt-4o | OpenAI model to use |
| OPENAI_REASONING_EFFORT | No | high | Reasoning depth: low/medium/high/xhigh |
| OPENAI_TEXT_VERBOSITY | No | low | Response length: low/medium/high |
| OPENAI_MAX_OUTPUT_TOKENS | No | 500 | Max response length |
