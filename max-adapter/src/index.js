import express from "express";
import crypto from "node:crypto";
import { MaxClient } from "./maxClient.js";
import { sendIncomingMessageToN8n } from "./n8nClient.js";
import { config } from "./config.js";
import { prisma } from "./db.js";

const app = express();
const maxClient = new MaxClient();
const processedMessageKeys = new Set();
const failedMessageKeys = new Map();
const failedMessageRetryAfterMs = 2 * 60 * 1000;
const SAFE_REPLY_FALLBACK = "Подскажите, пожалуйста, что вас интересует: услуга, цена или запись на прием?";
const internalReplyPatterns = [
  /проверяю\s+данные/iu,
  /зафиксировал[аи]?/iu,
  /сохраняю/iu,
  /передаю\s+в\s+систем/iu,
  /\bmemory\b/iu,
  /\bmemory_patch\b/iu,
  /\bmemory_update\b/iu,
  /\bintent\b/iu,
  /\baction\b/iu,
  /\bhandoff\b/iu,
  /\btool\b/iu,
  /\bjson\b/iu,
  /\bsystem\b/iu,
  /\bassistant\b/iu,
  /\breasoning\b/iu,
  /\bstatus\b/iu,
  /```/
];
const watcher = {
  scannerTimer: null,
  workerTimer: null,
  running: false,
  scanning: false,
  working: false,
  mode: "all",
  intervalMs: config.maxPollIntervalMs,
  workerIntervalMs: config.maxWorkerIntervalMs,
  startedAt: null,
  lastScanResult: null,
  lastWorkerResult: null,
  lastError: null,
  browserClosedLogged: false
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

function buildAgentApiHeaders(extraHeaders = {}) {
  return {
    ...extraHeaders,
    ...(config.agentApiKey ? { "x-api-key": config.agentApiKey } : {})
  };
}

function startWatcherTimers(mode = "all") {
  watcher.mode = mode === "active" ? "active" : "all";
  if (watcher.scannerTimer) return;

  watcher.running = true;
  watcher.startedAt = new Date();
  watcher.scannerTimer = setInterval(runScannerTick, watcher.intervalMs);
  watcher.workerTimer = setInterval(runQueueWorkerTick, watcher.workerIntervalMs);
}

function startReminderWatcherTimer() {
  if (reminderWatcher.timer) return;

  reminderWatcher.running = true;
  reminderWatcher.startedAt = new Date();
  reminderWatcher.timer = setInterval(runReminderWatcherTick, reminderWatcher.intervalMs);
}

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
      onlyUnread: Boolean(req.body.only_unread),
      processImmediately: true
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
    if (req.body.interval_ms) {
      watcher.intervalMs = Math.max(2000, Number(req.body.interval_ms));
    }

    if (req.body.worker_interval_ms) {
      watcher.workerIntervalMs = Math.max(500, Number(req.body.worker_interval_ms));
    }

    startWatcherTimers(req.body.mode);

    const firstScan = await runScannerTick({ force: Boolean(req.body.force) });
    const firstWorker = await runQueueWorkerTick();
    res.json({ ...getWatcherStatus(), first_scan: firstScan, first_worker: firstWorker });
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

app.get("/max/queue/status", async (req, res) => {
  try {
    res.json({ ok: true, queue: await getAllQueueStats() });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/max/queue/process", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(20, Number(req.body.limit || 1)));
    const results = [];

    for (let index = 0; index < limit; index += 1) {
      const result = await processQueuedMessage();
      results.push(result);
      if (result.idle) break;
    }

    res.json({ ok: results.every((result) => result.ok), results, queue: await getAllQueueStats() });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/max/outbound/process", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(20, Number(req.body.limit || 1)));
    const results = [];

    for (let index = 0; index < limit; index += 1) {
      const result = await processOutboundMessage();
      results.push(result);
      if (result.idle) break;
    }

    res.json({ ok: results.every((result) => result.ok), results, queue: await getAllQueueStats() });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
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

    startReminderWatcherTimer();

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

  if (config.autoStartWatcher) {
    startWatcherTimers("all");
    runScannerTick().catch((error) => {
      watcher.lastError = error.message;
      console.error("MAX watcher auto-start scan failed:", error);
    });
    runQueueWorkerTick().catch((error) => {
      watcher.lastError = error.message;
      console.error("MAX watcher auto-start worker failed:", error);
    });
  }

  if (config.autoStartReminderWatcher) {
    startReminderWatcherTimer();
    runReminderWatcherTick().catch((error) => {
      reminderWatcher.lastError = error.message;
      console.error("Reminder watcher auto-start failed:", error);
    });
  }
});

process.on("SIGINT", async () => {
  stopWatcher();
  stopReminderWatcher();
  await prisma.$disconnect().catch(() => {});
  await maxClient.stop();
  process.exit(0);
});

async function runScannerTick(options = {}) {
  if (watcher.scanning || watcher.working) {
    return { ok: true, skipped: true, reason: "MAX browser is busy" };
  }

  watcher.scanning = true;

  try {
    await maxClient.ensureAlive();
    const result = watcher.mode === "active"
      ? await enqueueActiveChatMessage({ limit: 20, force: Boolean(options.force), throwIfNoMessage: false })
      : await scanChatsToQueue({
          limit: 20,
          maxChats: config.maxScanChatsPerTick,
          force: Boolean(options.force),
          throwIfNoMessage: false
        });
    watcher.lastScanResult = { ...result, checked_at: new Date().toISOString() };
    watcher.lastError = null;
    watcher.browserClosedLogged = false;
    return watcher.lastScanResult;
  } catch (error) {
    watcher.lastError = error.message;
    if (isBrowserClosedError(error)) {
      // Browser/page died mid-scan. Flag for recovery and log once per outage
      // instead of dumping the same stack on every tick.
      maxClient.needsRestart = true;
      if (!watcher.browserClosedLogged) {
        console.error("MAX scanner hit a closed browser; auto-recovery will retry:", error.message);
        watcher.browserClosedLogged = true;
      }
    } else {
      console.error("MAX scanner failed:", error);
    }
    return { ok: false, error: error.message };
  } finally {
    watcher.scanning = false;
  }
}

function isBrowserClosedError(error) {
  const message = String(error?.message || "");
  return /has been closed|target closed|target page, context or browser|browser has been closed|page\.evaluate.*closed/iu.test(message);
}

async function runQueueWorkerTick() {
  if (watcher.working || watcher.scanning) {
    return { ok: true, skipped: true, reason: "MAX browser is busy" };
  }

  watcher.working = true;

  try {
    let result = await processQueuedMessage();
    if (result.idle) {
      result = await processOutboundMessage();
    }
    watcher.lastWorkerResult = { ...result, checked_at: new Date().toISOString() };
    watcher.lastError = null;
    return watcher.lastWorkerResult;
  } catch (error) {
    watcher.lastError = error.message;
    console.error("MAX queue worker failed:", error);
    return { ok: false, error: error.message };
  } finally {
    watcher.working = false;
  }
}

async function processAllChats({
  limit = 20,
  maxChats = 20,
  force = false,
  onlyUnread = false,
  throwIfNoMessage = true,
  processImmediately = false
} = {}) {
  if (!processImmediately) {
    return scanChatsToQueue({ limit, maxChats, force, onlyUnread, throwIfNoMessage });
  }

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

async function scanChatsToQueue({
  limit = 20,
  maxChats = config.maxScanChatsPerTick,
  force = false,
  onlyUnread = false,
  throwIfNoMessage = true
} = {}) {
  const chats = await maxClient.listChats();
  const candidates = await selectScanCandidates(chats, { maxChats, onlyUnread });
  const results = [];

  for (const chat of candidates) {
    try {
      await maxClient.openChat({ index: chat.index });
      const result = await enqueueActiveChatMessage({
        limit,
        force,
        throwIfNoMessage: false,
        source: "max-queue-scanner",
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

  const queued = results.filter((result) => result.queued).length;
  const duplicates = results.filter((result) => result.duplicate).length;
  const skipped = results.filter((result) => result.skipped).length;
  const failed = results.filter((result) => result.ok === false).length;

  if (!results.length && throwIfNoMessage) {
    throw new Error("No MAX chats found for scanning");
  }

  return {
    ok: failed === 0,
    mode: "queue-scan",
    chats_seen: chats.length,
    chats_checked: candidates.length,
    queued,
    duplicates,
    skipped,
    failed,
    queue: await getQueueStats(),
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
  const meaningfulMessages = chatMessages.messages
    .map((message) => ({
      ...message,
      text: cleanMaxMessageText(message.text)
    }))
    .filter((message) => message.text);
  const latestIncoming = meaningfulMessages.at(-1);

  if (!latestIncoming || latestIncoming.direction !== "incoming") {
    if (throwIfNoMessage) {
      throw new Error("Latest MAX chat message is not incoming");
    }

    return { ok: true, skipped: true, reason: "Latest MAX chat message is not incoming" };
  }

  const cleanText = latestIncoming.text;
  if (!cleanText) {
    if (throwIfNoMessage) {
      throw new Error("Latest incoming message is empty after cleanup");
    }

    return { ok: true, skipped: true, reason: "Latest incoming message is empty after cleanup" };
  }

  const chatId = getActiveChatId(await maxClient.status(), activeChat);
  const messageKey = makeMessageKey(chatId, cleanText, {
    chatName: activeChat.name || activeChat.title || sourceChat?.name || "",
    rawText: latestIncoming.raw_text || latestIncoming.text || "",
    previewTime: sourceChat?.time || ""
  });

  if (!force && processedMessageKeys.has(messageKey)) {
    return {
      ok: true,
      skipped: true,
      reason: "Message was already processed by this adapter session",
      chat_id: chatId,
      message_text: cleanText
    };
  }

  const failedAt = failedMessageKeys.get(messageKey);
  if (!force && failedAt && Date.now() - failedAt < failedMessageRetryAfterMs) {
    return {
      ok: true,
      skipped: true,
      reason: "Message failed recently; waiting before retry",
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

  let n8nResponse;
  try {
    n8nResponse = await sendIncomingMessageToN8n(payload);
    failedMessageKeys.delete(messageKey);
  } catch (error) {
    failedMessageKeys.set(messageKey, Date.now());
    throw error;
  }

  const reply = cleanReplyForMessenger(n8nResponse);
  if (reply) {
    await maxClient.sendMessage(chatId, reply);
  }

  processedMessageKeys.add(messageKey);

  return {
    ok: true,
    sent_to_n8n: payload,
    n8n_response: n8nResponse,
    max_reply_sent: Boolean(reply)
  };
}

async function enqueueActiveChatMessage({
  limit = 20,
  force = false,
  throwIfNoMessage = true,
  source = "max-active-chat",
  sourceChat = null
} = {}) {
  const activeChat = await maxClient.getActiveChatInfo();
  const chatMessages = await maxClient.readActiveChatMessages(limit);
  const meaningfulMessages = chatMessages.messages
    .map((message) => ({
      ...message,
      text: cleanMaxMessageText(message.text)
    }))
    .filter((message) => message.text);
  const latestIncoming = meaningfulMessages.at(-1);

  if (!latestIncoming || latestIncoming.direction !== "incoming") {
    if (throwIfNoMessage) {
      throw new Error("Latest MAX chat message is not incoming");
    }

    return { ok: true, skipped: true, reason: "Latest MAX chat message is not incoming" };
  }

  const cleanText = latestIncoming.text;
  if (!cleanText) {
    if (throwIfNoMessage) {
      throw new Error("Latest incoming message is empty after cleanup");
    }

    return { ok: true, skipped: true, reason: "Latest incoming message is empty after cleanup" };
  }

  const chatId = getActiveChatId(await maxClient.status(), activeChat);
  const messageKey = makeMessageKey(chatId, cleanText, {
    chatName: activeChat.name || activeChat.title || sourceChat?.name || "",
    rawText: latestIncoming.raw_text || latestIncoming.text || "",
    previewTime: sourceChat?.time || ""
  });
  const externalMessageId = messageKey;
  const rawPayload = {
    source,
    source_chat: sourceChat,
    active_chat: activeChat,
    latest_message: latestIncoming
  };

  const existing = await prisma.maxMessageQueue.findUnique({
    where: { messageKey }
  });

  if (existing && !force) {
    return {
      ok: true,
      duplicate: true,
      queue_id: existing.id,
      status: existing.status,
      chat_id: chatId,
      message_text: cleanText
    };
  }

  const row = existing
    ? await prisma.maxMessageQueue.update({
        where: { id: existing.id },
        data: {
          status: "queued",
          attempts: 0,
          lockedUntil: null,
          lastError: null,
          updatedAt: new Date()
        }
      })
    : await prisma.maxMessageQueue.create({
        data: {
          messageKey,
          chatId,
          chatName: activeChat.name || activeChat.title || sourceChat?.name || "MAX User",
          messageText: cleanText,
          externalMessageId,
          source,
          status: "queued",
          rawPayload
        }
      });

  await updateMaxChatState({
    chatId,
    chatName: activeChat.name || activeChat.title || sourceChat?.name || "MAX User",
    direction: "incoming",
    previewText: cleanText,
    previewTime: sourceChat?.time || null
  }).catch(() => {});

  return {
    ok: true,
    queued: true,
    queue_id: row.id,
    chat_id: chatId,
    message_text: cleanText
  };
}

async function processQueuedMessage() {
  const item = await lockNextQueueItem();
  if (!item) {
    return {
      ok: true,
      idle: true,
      queue: await getQueueStats()
    };
  }

  const payload = {
    channel: "max",
    max_user_id: item.chatId,
    display_name: item.chatName || "MAX User",
    message_text: item.messageText,
    external_message_id: item.externalMessageId || item.messageKey,
    raw_payload: item.rawPayload || {}
  };

  try {
    const n8nResponse = await sendIncomingMessageToN8n(payload);
    let reply = cleanReplyForMessenger(n8nResponse);
    let recoveredDuplicateReply = false;
    if (!reply && n8nResponse?.skipped && n8nResponse.reason === "duplicate_latest_incoming_text") {
      const latestOutgoing = n8nResponse.conversation_id
        ? await prisma.message.findFirst({
            where: {
              conversationId: Number(n8nResponse.conversation_id),
              direction: "outgoing"
            },
            orderBy: { createdAt: "desc" }
          })
        : null;
      reply = cleanReplyForMessenger({ reply: latestOutgoing?.text || "" });
      recoveredDuplicateReply = Boolean(reply);
    }

    if (!reply && n8nResponse?.skipped) {
      await prisma.maxMessageQueue.update({
        where: { id: item.id },
        data: {
          status: "skipped",
          n8nResponse,
          processedAt: new Date(),
          sentAt: null,
          lockedUntil: null,
          lastError: n8nResponse.reason || "skipped_without_reply",
          updatedAt: new Date()
        }
      });

      return {
        ok: true,
        skipped: true,
        queue_id: item.id,
        chat_id: item.chatId,
        reason: n8nResponse.reason || "skipped_without_reply",
        queue: await getQueueStats()
      };
    }

    if (reply) {
      await maxClient.openChatByChatId(item.chatId);
      await maxClient.sendMessage(item.chatId, reply);
      await updateMaxChatState({
        chatId: item.chatId,
        chatName: item.chatName || "MAX User",
        direction: "outgoing",
        previewText: reply
      }).catch(() => {});
    }

    await prisma.maxMessageQueue.update({
      where: { id: item.id },
      data: {
        status: "sent",
        n8nResponse: recoveredDuplicateReply
          ? { ...n8nResponse, recovered_duplicate_reply: true, recovered_reply: reply }
          : n8nResponse,
        processedAt: new Date(),
        sentAt: reply ? new Date() : null,
        lockedUntil: null,
        lastError: null,
        updatedAt: new Date()
      }
    });

    return {
      ok: true,
      queue_id: item.id,
      chat_id: item.chatId,
      reply_sent: Boolean(reply),
      queue: await getQueueStats()
    };
  } catch (error) {
    const failedPermanently = item.attempts >= config.maxQueueMaxAttempts;
    await prisma.maxMessageQueue.update({
      where: { id: item.id },
      data: {
        status: failedPermanently ? "failed" : "queued",
        lockedUntil: null,
        lastError: error.message,
        updatedAt: new Date()
      }
    });

    return {
      ok: false,
      queue_id: item.id,
      chat_id: item.chatId,
      retry: !failedPermanently,
      error: error.message,
      queue: await getQueueStats()
    };
  }
}

async function processOutboundMessage() {
  const item = await lockNextOutboundItem();
  if (!item) {
    return {
      ok: true,
      idle: true,
      kind: "outbound",
      queue: await getAllQueueStats()
    };
  }

  try {
    await maxClient.openChatByChatId(item.chatId);
    await maxClient.sendMessage(item.chatId, item.messageText);

    await prisma.outboundMessageQueue.update({
      where: { id: item.id },
      data: {
        status: "sent",
        sentAt: new Date(),
        lockedUntil: null,
        lastError: null,
        updatedAt: new Date()
      }
    });

    await updateMaxChatState({
      chatId: item.chatId,
      chatName: item.chatName || item.recipientName || "MAX User",
      direction: "outgoing",
      previewText: item.messageText
    }).catch(() => {});

    await updateCampaignStatus(item.campaignId).catch(() => {});

    return {
      ok: true,
      kind: "outbound",
      outbound_id: item.id,
      chat_id: item.chatId,
      sent: true,
      queue: await getAllQueueStats()
    };
  } catch (error) {
    const failedPermanently = item.attempts >= config.maxOutboundMaxAttempts;
    await prisma.outboundMessageQueue.update({
      where: { id: item.id },
      data: {
        status: failedPermanently ? "failed" : "queued",
        lockedUntil: null,
        lastError: error.message,
        updatedAt: new Date()
      }
    });

    await updateCampaignStatus(item.campaignId).catch(() => {});

    return {
      ok: false,
      kind: "outbound",
      outbound_id: item.id,
      chat_id: item.chatId,
      retry: !failedPermanently,
      error: error.message,
      queue: await getAllQueueStats()
    };
  }
}

async function lockNextOutboundItem() {
  const now = new Date();
  const lockUntil = new Date(now.getTime() + config.maxOutboundLockMs);
  const item = await prisma.outboundMessageQueue.findFirst({
    where: {
      status: "queued",
      scheduledAt: { lte: now },
      attempts: { lt: config.maxOutboundMaxAttempts },
      OR: [
        { lockedUntil: null },
        { lockedUntil: { lt: now } }
      ]
    },
    orderBy: [
      { priority: "asc" },
      { scheduledAt: "asc" },
      { id: "asc" }
    ]
  });

  if (!item) return null;

  return prisma.outboundMessageQueue.update({
    where: { id: item.id },
    data: {
      status: "processing",
      attempts: { increment: 1 },
      lockedUntil: lockUntil,
      updatedAt: now
    }
  });
}

async function updateCampaignStatus(campaignId) {
  if (!campaignId) return;

  const grouped = await prisma.outboundMessageQueue.groupBy({
    by: ["status"],
    where: { campaignId },
    _count: { _all: true }
  });
  const stats = Object.fromEntries(grouped.map((row) => [row.status, row._count._all]));

  if (stats.queued || stats.processing) return;

  await prisma.broadcastCampaign.update({
    where: { id: campaignId },
    data: {
      status: stats.failed ? "completed_with_errors" : "completed",
      completedAt: new Date()
    }
  });
}

async function lockNextQueueItem() {
  const now = new Date();
  const lockUntil = new Date(now.getTime() + config.maxQueueLockMs);
  const item = await prisma.maxMessageQueue.findFirst({
    where: {
      status: "queued",
      attempts: { lt: config.maxQueueMaxAttempts },
      OR: [
        { lockedUntil: null },
        { lockedUntil: { lt: now } }
      ]
    },
    orderBy: { queuedAt: "asc" }
  });

  if (!item) return null;

  return prisma.maxMessageQueue.update({
    where: { id: item.id },
    data: {
      status: "processing",
      attempts: { increment: 1 },
      lockedUntil: lockUntil,
      updatedAt: now
    }
  });
}

async function getQueueStats() {
  const grouped = await prisma.maxMessageQueue.groupBy({
    by: ["status"],
    _count: { _all: true }
  });

  return Object.fromEntries(grouped.map((row) => [row.status, row._count._all]));
}

async function getOutboundQueueStats() {
  const grouped = await prisma.outboundMessageQueue.groupBy({
    by: ["status"],
    _count: { _all: true }
  });

  return Object.fromEntries(grouped.map((row) => [row.status, row._count._all]));
}

async function getAllQueueStats() {
  const [incoming, outbound] = await Promise.all([
    getQueueStats(),
    getOutboundQueueStats()
  ]);

  return { incoming, outbound };
}

function stopWatcher() {
  if (watcher.scannerTimer) {
    clearInterval(watcher.scannerTimer);
  }

  if (watcher.workerTimer) {
    clearInterval(watcher.workerTimer);
  }

  watcher.scannerTimer = null;
  watcher.workerTimer = null;
  watcher.running = false;
  watcher.scanning = false;
  watcher.working = false;
}

function getWatcherStatus() {
  return {
    running: watcher.running,
    scanning: watcher.scanning,
    working: watcher.working,
    mode: watcher.mode,
    interval_ms: watcher.intervalMs,
    worker_interval_ms: watcher.workerIntervalMs,
    started_at: watcher.startedAt?.toISOString() || null,
    last_scan_result: watcher.lastScanResult,
    last_worker_result: watcher.lastWorkerResult,
    last_error: watcher.lastError
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
  const dueResponse = await fetch(`${config.agentApiUrl}/reminders/due?limit=${limit}`, {
    headers: buildAgentApiHeaders()
  });
  if (!dueResponse.ok) {
    throw new Error(`Agent API reminders/due failed: ${dueResponse.status} ${await dueResponse.text()}`);
  }

  const due = await dueResponse.json();
  const results = [];

  for (const reminder of due.reminders || []) {
    try {
      await maxClient.openChatByChatId(reminder.max_user_id);
      await maxClient.sendMessage(reminder.max_user_id, reminder.text);
      await updateMaxChatState({
        chatId: reminder.max_user_id,
        chatName: reminder.display_name || "MAX User",
        direction: "outgoing",
        previewText: reminder.text
      }).catch(() => {});
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
    headers: buildAgentApiHeaders({ "content-type": "application/json" }),
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

async function selectScanCandidates(chats, { maxChats = config.maxScanChatsPerTick, onlyUnread = false } = {}) {
  const scannable = chats.filter((chat) => shouldScanChat(chat, { onlyUnread: false }));
  const filtered = await filterCooldownChats(scannable);
  const unread = filtered.filter((chat) => shouldScanChat(chat, { onlyUnread: true }));
  const recent = filtered.slice(0, Math.max(0, maxChats - unread.length));
  const byIndex = new Map();

  for (const chat of [...unread.slice(0, config.maxUnreadScanLimit), ...recent]) {
    byIndex.set(chat.index, chat);
  }

  return [...byIndex.values()].slice(0, Math.max(maxChats, unread.length));
}

async function filterCooldownChats(chats) {
  const names = [...new Set(chats.map((chat) => (chat.name || "").trim()).filter(Boolean))];
  if (!names.length) return chats;

  const now = new Date();
  const states = await prisma.maxChatState.findMany({
    where: {
      chatName: { in: names },
      cooldownUntil: { gt: now },
      lastDirection: "outgoing"
    }
  });
  const byName = new Map(states.map((state) => [state.chatName, state]));

  return chats.filter((chat) => {
    if (shouldScanChat(chat, { onlyUnread: true })) return true;

    const state = byName.get((chat.name || "").trim());
    if (!state) return true;

    const preview = normalizeComparable(chat.text);
    const lastOutgoing = normalizeComparable(state.lastPreviewText);
    if (!lastOutgoing) return true;

    return !preview.includes(lastOutgoing.slice(0, Math.min(60, lastOutgoing.length)));
  });
}

async function updateMaxChatState({ chatId, chatName, direction, previewText = "", previewTime = null }) {
  const now = new Date();
  const data = {
    chatName: chatName || null,
    lastPreviewText: previewText || null,
    lastPreviewTime: previewTime || null,
    lastDirection: direction || null,
    updatedAt: now
  };

  if (direction === "incoming") {
    data.lastInboundAt = now;
    data.cooldownUntil = null;
  }

  if (direction === "outgoing") {
    data.lastOutboundAt = now;
    data.cooldownUntil = new Date(now.getTime() + config.maxOutboundCooldownMs);
  }

  return prisma.maxChatState.upsert({
    where: { chatId },
    update: data,
    create: {
      chatId,
      ...data
    }
  });
}

function cleanMaxMessageText(text = "") {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s+\d{1,2}:\d{2}$/u, "")
    .trim();
}

function normalizeComparable(value = "") {
  return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function cleanReplyForMessenger(response) {
  if (!response || typeof response.reply !== "string") return "";

  const reply = response.reply
    .replace(/```(?:json)?/giu, "")
    .replace(/```/gu, "")
    .replace(/^\s*(?:reply|ответ)\s*[:=-]\s*/iu, "")
    .replace(/\s+/gu, " ")
    .trim();

  if (!reply) return "";
  if (looksLikeInternalReply(reply)) return SAFE_REPLY_FALLBACK;
  return reply;
}

function looksLikeInternalReply(text = "") {
  const trimmed = String(text || "").trim();
  if (!trimmed) return true;
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return true;
  }
  if (/"reply"\s*:|"intent"\s*:|"action"\s*:|"memory_patch"\s*:/iu.test(trimmed)) {
    return true;
  }
  return internalReplyPatterns.some((pattern) => pattern.test(trimmed));
}

function getActiveChatId(status, activeChat) {
  const urlPart = status.url?.match(/\/(\d+)(?:\D*$|$)/)?.[1];
  const namePart = activeChat.name || activeChat.title || "unknown";
  return urlPart ? `max_chat_${urlPart}` : `max_chat_${slugify(namePart)}`;
}

function makeMessageKey(chatId, text, meta = {}) {
  const fingerprint = [
    chatId,
    meta.chatName || "",
    text,
    meta.rawText || "",
    meta.previewTime || ""
  ].join(":");

  return crypto.createHash("sha256").update(fingerprint).digest("hex").slice(0, 32);
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "unknown";
}
