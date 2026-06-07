import express from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { createAdminRouter } from "./adminRoutes.js";
import { processIncomingMessage } from "./messageService.js";
import { getDueReminders, markReminderFailed, markReminderSent } from "./reminderService.js";
import { refreshClinicStaffFromDb } from "./nameRole.js";
import {
  verifyCredentials,
  createSessionToken,
  setSessionCookie,
  clearSessionCookie,
  getSession,
  requireAdminApi,
  requireAdminPage,
  requireApiKey
} from "./auth.js";

const app = express();
const serviceVersion = "agent-api-2026-05-07-logic-v2";
const adminPublicPath = fileURLToPath(new URL("../public", import.meta.url));

app.use(express.json({ limit: "2mb" }));

// --- Аутентификация админки (регистрируется до защищённых маршрутов) ---
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!verifyCredentials(username, password)) {
    res.status(401).json({ error: "Неверный логин или пароль" });
    return;
  }
  setSessionCookie(res, createSessionToken(String(username)));
  res.json({ ok: true, username: String(username) });
});

app.post("/api/admin/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/admin/session", (req, res) => {
  const session = getSession(req);
  res.json({ authenticated: Boolean(session), username: session?.u || null });
});

// Статика логина и ассеты доступны без сессии (это только разметка/стили, без данных).
app.get("/admin/login", (req, res) => {
  res.sendFile(path.join(adminPublicPath, "login.html"));
});
app.use("/admin/assets", express.static(adminPublicPath));

// Данные и панель — только с валидной сессией.
app.use("/api/admin", requireAdminApi, createAdminRouter());

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

app.get("/admin", requireAdminPage, (req, res) => {
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

app.post("/incoming-message", requireApiKey, async (req, res) => {
  try {
    const result = await processIncomingMessage(req.body);
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/reminders/due", requireApiKey, async (req, res) => {
  try {
    res.json({ reminders: await getDueReminders(Number(req.query.limit || 20)) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/reminders/:id/sent", requireApiKey, async (req, res) => {
  try {
    const reminder = await markReminderSent(req.params.id);
    res.json({ ok: true, reminder_id: reminder.id, status: reminder.status });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/reminders/:id/failed", requireApiKey, async (req, res) => {
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
  refreshClinicStaffFromDb()
    .then((staff) => console.log(`Doctor registry loaded from DB: ${staff.length} staff`))
    .catch((error) => console.warn("Doctor registry initial load failed:", error.message));
});

process.on("SIGINT", async () => {
  await prisma.$disconnect();
  process.exit(0);
});
