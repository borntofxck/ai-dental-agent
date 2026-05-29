# Reply Safety Flow

## Purpose

Messenger users must receive only a clean human administrator reply. Internal model output, JSON, memory, action, reasoning, tool calls and service statuses stay inside the backend.

## Flow

1. MAX adapter reads an incoming MAX message.
   - File: `max-adapter/src/index.js`
   - Functions: `processActiveChat`, `enqueueActiveChatMessage`, `processQueuedMessage`
   - Protection: outgoing/latest assistant messages are skipped before they reach Agent API.

2. MAX adapter sends the payload to n8n.
   - File: `max-adapter/src/n8nClient.js`
   - Payload includes `channel`, `max_user_id`, `display_name`, `message_text`, `external_message_id`.

3. n8n calls Agent API.
   - Endpoint: `POST /incoming-message`
   - File: `agent-api/src/index.js`
   - Handler: `processIncomingMessage`.

4. Agent API deduplicates and locks the conversation.
   - File: `agent-api/src/messageService.js`
   - Protections:
     - ignores payloads marked as outgoing or assistant;
     - uses `external_message_id` unique index;
     - uses `conversation_processing_locks` with lock token;
     - skips repeated latest incoming text;
     - skips duplicate recent outgoing replies.

5. Agent API saves the incoming message and loads context.
   - Tables: `contacts`, `conversations`, `messages`, `conversation_memory`, `appointment_requests`.
   - Only recent relevant messages are sent to the LLM.

6. LLM generates structured output.
   - File: `agent-api/src/agent.js`
   - Function: `generateAgentResponse`.
   - Model is requested with JSON object response format and a strict schema:
     `reply`, `intent`, `action`, `should_handoff`, `handoff_reason`, `urgency`, `memory_patch`.

7. Backend sanitizes and validates model output.
   - File: `agent-api/src/replySanitizer.js`
   - Function: `normalizeStructuredAgentOutput`, `sanitizeReplyForUser`.
   - Only `reply` can be sent to a user.
   - Suspicious JSON/internal text is replaced with a safe fallback.

8. Code decides business actions.
   - File: `agent-api/src/messageService.js`
   - The AI proposes intent/action/memory, but code validates booking fields, slot conflicts, handoff and memory updates.

9. Agent API saves outgoing message, memory and action.
   - Tables: `messages`, `conversation_memory`, `agent_actions`, `handoffs`, `appointment_requests`, `appointment_slots`, `appointment_reminders`.
   - Internal action and memory are stored in DB, not sent to messenger.

10. MAX adapter sends only `reply`.
    - File: `max-adapter/src/index.js`
    - Function: `cleanReplyForMessenger`.
    - Adapter blocks JSON/internal text again before `maxClient.sendMessage`.

## Local Checks

```bash
npm run agent:safety-test
npm run booking:test
npm run db:test
npm run agent:test
```
