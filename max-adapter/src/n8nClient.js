import { config } from "./config.js";

export async function sendIncomingMessageToN8n(message) {
  const response = await fetch(config.n8nWebhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(message)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`n8n webhook failed: ${response.status} ${text}`);
  }

  return response.json();
}
