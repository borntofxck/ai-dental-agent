import express from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { createAdminRouter } from "./adminRoutes.js";
import { processIncomingMessage } from "./messageService.js";
import { getDueReminders, markReminderFailed, markReminderSent } from "./reminderService.js";

const app = express();
const serviceVersion = "agent-api-2026-05-07-logic-v2";
const adminPublicPath = fileURLToPath(new URL("../public", import.meta.url));

app.use(express.json({ limit: "2mb" }));
app.use("/api/admin", createAdminRouter());
app.use("/admin/assets", express.static(adminPublicPath));

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "agent-api",
    version: serviceVersion,
    endpoints: {
      health: "GET /health",
      incomingMessage: "POST /incoming-message",
      dueReminders: "GET /reminders/due",
      admin: "GET /admin",
      adminApi: "GET /api/admin/stats"
    }
  });
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(adminPublicPath, "index.html"));
});

app.get("/health", async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, service: "agent-api", version: serviceVersion, database: "connected" });
  } catch (error) {
    res.status(500).json({ ok: false, service: "agent-api", error: error.message });
  }
});

app.post("/incoming-message", async (req, res) => {
  try {
    const result = await processIncomingMessage(req.body);
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/reminders/due", async (req, res) => {
  try {
    res.json({ reminders: await getDueReminders(Number(req.query.limit || 20)) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/reminders/:id/sent", async (req, res) => {
  try {
    const reminder = await markReminderSent(req.params.id);
    res.json({ ok: true, reminder_id: reminder.id, status: reminder.status });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/reminders/:id/failed", async (req, res) => {
  try {
    const reminder = await markReminderFailed(req.params.id, req.body?.error);
    res.json({ ok: true, reminder_id: reminder.id, status: reminder.status });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(config.port, () => {
  console.log(`Agent API listening on http://localhost:${config.port}`);
});

process.on("SIGINT", async () => {
  await prisma.$disconnect();
  process.exit(0);
});
