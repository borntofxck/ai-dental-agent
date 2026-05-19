# n8n Workflow

Main workflow name: `incoming_message`.

Expected webhook input from MAX adapter:

```json
{
  "channel": "max",
  "max_user_id": "123456",
  "display_name": "Anna",
  "message_text": "Здравствуйте, хочу записаться",
  "external_message_id": "message-id-from-max",
  "raw_payload": {}
}
```

Expected response to MAX adapter:

```json
{
  "reply": "Здравствуйте. Подскажите, пожалуйста, на какой день вам удобно записаться?"
}
```

MVP workflow steps:

1. Webhook receives message.
2. PostgreSQL finds or creates contact.
3. PostgreSQL finds or creates active conversation.
4. PostgreSQL saves incoming message.
5. Workflow loads recent messages and memory.
6. AI model generates a safe administrator response.
7. PostgreSQL saves outgoing message.
8. Workflow updates conversation memory.
9. Workflow returns reply to adapter.
