# AI Agent For Dental Clinic

MVP of an AI administrator for a dental clinic.

## Database

Recommended local database name:

```sql
CREATE DATABASE ai_dental_agent;
```

If you want to apply the raw SQL schema:

```bash
psql -d ai_dental_agent -f database/schema.sql
```

## Project Structure

```text
agent-api/    HTTP API with Prisma + AI logic
database/     PostgreSQL schema
docs/         architecture notes
max-adapter/  Node.js service for MAX web automation
n8n/          exported n8n workflows
prisma/       Prisma schema and database mapping
prompts/      AI system prompts
scripts/      helper scripts
```

## Clinic Knowledge

The AI agent uses two prompt files:

```text
prompts/dental_admin_system_prompt.md  core behavior and safety rules
prompts/clinic_knowledge.md            clinic services, prices, booking rules
```

Edit `prompts/clinic_knowledge.md` to change service descriptions, approximate prices, clinic policies and escalation rules. The agent treats prices as approximate and should not promise a final treatment cost before a doctor's examination.

## Prisma Setup

1. Copy `.env.example` to `.env`.
2. Put your real PostgreSQL connection string into `DATABASE_URL`.

Example:

```env
DATABASE_URL=postgresql://postgres:password@localhost:5432/ai_dental_agent
```

Install dependencies and generate Prisma Client:

```bash
npm install
npm run db:generate
```

If the database already has tables, sync Prisma schema from it:

```bash
npm run db:pull
npm run db:generate
```

If the database is empty and Prisma should create tables:

```bash
npm run db:push
npm run db:generate
```

Check connection:

```bash
npm run db:test
```

Open Prisma Studio:

```bash
npm run db:studio
```

## Agent API

Run the agent API:

```bash
npm run agent:dev
```

Health check:

```bash
curl http://localhost:3002/health
```

Test incoming message:

```bash
curl -X POST http://localhost:3002/incoming-message \
  -H "content-type: application/json" \
  -d "{\"channel\":\"MAX\",\"max_user_id\":\"test_001\",\"display_name\":\"Anna\",\"message_text\":\"Hello, I want to book an appointment\"}"
```

The endpoint saves contact, conversation, incoming message, outgoing message, memory and agent action through Prisma.
When enough booking data is collected, it also creates or updates an `appointment_requests` row, reserves an `appointment_slots` row, and creates pending `appointment_reminders`.

Production reply safety:

```text
The LLM is asked for strict structured output: reply, intent, action, should_handoff, urgency and memory_patch.
Only reply is allowed to leave Agent API and be sent to MAX.
Sanitizers block JSON, reasoning, action/memory/status/tool text and other internal artifacts before sending.
Sanitizers do not decide dialogue from the user's text. Rude/noisy/complaint messages are handled by the state/action guard layer first.
Duplicate protection uses external_message_id, per-conversation locks, recent reply debounce and repeated incoming text checks.
```

Appointment confirmation gate:

```text
Questions about doctors, prices, consultation cost or "when can I come" are treated as information requests.
The backend does not create appointments from model output alone.
create_appointment is allowed only after explicit user confirmation plus required booking data: reason/service, date, time and patient contact details.
If the gate is not passed, appointment_requests, appointment_slots and appointment_reminders are not created.
If the model proposes create_appointment too early, code downgrades the action, logs the event and asks for the missing detail instead.
Fallback responses are emergency-only: LLM failure, invalid JSON, empty answer or unsafe reply.
```

State/action guards:

```text
Conversation state is tracked in memory: idle, answering_question, collecting_booking_data,
waiting_booking_confirmation, appointment_booked, cancellation_requested, reschedule_requested,
handoff_required.
Cancel intent has priority over booking and reschedule. Messages like "отменить", "удалите",
"не надо", "денег нет", "зачем вы меня записали" clear pending booking data, cancel pending
reminders and block create_appointment. Angry wrong-booking complaints create a handoff.
Dental service disambiguation runs before cancel validation: "удалить зуб", "удалить зуб мудрости",
"вырвать зуб" and similar phrases are treated as tooth_extraction / wisdom_tooth_extraction,
not as appointment cancellation. Only explicit references to запись, прием, визит or бронь can
trigger cancel_appointment.
```

Safe reply pipeline:

```text
Business code builds a safe scripted reply for guarded states such as cancellation, reschedule,
booking progress, booking confirmation, abuse/complaint and noisy messages.
The AI humanizer may only paraphrase that safe reply. It cannot change action, add slots,
prices or booking promises. The final text still passes through sanitizer before MAX sees it.
If humanizer fails or changes meaning, Agent API sends the original safe scripted reply.
Repeated emergency/noise fallback text is varied when the previous outgoing reply was the same.
```

Reminder daytime window:

