# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```powershell
# Agent API (port 3002)
npm run agent:dev          # start agent-api
npm run agent:test         # smoke test against running agent-api

# Safety / pipeline evals (require running agent-api + GROQ_API_KEY)
npm run agent:safety-test
npm run agent:pipeline-test
npm run agent:state-test
npm run agent:intent-test
npm run agent:token-test
npm run booking:test

# Database
npm run db:generate        # regenerate Prisma client after schema changes
npm run db:push            # apply schema to empty DB
npm run db:pull            # sync schema from existing DB
npm run db:studio          # open Prisma Studio GUI
npm run db:test            # verify DB connection

# Seed reference data
npm run clinic:seed

# MAX adapter (port 3001) — run from max-adapter/
cd max-adapter && npm install && npm run dev
```

Production full-stack startup (Windows/PowerShell):
```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\start-max-prod.ps1
# If Playwright crashes due to Cyrillic path:
.\start-max-prod.ps1 -MaxProfileDir "C:\Users\Getsu\max-profile-ai-dental-agent"
```

Health checks after startup:
```powershell
Invoke-RestMethod http://localhost:3002/health
Invoke-RestMethod http://localhost:3001/health
Invoke-RestMethod http://localhost:3001/max/watch/status
```

Tail logs:
```powershell
Get-Content -Tail 80 logs\agent-api.prod.err.log
Get-Content -Tail 80 logs\max-adapter.prod.err.log
```

## Architecture

### Services

**agent-api** (`agent-api/src/`, port 3002) — the AI brain and data layer. Express + Prisma + Groq SDK. Entry: `agent-api/src/index.js`.

**max-adapter** (`max-adapter/src/`, port 3001) — Playwright browser automation for MAX (a Russian business messenger). Entry: `max-adapter/src/index.js`. Reads chats from MAX via browser, sends replies through it.

**n8n** — Docker container at port 5678. Acts as the webhook bridge between max-adapter and agent-api. Inside Docker, agent-api must be reached via `http://host.docker.internal:3002`, not `localhost`.

### Message flow

```
MAX (browser) → max-adapter scans chats → enqueues to MaxMessageQueue (DB)
→ queue worker dequeues → sends to n8n webhook → n8n calls agent-api /incoming-message
→ agent-api runs LLM pipeline → returns {reply, intent, action, ...}
→ n8n returns reply to max-adapter → max-adapter sends reply through MAX browser
```

The watcher uses a two-timer pattern: a **scanner** timer (every ~5 s) reads MAX chats and writes to `max_message_queue`, and a **worker** timer (every ~1.5 s) pulls from the queue, calls n8n, and sends replies. This decouples the slow browser from the slow LLM call.

### LLM pipeline (agent-api/src/agent.js)

Three Groq calls per message (each optional/skippable):

1. **Classifier** (`classifyUserIntentWithLLM`) — fast, small model (`CLASSIFIER_MODEL`), reads compact context (~2 k tokens max). Returns structured intent/action JSON. Falls back to local regex heuristics if Groq is unavailable or rate-limited.
2. **Complex model** (`generateAgentResponse`) — larger model (`COMPLEX_MODEL`), full system prompt + clinic knowledge. Produces the actual reply.
3. **Humanizer** (`humanizeReplyWithAI`) — small model, rewrites a safe scripted reply in natural Russian. Skipped for simple states (acknowledgements, collect-name/phone). Blocked if it would change booking intent or add promises absent from the original.

If Groq returns 429/rate-limit at any stage, the agent creates a human-handoff reply instead of an error.

### State and safety guards (agent-api/src/messageService.js)

Application code — not the LLM — enforces:
- **Conversation states**: `idle → answering_question → collecting_booking_data → waiting_booking_confirmation → appointment_booked → cancellation_requested / reschedule_requested / handoff_required / human_takeover`.
- **`create_appointment` gate**: only fires after explicit user confirmation + all required fields (name, phone, service, date, time). If the model proposes it too early, code downgrades the action.
- **Cancel disambiguation**: "удалить зуб" is `tooth_extraction`, not `cancel_appointment`. Only phrases referencing "запись/прием/визит/бронь" trigger cancel logic.
- **Risk handoff**: aggression, bad review threat, legal threat, wrong-booking complaint → `human_takeover`. AI stays silent until admin resolves the handoff.
- **Duplicate protection**: `external_message_id` unique constraint, per-conversation DB locks (30 s TTL), recent-reply debounce (8 s), repeated incoming text window (10 min).

### Reply sanitizer (agent-api/src/replySanitizer.js)

Final gate before any text leaves agent-api. Blocks JSON bleed, internal keys (`intent`, `action`, `memory_patch`, `reasoning`, etc.), markdown fences.

### Prompt files (prompts/)

- `dental_admin_system_prompt.md` — core persona and safety rules (loaded once per complex call)
- `clinic_knowledge.md` — services, prices, booking rules (edit here to change what the agent knows)
- `intent_classifier_runtime_prompt.md` — compact prompt for the fast classifier

### Database schema (prisma/schema.prisma)

Core tables: `contacts`, `conversations`, `messages`, `conversation_memory`, `appointment_requests`, `appointment_slots`, `appointment_reminders`, `agent_actions`, `handoffs`. Operational tables: `max_message_queue`, `outbound_message_queue`, `broadcast_campaigns`, `max_chat_state`. Reference tables: `doctors`, `doctor_schedules`, `clinic_services`, `service_categories`, `follow_up_rules`, `clinic_settings`.

`appointment_slots` has a unique `(slot_date, slot_time)` constraint — slot conflicts are resolved at DB level.

### Outbound / reminders

`agent-api /reminders/due` returns pending reminders. max-adapter polls this every 60 s and sends them through MAX. Reminders are only sent inside `REMINDER_SEND_WINDOW_START`..`REMINDER_SEND_WINDOW_END` (default 09:00–21:00 Europe/Moscow).

Broadcast campaigns write rows to `outbound_message_queue`; the same worker timer in max-adapter drains them.

### Key env vars

```env
DATABASE_URL=postgresql://...
GROQ_API_KEY=...
N8N_WEBHOOK_URL=http://localhost:5678/webhook/incoming-message
AGENT_API_URL=http://localhost:3002
CLASSIFIER_MODEL=llama-3.1-8b-instant
COMPLEX_MODEL=llama-3.3-70b-versatile
COMPLEX_MODEL_ENABLED=true
HUMANIZER_MODEL=llama-3.1-8b-instant
HUMANIZER_ENABLED=true
HUMANIZER_ONLY_FOR_COMPLEX=true
HUMANIZER_SKIP_SIMPLE=true
MAX_CLASSIFIER_INPUT_TOKENS=2000
MAX_LAST_MESSAGES=6
WORKING_HOURS_JSON=...   # optional, default Mon-Sat 09:00-20:00
HANDOFF_RULES_JSON=...   # optional
```

### Admin UI

`http://localhost:3002/admin` — lists conversations, handoffs, appointments. Resolving a handoff from here returns the conversation to active AI mode.

### MAX browser profile

Stored in `max-adapter/.auth/max-profile`. Login survives adapter restarts. On first run or new profile path, log in to MAX manually and call `POST http://localhost:3001/max/inspect` to capture selectors.
