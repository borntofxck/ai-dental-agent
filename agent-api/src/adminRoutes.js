import express from "express";
import { readFile, writeFile } from "node:fs/promises";
import { prisma } from "./db.js";
import { processIncomingMessage } from "./messageService.js";
import {
  getAnnualHygieneRecipients,
  getBroadcastRecipients,
  getOutboundQueue,
  queueAnnualHygieneBroadcast,
  queueBroadcast
} from "./broadcastService.js";

const systemPromptPath = new URL("../../prompts/dental_admin_system_prompt.md", import.meta.url);
const clinicKnowledgePath = new URL("../../prompts/clinic_knowledge.md", import.meta.url);

const tableModels = {
  contacts: prisma.contact,
  conversations: prisma.conversation,
  messages: prisma.message,
  conversation_memory: prisma.conversationMemory,
  appointment_requests: prisma.appointmentRequest,
  appointment_slots: prisma.appointmentSlot,
  appointment_reminders: prisma.appointmentReminder,
  agent_actions: prisma.agentAction,
  handoffs: prisma.handoff,
  clinic_settings: prisma.clinicSetting,
  doctors: prisma.doctor,
  doctor_schedules: prisma.doctorSchedule,
  service_categories: prisma.serviceCategory,
  clinic_services: prisma.clinicService,
  follow_up_rules: prisma.followUpRule,
  completed_visits: prisma.completedVisit,
  broadcast_campaigns: prisma.broadcastCampaign,
  outbound_message_queue: prisma.outboundMessageQueue,
  max_chat_state: prisma.maxChatState,
  max_message_queue: prisma.maxMessageQueue
};

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function startOfTomorrow() {
  const date = startOfToday();
  date.setDate(date.getDate() + 1);
  return date;
}

function toLimit(value, fallback = 50) {
  const number = Number(value || fallback);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), 1), 200);
}

function normalizeStatus(value) {
  return String(value || "").trim().slice(0, 50);
}