```text
Agent replies to incoming user messages at any time.
Scheduled reminders/reactivation messages are sent only inside REMINDER_SEND_WINDOW_START..REMINDER_SEND_WINDOW_END
in REMINDER_TIMEZONE. Defaults: 09:00..21:00 Europe/Moscow.
Due reminders outside that window are delayed to the next allowed daytime slot.
Cancelled and needs_admin_review appointments block pending reminders.
```

Safety eval:

```bash
npm run agent:safety-test
npm run agent:pipeline-test
npm run agent:state-test
```

Slot protection:

```text
appointment_slots has a unique date + time constraint.
If two clients ask for the same date and time, the first request reserves the slot and the second one gets a "time is already booked" reply.
```

Reminder endpoints:

```text
GET  http://localhost:3002/reminders/due
POST http://localhost:3002/reminders/:id/sent
POST http://localhost:3002/reminders/:id/failed
```

## MAX Adapter

Run the MAX adapter:

```bash
cd max-adapter
npm install
npm run dev
```

For a smoke test without opening the MAX browser window:

```powershell
$env:MAX_OPEN_BROWSER="false"
cd max-adapter
npm run dev
```

Useful MAX adapter endpoints:

```text
GET  http://localhost:3001/health
GET  http://localhost:3001/max/status
POST http://localhost:3001/max/start
POST http://localhost:3001/max/stop
POST http://localhost:3001/max/inspect
POST http://localhost:3001/max/screenshot
GET  http://localhost:3001/max/messages
GET  http://localhost:3001/max/chats
POST http://localhost:3001/max/open-chat
GET  http://localhost:3001/max/active-chat/messages
POST http://localhost:3001/max/process-active
POST http://localhost:3001/max/process-all
GET  http://localhost:3001/max/watch/status
POST http://localhost:3001/max/watch/start
POST http://localhost:3001/max/watch/stop
GET  http://localhost:3001/reminders/watch/status
POST http://localhost:3001/reminders/watch/start
POST http://localhost:3001/reminders/watch/stop
POST http://localhost:3001/reminders/process-due
POST http://localhost:3001/send-message
```

The MAX browser profile is stored in `max-adapter/.auth/max-profile`, so login should survive adapter restarts.

First MAX setup flow:

```text
1. Run agent-api.
2. Keep n8n running.
3. Run max-adapter with browser enabled.
4. Log in to MAX manually in the opened browser.
5. Call /max/inspect after login.
6. Use the saved screenshot and HTML to configure selectors in .env.
```

Manual real MAX test flow:

```powershell
# 1. Open the first chat in the MAX sidebar.
Invoke-RestMethod `
  -Uri "http://localhost:3001/max/open-chat" `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"index":0}'

# 2. Check visible messages in the active chat.
Invoke-RestMethod `
  -Uri "http://localhost:3001/max/active-chat/messages?limit=10"

# 3. Send the latest incoming message through n8n + agent-api and reply in MAX.
Invoke-RestMethod `
  -Uri "http://localhost:3001/max/process-active" `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"limit":10}'

# 4. Start automatic replies for the currently opened MAX chat.
Invoke-RestMethod `
  -Uri "http://localhost:3001/max/watch/start" `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"interval_ms":5000,"mode":"active"}'

# 4b. Start automatic replies for all regular MAX chats.
Invoke-RestMethod `
  -Uri "http://localhost:3001/max/watch/start" `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"interval_ms":5000,"mode":"all"}'

# 5. Check watcher status.
Invoke-RestMethod `
  -Uri "http://localhost:3001/max/watch/status"

# 6. Stop automatic replies.
Invoke-RestMethod `
  -Uri "http://localhost:3001/max/watch/stop" `
  -Method Post

# 7. Start appointment reminders.
Invoke-RestMethod `
  -Uri "http://localhost:3001/reminders/watch/start" `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"interval_ms":60000}'

# 8. Check reminder watcher status.
Invoke-RestMethod `
  -Uri "http://localhost:3001/reminders/watch/status"
```

`/max/process-active` processes only the currently opened MAX chat. `/max/process-all` opens each regular chat, checks whether the last message is incoming, sends new incoming messages to the n8n production webhook, waits for the AI agent response, saves data through `agent-api`, and sends the reply back through MAX.
`/max/watch/start` keeps doing the same check automatically. Use `mode: "all"` for multi-chat mode or `mode: "active"` for only the currently opened chat.
`/reminders/watch/start` checks due appointment reminders and sends them through MAX.

## First Test Through Adapter

After n8n webhook is ready, send a test request to the adapter:

```bash
curl -X POST http://localhost:3001/test-message \
  -H "content-type: application/json" \
  -d "{\"message_text\":\"Hello, I want to book an appointment\"}"
```
