import dotenv from "dotenv";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config({ path: new URL("../../.env", import.meta.url) });

const adapterRoot = fileURLToPath(new URL("../", import.meta.url));
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const userDataDir = process.env.MAX_USER_DATA_DIR
  ? path.resolve(projectRoot, process.env.MAX_USER_DATA_DIR)
  : path.resolve(adapterRoot, ".auth/max-profile");
const artifactsDir = process.env.MAX_ARTIFACTS_DIR
  ? path.resolve(projectRoot, process.env.MAX_ARTIFACTS_DIR)
  : path.resolve(adapterRoot, "artifacts");

mkdirSync(userDataDir, { recursive: true });
mkdirSync(artifactsDir, { recursive: true });

export const config = {
  port: Number(process.env.MAX_ADAPTER_PORT || 3001),
  maxWebUrl: process.env.MAX_WEB_URL || "https://web.max.ru/",
  n8nWebhookUrl: process.env.N8N_WEBHOOK_URL || "http://localhost:5678/webhook/incoming-message",
  agentApiUrl: process.env.AGENT_API_URL || "http://localhost:3002",
  maxPollIntervalMs: Number(process.env.MAX_POLL_INTERVAL_MS || 5000),
  reminderPollIntervalMs: Number(process.env.REMINDER_POLL_INTERVAL_MS || 60000),
  openBrowser: process.env.MAX_OPEN_BROWSER !== "false",
  headless: process.env.MAX_HEADLESS === "true",
  userDataDir,
  artifactsDir,
  selectors: {
    chatList: process.env.MAX_SELECTOR_CHAT_LIST || "",
    chatItem: process.env.MAX_SELECTOR_CHAT_ITEM || "aside .item[data-index] button.cell",
    messageList: process.env.MAX_SELECTOR_MESSAGE_LIST || "",
    messageItem: process.env.MAX_SELECTOR_MESSAGE_ITEM || "main .history [role='listitem']",
    messageInput: process.env.MAX_SELECTOR_MESSAGE_INPUT || "[data-testid='composer'] [role='textbox'][data-lexical-editor='true']",
    sendButton: process.env.MAX_SELECTOR_SEND_BUTTON || "button[aria-label='Отправить сообщение']"
  }
};