function formatDate(date = new Date()) {
  return new Intl.DateTimeFormat("ru-RU", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function buildTodayReport(stats) {
  return [
    `Отчет DentalCare за ${formatDate()}`,
    `Новых контактов: ${stats.contactsToday}`,
    `Сообщений за день: ${stats.messagesToday}`,
    `Заявок на прием за день: ${stats.appointmentsToday}`,
    `Подтвержденных записей за день: ${stats.confirmedAppointmentsToday}`,
    `Открытых передач администратору: ${stats.openHandoffs}`,
    `Ожидающих напоминаний: ${stats.pendingReminders}`
  ].join("\n");
}

export function createAdminRouter() {
  const router = express.Router();

  router.get("/stats", async (req, res) => {
    const today = startOfToday();
    const tomorrow = startOfTomorrow();

    const [
      contacts,
      contactsToday,
      activeConversations,
      messages,
      messagesToday,
      appointments,
      appointmentsToday,
      confirmedAppointmentsToday,
      openHandoffs,
      pendingReminders,
      latestMessages
    ] = await Promise.all([
      prisma.contact.count(),
      prisma.contact.count({ where: { createdAt: { gte: today } } }),
      prisma.conversation.count({ where: { status: "active" } }),
      prisma.message.count(),
      prisma.message.count({ where: { createdAt: { gte: today } } }),
      prisma.appointmentRequest.count(),
      prisma.appointmentRequest.count({ where: { createdAt: { gte: today, lt: tomorrow } } }),
      prisma.appointmentRequest.count({
        where: {
          createdAt: { gte: today, lt: tomorrow },
          status: "confirmed"
        }
      }),
      prisma.handoff.count({ where: { status: "open" } }),
      prisma.appointmentReminder.count({ where: { status: "pending" } }),
      prisma.message.findMany({
        orderBy: { createdAt: "desc" },
        take: 8,
        include: {
          contact: true,
          conversation: true
        }
      })
    ]);

    const stats = {
      contacts,
      contactsToday,
      activeConversations,
      messages,
      messagesToday,
      appointments,
      appointmentsToday,
      confirmedAppointmentsToday,
      openHandoffs,
      pendingReminders
    };

    res.json({
      stats,
      report: buildTodayReport(stats),
      latestMessages
    });
  });

  router.get("/conversations", async (req, res) => {
    const search = String(req.query.search || "").trim();
    const limit = toLimit(req.query.limit, 60);
    const where = search
      ? {
          OR: [
            { contact: { displayName: { contains: search, mode: "insensitive" } } },
            { contact: { maxUserId: { contains: search, mode: "insensitive" } } },
            { messages: { some: { text: { contains: search, mode: "insensitive" } } } }
          ]
        }
      : {};

    const conversations = await prisma.conversation.findMany({
      where,
      orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
      take: limit,
      include: {
        contact: true,
        memory: true,
        messages: {
          orderBy: { createdAt: "desc" },
          take: 1
        },
        _count: {
          select: {
            messages: true,
            appointments: true,
            handoffs: true
          }
        }
      }
    });

    res.json({ conversations });
  });

  router.get("/conversations/:id", async (req, res) => {
    const id = Number(req.params.id);
    const conversation = await prisma.conversation.findUnique({
      where: { id },
      include: {
        contact: true,
        memory: true,
        messages: {
          orderBy: { createdAt: "asc" }
        },
        appointments: {
          orderBy: { createdAt: "desc" },
          include: {
            slot: true,
            reminders: {
              orderBy: { remindAt: "asc" }
            }
          }
        },
        handoffs: {
          orderBy: { createdAt: "desc" }
        },
        actions: {
          orderBy: { createdAt: "desc" },
          take: 30
        }
      }
    });

    if (!conversation) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    res.json({ conversation });
  });

  router.get("/appointments", async (req, res) => {
    const status = normalizeStatus(req.query.status);
    const appointments = await prisma.appointmentRequest.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: "desc" },
      take: toLimit(req.query.limit, 100),
      include: {
        contact: true,
        conversation: true,
        slot: true,
        reminders: {
          orderBy: { remindAt: "asc" }
        }
      }
    });

    res.json({ appointments });
  });

  router.patch("/appointments/:id/status", async (req, res) => {
    const status = normalizeStatus(req.body?.status);
    if (!status) {
      res.status(400).json({ error: "status is required" });
      return;
    }

    const appointment = await prisma.appointmentRequest.update({
      where: { id: Number(req.params.id) },
      data: {
        status,
        updatedAt: new Date()
      }
    });

    res.json({ ok: true, appointment });
  });

  router.get("/reminders", async (req, res) => {
    const status = normalizeStatus(req.query.status);
    const reminders = await prisma.appointmentReminder.findMany({
      where: status ? { status } : {},
      orderBy: { remindAt: "asc" },
      take: toLimit(req.query.limit, 100),
      include: {
        contact: true,
        appointmentRequest: true
      }
    });

    res.json({ reminders });
  });

  router.get("/broadcast/recipients", async (req, res) => {
    const recipients = req.query.annual_hygiene === "true"
      ? await getAnnualHygieneRecipients({ limit: req.query.limit })
      : await getBroadcastRecipients({
          serviceQuery: req.query.service_query,
          visitedBeforeDays: req.query.visited_before_days,
          visitedAfterDays: req.query.visited_after_days,
          onlyWithVisits: req.query.only_with_visits === "true",
          limit: req.query.limit
        });

    res.json({ recipients, count: recipients.length });
  });

  router.post("/broadcast", async (req, res) => {
    const result = req.body?.annual_hygiene
      ? await queueAnnualHygieneBroadcast({
          prompt: req.body?.prompt,
          limit: req.body?.limit,
          useAi: Boolean(req.body?.use_ai)
        })
      : await queueBroadcast({
          name: req.body?.name,
          prompt: req.body?.prompt,
          filters: req.body?.filters || {},
          type: req.body?.type || "broadcast",
          useAi: Boolean(req.body?.use_ai)
        });

    res.json({ ok: true, ...result });
  });

  router.get("/broadcast/outbound-queue", async (req, res) => {
    res.json(await getOutboundQueue({
      status: req.query.status,
      limit: req.query.limit
    }));
  });

  router.patch("/handoffs/:id/resolve", async (req, res) => {
    const handoff = await prisma.handoff.update({
      where: { id: Number(req.params.id) },
      data: {
        status: "resolved",
        resolvedAt: new Date()
      }
    });

    res.json({ ok: true, handoff });
  });

  router.get("/prompts", async (req, res) => {
    const [systemPrompt, clinicKnowledge] = await Promise.all([
      readFile(systemPromptPath, "utf8"),
      readFile(clinicKnowledgePath, "utf8")
    ]);

    res.json({
      systemPrompt,
      clinicKnowledge,
      files: {
        systemPrompt: systemPromptPath.pathname,
        clinicKnowledge: clinicKnowledgePath.pathname
      }
    });
  });

  router.put("/prompts", async (req, res) => {
    const { systemPrompt, clinicKnowledge } = req.body || {};

    if (typeof systemPrompt !== "string" || typeof clinicKnowledge !== "string") {
      res.status(400).json({ error: "systemPrompt and clinicKnowledge are required" });
      return;
    }

    await Promise.all([
      writeFile(systemPromptPath, systemPrompt, "utf8"),
      writeFile(clinicKnowledgePath, clinicKnowledge, "utf8")
    ]);

    res.json({ ok: true, updatedAt: new Date().toISOString() });
  });

  router.get("/db/tables", async (req, res) => {
    res.json({
      tables: Object.keys(tableModels)
    });
  });

  router.get("/db/:table", async (req, res) => {
    const table = req.params.table;
    const model = tableModels[table];
    if (!model) {
      res.status(404).json({ error: "Unknown table" });
      return;
    }

    const rows = await model.findMany({
      orderBy: { id: "desc" },
      take: toLimit(req.query.limit, 100)
    });

    res.json({ table, rows });
  });

  router.get("/report/today", async (req, res) => {
    const today = startOfToday();
    const tomorrow = startOfTomorrow();
    const [
      contactsToday,
      messagesToday,
      appointmentsToday,
      confirmedAppointmentsToday,
      openHandoffs,
      pendingReminders
    ] = await Promise.all([
      prisma.contact.count({ where: { createdAt: { gte: today } } }),
      prisma.message.count({ where: { createdAt: { gte: today, lt: tomorrow } } }),
      prisma.appointmentRequest.count({ where: { createdAt: { gte: today, lt: tomorrow } } }),
      prisma.appointmentRequest.count({
        where: {
          createdAt: { gte: today, lt: tomorrow },
          status: "confirmed"
        }
      }),
      prisma.handoff.count({ where: { status: "open" } }),
      prisma.appointmentReminder.count({ where: { status: "pending" } })
    ]);

    const stats = {
      contactsToday,
      messagesToday,
      appointmentsToday,
      confirmedAppointmentsToday,
      openHandoffs,
      pendingReminders
    };

    res.json({
      stats,
      report: buildTodayReport(stats)
    });
  });

  router.post("/test-message", async (req, res) => {
    const messageText = String(req.body?.message_text || "").trim();
    if (!messageText) {
      res.status(400).json({ error: "message_text is required" });
      return;
    }

    const result = await processIncomingMessage({
      channel: "ADMIN_TEST",
      max_user_id: req.body?.max_user_id || "admin_test_user",
      display_name: req.body?.display_name || "Тестовый пациент",
      message_text: messageText
    });

    res.json(result);
  });

  return router;
}
