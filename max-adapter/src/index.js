import express from "express";
import crypto from "node:crypto";
import { MaxClient } from "./maxClient.js";
import { sendIncomingMessageToN8n } from "./n8nClient.js";
import { config } from "./config.js";

const app = express();
const maxClient = new MaxClient();
const processedMessageKeys = new Set();
const watcher = {
  timer: null,
  running: false,
  processing: false,
  mode: "all",
  intervalMs: config.maxPollIntervalMs,
  startedAt: null,
  lastResult: null,
  lastError: null
};
const reminderWatcher = {
  timer: null,
  running: false,
  processing: false,
  intervalMs: config.reminderPollIntervalMs,
  startedAt: null,
  lastResult: null,
  lastError: null
};

app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "max-adapter" });
});

app.post("/max/start", async (req, res) => {
  try {
    await maxClient.start();
    res.json(await maxClient.status());
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/max/stop", async (req, res) => {
  try {
    await maxClient.stop();
    res.json({ stopped: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/max/status", async (req, res) => {
  try {
    res.json(await maxClient.status());
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/max/goto", async (req, res) => {
  try {
    res.json(await maxClient.goto(req.body.url));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/max/inspect", async (req, res) => {
  try {
    res.json(await maxClient.inspect());
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/max/screenshot", async (req, res) => {
  try {
    res.json(await maxClient.screenshot());
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/max/messages", async (req, res) => {
  try {
    res.json(await maxClient.readVisibleMessages(Number(req.query.limit || 20)));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/max/chats", async (req, res) => {
  try {
    res.json({ chats: await maxClient.listChats() });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/max/open-chat", async (req, res) => {
  try {
    res.json(await maxClient.openChat({ name: req.body.name, index: req.body.index }));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/max/active-chat/messages", async (req, res) => {
  try {
    res.json(await maxClient.readActiveChatMessages(Number(req.query.limit || 20)));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/max/process-active", async (req, res) => {
  try {
    res.json(await processActiveChat({ limit: Number(req.body.limit || 20), force: Boolean(req.body.force) }));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/max/process-all", async (req, res) => {
  try {
    res.json(await processAllChats({
      limit: Number(req.body.limit || 20),
      maxChats: Number(req.body.max_chats || 20),
      force: Boolean(req.body.force),
      onlyUnread: Boolean(req.body.only_unread)
    }));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/max/watch/status", (req, res) => {
  res.json(getWatcherStatus());
});

app.post("/max/watch/start", async (req, res) => {
  try {
    watcher.mode = req.body.mode === "active" ? "active" : "all";

    if (req.body.interval_ms) {
      watcher.intervalMs = Math.max(2000, Number(req.body.interval_ms));
    }

    if (!watcher.timer) {
      watcher.running = true;
      watcher.startedAt = new Date();
      watcher.timer = setInterval(runWatcherTick, watcher.intervalMs);
    }

    const firstRun = await runWatcherTick({ force: Boolean(req.body.force) });
    res.json({ ...getWatcherStatus(), first_run: firstRun });
  } catch (error) {
    watcher.lastError = error.message;
    console.error(error);
    res.status(500).json({ error: error.message, watcher: getWatcherStatus() });
  }
});

app.post("/max/watch/stop", (req, res) => {
  stopWatcher();
  res.json(getWatcherStatus());
});

app.post("/test-message", async (req, res) => {
  try {
    const payload = {
      channel: "max",
      max_user_id: req.body.max_user_id || "test-user",
      display_name: req.body.display_name || "Test User",
      message_text: req.body.message_text,
      external_message_id: req.body.external_message_id || `test-${Date.now()}`,
      raw_payload: req.body
    };

    const n8nResponse = await sendIncomingMessageToN8n(payload);
    res.json(n8nResponse);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/send-message", async (req, res) => {
  try {
    await maxClient.sendMessage(req.body.chat_id, req.body.text);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/reminders/watch/status", (req, res) => {
  res.json(getReminderWatcherStatus());
});

app.post("/reminders/watch/start", async (req, res) => {
  try {
    if (req.body.interval_ms) {
      reminderWatcher.intervalMs = Math.max(10000, Number(req.body.interval_ms));
    }

    if (!reminderWatcher.timer) {
      reminderWatcher.running = true;
      reminderWatcher.startedAt = new Date();
      reminderWatcher.timer = setInterval(runReminderWatcherTick, reminderWatcher.intervalMs);
    }

    const firstRun = await runReminderWatcherTick();
    res.json({ ...getReminderWatcherStatus(), first_run: firstRun });
  } catch (error) {
    reminderWatcher.lastError = error.message;
    console.error(error);
    res.status(500).json({ error: error.message, watcher: getReminderWatcherStatus() });
  }
});

app.post("/reminders/watch/stop", (req, res) => {
  stopReminderWatcher();
  res.json(getReminderWatcherStatus());
});

app.post("/reminders/process-due", async (req, res) => {
  try {
    res.json(await processDueReminders(Number(req.body.limit || 20)));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(config.port, async () => {
  console.log(`MAX adapter API listening on http://localhost:${config.port}`);
  if (config.openBrowser) {
    await maxClient.start();
  } else {
    console.log("MAX browser startup skipped because MAX_OPEN_BROWSER=false");
  }
});

process.on("SIGINT", async () => {
  stopWatcher();
  stopReminderWatcher();
  await maxClient.stop();
  process.exit(0);
});

async function runWatcherTick(options = {}) {
  if (watcher.processing) {
    return { ok: true, skipped: true, reason: "Previous watcher tick is still running" };
  }

  watcher.processing = true;

  try {
    const result = watcher.mode === "active"
      ? await processActiveChat({ limit: 20, force: Boolean(options.force), throwIfNoMessage: false })
      : await processAllChats({ limit: 20, maxChats: 20, force: Boolean(options.force), throwIfNoMessage: false });
    watcher.lastResult = { ...result, checked_at: new Date().toISOString() };
    watcher.lastError = null;
    return watcher.lastResult;
  } catch (error) {
    watcher.lastError = error.message;
    console.error("MAX watcher failed:", error);
    return { ok: false, error: error.message };
  } finally {
    watcher.processing = false;
  }
}

async function processAllChats({
  limit = 20,
  maxChats = 20,
  force = false,
  onlyUnread = false,
  throwIfNoMessage = true
} = {}) {
  const chats = await maxClient.listChats();
  const candidates = chats
    .filter((chat) => shouldScanChat(chat, { onlyUnread }))
    .slice(0, maxChats);

  const results = [];

  for (const chat of candidates) {
    try {
      await maxClient.openChat({ index: chat.index });
      const result = await processActiveChat({
        limit,
        force,
        throwIfNoMessage: false,
        source: "max-all-chats-watcher",
        sourceChat: chat
      });

      results.push({
        chat_index: chat.index,
        chat_name: chat.name,
        ...result
      });
    } catch (error) {
      results.push({
        ok: false,
        chat_index: chat.index,
        chat_name: chat.name,
        error: error.message
      });
    }
  }

  const answered = results.filter((result) => result.max_reply_sent).length;
  const skipped = results.filter((result) => result.skipped).length;
  const failed = results.filter((result) => result.ok === false).length;

  if (!results.length && throwIfNoMessage) {
    throw new Error("No MAX chats found for processing");
  }

  return {
    ok: failed === 0,
    mode: "all",
    chats_seen: chats.length,
    chats_checked: candidates.length,
    answered,
    skipped,
    failed,
    results
  };
}

async function processActiveChat({
  limit = 20,
  force = false,
  throwIfNoMessage = true,
  source = "max-active-chat",
  sourceChat = null
} = {}) {
  const activeChat = await maxClient.getActiveChatInfo();
  const chatMessages = await maxClient.readActiveChatMessages(limit);
  const latestIncoming = chatMessages.messages.at(-1);

  if (!latestIncoming || latestIncoming.direction !== "incoming") {
    if (throwIfNoMessage) {
      throw new Error("Latest MAX chat message is not incoming");
    }

    return { ok: true, skipped: true, reason: "Latest MAX chat message is not incoming" };
  }

  const cleanText = cleanMaxMessageText(latestIncoming.text);
  if (!cleanText) {
    if (throwIfNoMessage) {
      throw new Error("Latest incoming message is empty after cleanup");
    }

    return { ok: true, skipped: true, reason: "Latest incoming message is empty after cleanup" };
  }

  const chatId = getActiveChatId(await maxClient.status(), activeChat);
  const messageKey = makeMessageKey(chatId, cleanText);

  if (!force && processedMessageKeys.has(messageKey)) {
    return {
      ok: true,
      skipped: true,
      reason: "Message was already processed by this adapter session",
      chat_id: chatId,
      message_text: cleanText
    };
  }

  const payload = {
    channel: "max",
    max_user_id: chatId,
    display_name: activeChat.name || activeChat.title || "MAX User",
    message_text: cleanText,
    external_message_id: messageKey,
    raw_payload: {
      source,
      source_chat: sourceChat,
      active_chat: activeChat,
      latest_message: latestIncoming
    }
  };

  const n8nResponse = await sendIncomingMessageToN8n(payload);

  if (n8nResponse.reply) {
    await maxClient.sendMessage(chatId, n8nResponse.reply);
  }

  processedMessageKeys.add(messageKey);

  return {
    ok: true,
    sent_to_n8n: payload,
    n8n_response: n8nResponse,
    max_reply_sent: Boolean(n8nResponse.reply)
  };
}

function stopWatcher() {
  if (watcher.timer) {
    clearInterval(watcher.timer);
  }

  watcher.timer = null;
  watcher.running = false;
  watcher.processing = false;
}

function getWatcherStatus() {
  return {
    running: watcher.running,
    processing: watcher.processing,
    mode: watcher.mode,
    interval_ms: watcher.intervalMs,
    started_at: watcher.startedAt?.toISOString() || null,
    last_result: watcher.lastResult,
    last_error: watcher.lastError,
    processed_messages: processedMessageKeys.size
  };
}

async function runReminderWatcherTick() {
  if (reminderWatcher.processing) {
    return { ok: true, skipped: true, reason: "Previous reminder tick is still running" };
  }

  reminderWatcher.processing = true;

  try {
    const result = await processDueReminders(20);
    reminderWatcher.lastResult = { ...result, checked_at: new Date().toISOString() };
    reminderWatcher.lastError = null;
    return reminderWatcher.lastResult;
  } catch (error) {
    reminderWatcher.lastError = error.message;
    console.error("Reminder watcher failed:", error);
    return { ok: false, error: error.message };
  } finally {
    reminderWatcher.processing = false;
  }
}

async function processDueReminders(limit = 20) {
  const dueResponse = await fetch(`${config.agentApiUrl}/reminders/due?limit=${limit}`);
  if (!dueResponse.ok) {
    throw new Error(`Agent API reminders/due failed: ${dueResponse.status} ${await dueResponse.text()}`);
  }

  const due = await dueResponse.json();
  const results = [];

  for (const reminder of due.reminders || []) {
    try {
      await maxClient.openChatByChatId(reminder.max_user_id);
      await maxClient.sendMessage(reminder.max_user_id, reminder.text);
      await markReminder(reminder.id, "sent");
      results.push({ ok: true, reminder_id: reminder.id, max_user_id: reminder.max_user_id });
    } catch (error) {
      await markReminder(reminder.id, "failed", error.message).catch(() => {});
      results.push({ ok: false, reminder_id: reminder.id, max_user_id: reminder.max_user_id, error: error.message });
    }
  }

  const sent = results.filter((result) => result.ok).length;
  const failed = results.filter((result) => !result.ok).length;

  return {
    ok: failed === 0,
    due: due.reminders?.length || 0,
    sent,
    failed,
    results
  };
}

async function markReminder(id, status, error = null) {
  const endpoint = status === "sent" ? "sent" : "failed";
  const response = await fetch(`${config.agentApiUrl}/reminders/${id}/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ error })
  });

  if (!response.ok) {
    throw new Error(`Agent API reminder mark failed: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

function stopReminderWatcher() {
  if (reminderWatcher.timer) {
    clearInterval(reminderWatcher.timer);
  }

  reminderWatcher.timer = null;
  reminderWatcher.running = false;
  reminderWatcher.processing = false;
}

function getReminderWatcherStatus() {
  return {
    running: reminderWatcher.running,
    processing: reminderWatcher.processing,
    interval_ms: reminderWatcher.intervalMs,
    started_at: reminderWatcher.startedAt?.toISOString() || null,
    last_result: reminderWatcher.lastResult,
    last_error: reminderWatcher.lastError
  };
}

function shouldScanChat(chat, { onlyUnread = false } = {}) {
  const name = (chat.name || "").trim();
  if (!name || ["MAX", "Избранное"].includes(name)) {
    return false;
  }

  if (!onlyUnread) return true;

  return Boolean(chat.unread || chat.hasUnread || chat.isUnread);
}

function cleanMaxMessageText(text = "") {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s+\d{1,2}:\d{2}$/u, "")
    .trim();
}

function getActiveChatId(status, activeChat) {
  const urlPart = status.url?.match(/\/(\d+)(?:\D*$|$)/)?.[1];
  const namePart = activeChat.name || activeChat.title || "unknown";
  return urlPart ? `max_chat_${urlPart}` : `max_chat_${slugify(namePart)}`;
}

function makeMessageKey(chatId, text) {
  return crypto.createHash("sha256").update(`${chatId}:${text}`).digest("hex").slice(0, 32);
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "unknown";
}
