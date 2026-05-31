import express from "express";
import { readFile, writeFile } from "node:fs/promises";
import { prisma } from "./db.js";
import { processIncomingMessage } from "./messageService.js";
import {
  getAnnualHygieneRecipients,
  getBroadcastRecipients,
  getOutboundQueue,
  queueAnnualHygieneBroadcast,
  queueBroadcast,
  queueManualBroadcast
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

function toPage(value) {
  const number = Number(value || 1);
  if (!Number.isFinite(number)) return 1;
  return Math.max(Math.trunc(number), 1);
}

function toPageSize(value, fallback = 50, max = 200) {
  const number = Number(value || fallback);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), 1), max);
}

function pagination(page, pageSize, total) {
  return {
    page,
    page_size: pageSize,
    total,
    total_pages: Math.max(Math.ceil(total / pageSize), 1),
    has_prev: page > 1,
    has_next: page * pageSize < total
  };
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
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
    const status = normalizeStatus(req.query.status);
    const page = toPage(req.query.page);
    const pageSize = toPageSize(req.query.page_size || req.query.limit, 30, 100);
    const where = {
      ...(status ? { status } : {}),
      ...(search
        ? {
            OR: [
              { contact: { displayName: { contains: search, mode: "insensitive" } } },
              { contact: { maxUserId: { contains: search, mode: "insensitive" } } },
              { messages: { some: { text: { contains: search, mode: "insensitive" } } } }
            ]
          }
        : {})
    };

    const [total, conversations] = await Promise.all([
      prisma.conversation.count({ where }),
      prisma.conversation.findMany({
        where,
        orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
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
      })
    ]);

    res.json({ conversations, pagination: pagination(page, pageSize, total) });
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
    const search = String(req.query.search || "").trim();
    const dateFrom = parseDate(req.query.date_from);
    const dateTo = parseDate(req.query.date_to);
    const page = toPage(req.query.page);
    const pageSize = toPageSize(req.query.page_size || req.query.limit, 30, 100);
    const where = {
      ...(status ? { status } : {}),
      ...(dateFrom || dateTo
        ? {
            preferredDate: {
              ...(dateFrom ? { gte: dateFrom } : {}),
              ...(dateTo ? { lte: dateTo } : {})
            }
          }
        : {}),
      ...(search
        ? {
            OR: [
              { patientName: { contains: search, mode: "insensitive" } },
              { phone: { contains: search, mode: "insensitive" } },
              { complaint: { contains: search, mode: "insensitive" } },
              { requestedService: { contains: search, mode: "insensitive" } },
              { contact: { displayName: { contains: search, mode: "insensitive" } } },
              { contact: { maxUserId: { contains: search, mode: "insensitive" } } }
            ]
          }
        : {})
    };

    const [total, appointments] = await Promise.all([
      prisma.appointmentRequest.count({ where }),
      prisma.appointmentRequest.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          contact: true,
          conversation: true,
          slot: true,
          reminders: {
            orderBy: { remindAt: "asc" }
          }
        }
      })
    ]);

    res.json({ appointments, pagination: pagination(page, pageSize, total) });
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
    const page = toPage(req.query.page);
    const pageSize = toPageSize(req.query.page_size || req.query.limit, 30, 100);
    const where = status ? { status } : {};
    const [total, reminders] = await Promise.all([
      prisma.appointmentReminder.count({ where }),
      prisma.appointmentReminder.findMany({
        where,
        orderBy: [{ remindAt: "asc" }, { id: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          contact: true,
          appointmentRequest: true
        }
      })
    ]);

    res.json({ reminders, pagination: pagination(page, pageSize, total) });
  });

  router.get("/broadcast/recipients", async (req, res) => {
    const page = toPage(req.query.page);
    const pageSize = toPageSize(req.query.page_size || req.query.limit, 25, 100);
    const fetchLimit = 1000;
    const recipients = req.query.annual_hygiene === "true"
      ? await getAnnualHygieneRecipients({ limit: fetchLimit })
      : await getBroadcastRecipients({
          serviceQuery: req.query.service_query,
          visitedBeforeDays: req.query.visited_before_days,
          visitedAfterDays: req.query.visited_after_days,
          onlyWithVisits: req.query.only_with_visits === "true",
          limit: fetchLimit
        });
    const total = recipients.length;
    const pageItems = recipients.slice((page - 1) * pageSize, page * pageSize);

    res.json({ recipients: pageItems, count: total, pagination: pagination(page, pageSize, total) });
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

  router.post("/broadcast/manual", async (req, res) => {
    try {
      const result = await queueManualBroadcast({
        contactIds: req.body?.contact_ids || req.body?.contactIds || [],
        message: req.body?.message,
        dryRun: req.body?.dry_run !== false,
        sendWindow: req.body?.send_window || {},
        allowHumanTakeover: Boolean(req.body?.allow_human_takeover)
      });

      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  router.get("/broadcast/outbound-queue", async (req, res) => {
    res.json(await getOutboundQueue({
      status: req.query.status,
      type: req.query.type,
      search: req.query.search,
      page: req.query.page,
      pageSize: req.query.page_size || req.query.limit
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
    await prisma.conversation.update({
      where: { id: handoff.conversationId },
      data: {
        status: "active",
        updatedAt: new Date()
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

    const page = toPage(req.query.page);
    const pageSize = toPageSize(req.query.page_size || req.query.limit, 50, 200);
    const [total, rows] = await Promise.all([
      model.count(),
      model.findMany({
        orderBy: { id: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize
      })
    ]);

    res.json({ table, rows, pagination: pagination(page, pageSize, total) });
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
