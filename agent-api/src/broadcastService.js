import crypto from "node:crypto";
import Groq from "groq-sdk";
import { config } from "./config.js";
import { prisma } from "./db.js";

const hygienePattern = /(гигиен|проф.*чист|профессиональн.*чист|air\s*flow|аир\s*флоу|ультразвук|налет|зубн.*кам)/iu;
const defaultAnnualHygienePrompt = [
  "Напиши короткое персональное сообщение пациенту стоматологии.",
  "Цель: напомнить, что профессиональную гигиену полости рта обычно рекомендуют проходить примерно раз в год.",
  "Тон спокойный, человеческий, без давления. Предложи записаться на удобное время."
].join(" ");

function toLimit(value, fallback = 100) {
  const number = Number(value || fallback);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), 1), 1000);
}

function normalizeText(value = "") {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function shortName(value = "") {
  return normalizeText(value).split(/\s+/u)[0] || "";
}

function toIsoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function currentYear() {
  return new Date().getFullYear();
}

function normalizeFilters(filters = {}) {
  return {
    serviceQuery: normalizeText(filters.serviceQuery || filters.service_query),
    visitedBeforeDays: Number(filters.visitedBeforeDays || filters.visited_before_days || 0) || null,
    visitedAfterDays: Number(filters.visitedAfterDays || filters.visited_after_days || 0) || null,
    onlyWithVisits: Boolean(filters.onlyWithVisits || filters.only_with_visits),
    limit: toLimit(filters.limit, 200)
  };
}

export async function getBroadcastRecipients(rawFilters = {}) {
  const filters = normalizeFilters(rawFilters);
  const contacts = await prisma.contact.findMany({
    where: {
      maxUserId: { not: "" }
    },
    orderBy: { updatedAt: "desc" },
    take: Math.max(filters.limit * 3, filters.limit),
    include: {
      completedVisits: {
        orderBy: { visitDate: "desc" },
        take: 20,
        include: {
          service: true,
          doctor: true
        }
      },
      conversations: {
        orderBy: { lastMessageAt: "desc" },
        take: 1,
        include: {
          memory: true
        }
      }
    }
  });

  const now = new Date();
  const recipients = [];

  for (const contact of contacts) {
    const visits = contact.completedVisits || [];
    if (filters.onlyWithVisits && visits.length === 0) continue;

    const matchingVisits = filters.serviceQuery
      ? visits.filter((visit) => serviceMatches(visit, filters.serviceQuery))
      : visits;
    const lastVisit = matchingVisits[0] || visits[0] || null;
    if (filters.serviceQuery && !lastVisit) continue;

    if (filters.visitedBeforeDays && lastVisit) {
      const cutoff = addDays(now, -filters.visitedBeforeDays);
      if (new Date(lastVisit.visitDate) > cutoff) continue;
    }

    if (filters.visitedAfterDays && lastVisit) {
      const cutoff = addDays(now, -filters.visitedAfterDays);
      if (new Date(lastVisit.visitDate) < cutoff) continue;
    }

    const memory = contact.conversations?.[0]?.memory?.memory || {};
    recipients.push(buildRecipient(contact, lastVisit, memory));
    if (recipients.length >= filters.limit) break;
  }

  return recipients;
}

export async function getAnnualHygieneRecipients({ limit = 200 } = {}) {
  const cutoff = addDays(new Date(), -365);
  const visits = await prisma.completedVisit.findMany({
    where: {
      visitDate: { lte: cutoff }
    },
    orderBy: { visitDate: "desc" },
    take: Math.max(toLimit(limit, 200) * 5, 200),
    include: {
      contact: {
        include: {
          conversations: {
            orderBy: { lastMessageAt: "desc" },
            take: 1,
            include: { memory: true }
          }
        }
      },
      service: true,
      doctor: true
    }
  });

  const phones = [...new Set(visits.map((visit) => normalizeText(visit.phone)).filter(Boolean))];
  const contactsByPhone = phones.length
    ? new Map((await prisma.contact.findMany({
        where: { phone: { in: phones } },
        include: {
          conversations: {
            orderBy: { lastMessageAt: "desc" },
            take: 1,
            include: { memory: true }
          }
        }
      })).map((contact) => [normalizeText(contact.phone), contact]))
    : new Map();

  const latestByContact = new Map();
  for (const visit of visits) {
    const contact = visit.contact || contactsByPhone.get(normalizeText(visit.phone));
    if (!contact?.maxUserId || !isHygieneVisit(visit)) continue;
    const existing = latestByContact.get(contact.id);
    if (!existing || new Date(visit.visitDate) > new Date(existing.visitDate)) {
      latestByContact.set(contact.id, { ...visit, contact, contactId: contact.id });
    }
  }

  const recipients = [];
  for (const visit of latestByContact.values()) {
    const hasFreshHygiene = await prisma.completedVisit.findFirst({
      where: {
        AND: [
          {
            OR: [
              { contactId: visit.contactId },
              visit.phone ? { phone: visit.phone } : undefined
            ].filter(Boolean)
          },
          { visitDate: { gt: cutoff } },
          {
            OR: [
              { serviceName: { contains: "гигиен", mode: "insensitive" } },
              { serviceName: { contains: "чист", mode: "insensitive" } },
              { service: { name: { contains: "гигиен", mode: "insensitive" } } },
              { service: { name: { contains: "чист", mode: "insensitive" } } }
            ]
          }
        ]
      },
      select: { id: true }
    });

    if (hasFreshHygiene) continue;

    const memory = visit.contact.conversations?.[0]?.memory?.memory || {};
    recipients.push(buildRecipient(visit.contact, visit, memory));
    if (recipients.length >= toLimit(limit, 200)) break;
  }

  return recipients;
}

export async function getContactAudience(rawFilters = {}) {
  const filters = {
    activeWithinDays: Number(rawFilters.activeWithinDays || rawFilters.active_within_days || 0) || null,
    inactiveForDays: Number(rawFilters.inactiveForDays || rawFilters.inactive_for_days || 0) || null,
    excludeHandoff: rawFilters.excludeHandoff !== false && rawFilters.exclude_handoff !== false,
    requireConversation: rawFilters.requireConversation !== false && rawFilters.require_conversation !== false,
    limit: toLimit(rawFilters.limit, 500)
  };

  const contacts = await prisma.contact.findMany({
    where: { maxUserId: { not: "" } },
    orderBy: { updatedAt: "desc" },
    take: Math.max(filters.limit * 3, filters.limit),
    include: {
      completedVisits: {
        orderBy: { visitDate: "desc" },
        take: 1,
        include: { service: true, doctor: true }
      },
      conversations: {
        orderBy: { lastMessageAt: "desc" },
        take: 1,
        include: { memory: true }
      }
    }
  });

  const now = new Date();
  const recipients = [];

  for (const contact of contacts) {
    const conversation = contact.conversations?.[0] || null;
    if (filters.requireConversation && !conversation) continue;

    const status = conversation?.status || null;
    if (filters.excludeHandoff && ["human_takeover", "handoff_required"].includes(status)) continue;

    const lastActivity = conversation?.lastMessageAt
      ? new Date(conversation.lastMessageAt)
      : (contact.updatedAt ? new Date(contact.updatedAt) : null);

    if (filters.activeWithinDays && lastActivity) {
      // оставить только тех, кто писал не позднее N дней назад
      if (lastActivity < addDays(now, -filters.activeWithinDays)) continue;
    }
    if (filters.inactiveForDays && lastActivity) {
      // оставить только тех, кто молчит не меньше N дней
      if (lastActivity > addDays(now, -filters.inactiveForDays)) continue;
    }

    const memory = conversation?.memory?.memory || {};
    const lastVisit = contact.completedVisits?.[0] || null;
    recipients.push({
      ...buildRecipient(contact, lastVisit, memory),
      conversation_status: status,
      last_activity: lastActivity ? toIsoDate(lastActivity) : null
    });
    if (recipients.length >= filters.limit) break;
  }

  return recipients;
}

export async function queueBroadcast({ name, prompt, filters = {}, type = "broadcast", useAi = false }) {
  const recipients = filters.mode === "contacts"
    ? await getContactAudience(filters)
    : await getBroadcastRecipients(filters);
  return createCampaignWithMessages({
    name,
    prompt,
    filters,
    type,
    recipients,
    useAi
  });
}

export async function queueManualBroadcast({
  contactIds = [],
  message = "",
  dryRun = true,
  sendWindow = {},
  allowHumanTakeover = false
} = {}) {
  const safeMessage = normalizeText(message);
  const ids = [...new Set((Array.isArray(contactIds) ? contactIds : []).map((value) => String(value || "").trim()).filter(Boolean))];

  if (!safeMessage) {
    throw new Error("message is required");
  }

  if (!ids.length) {
    throw new Error("contact_ids is required");
  }

  const numericIds = ids.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0);
  const stringIds = ids.filter((value) => !numericIds.includes(Number(value)));
  const contacts = await prisma.contact.findMany({
    where: {
      OR: [
        numericIds.length ? { id: { in: numericIds } } : undefined,
        stringIds.length ? { maxUserId: { in: stringIds } } : undefined
      ].filter(Boolean)
    },
    include: {
      conversations: {
        orderBy: { lastMessageAt: "desc" },
        take: 1,
        include: { memory: true }
      }
    }
  });

  const recipients = contacts
    .filter((contact) => contact.maxUserId)
    .filter((contact) => allowHumanTakeover || !["human_takeover", "handoff_required"].includes(contact.conversations?.[0]?.status))
    .map((contact) => {
      const memory = contact.conversations?.[0]?.memory?.memory || {};
      const recipient = buildRecipient(contact, null, memory);
      return {
        ...recipient,
        conversation_status: contact.conversations?.[0]?.status || null,
        preview: renderTemplateMessage(safeMessage, recipient, "manual_broadcast")
      };
    });

  if (dryRun) {
    return {
      dry_run: true,
      recipients_found: recipients.length,
      recipients: recipients.map((recipient) => ({
        contact_id: recipient.contact_id,
        chat_id: recipient.chat_id,
        display_name: recipient.display_name,
        patient_name: recipient.patient_name,
        conversation_status: recipient.conversation_status,
        preview: recipient.preview
      }))
    };
  }

  const scheduledAt = nextAllowedSendAt(sendWindow);
  const campaign = await prisma.broadcastCampaign.create({
    data: {
      name: `Manual broadcast ${new Date().toISOString().slice(0, 10)}`,
      prompt: safeMessage,
      filters: {
        contact_ids: ids,
        send_window: normalizeSendWindow(sendWindow),
        allow_human_takeover: allowHumanTakeover
      },
      type: "manual_broadcast",
      status: "queued",
      recipientsCount: recipients.length,
      startedAt: new Date()
    }
  });

  const hash = crypto.createHash("sha1").update(safeMessage).digest("hex").slice(0, 16);
  const created = [];
  const skipped = [];

  for (const recipient of recipients) {
    try {
      const row = await prisma.outboundMessageQueue.create({
        data: {
          campaignId: campaign.id,
          contactId: recipient.contact_id,
          chatId: recipient.chat_id,
          chatName: recipient.display_name || null,
          recipientName: recipient.patient_name || recipient.display_name || null,
          type: "manual_broadcast",
          priority: 40,
          dedupeKey: `manual:${hash}:${recipient.contact_id}`,
          prompt: safeMessage,
          messageText: recipient.preview,
          status: "queued",
          scheduledAt,
          rawPayload: {
            ...recipient,
            event: "manual_broadcast_created"
          }
        }
      });
      created.push(row);
    } catch (error) {
      if (error.code === "P2002") {
        skipped.push({ recipient, reason: "dedupe" });
        continue;
      }
      throw error;
    }
  }

  await prisma.broadcastCampaign.update({
    where: { id: campaign.id },
    data: {
      recipientsCount: created.length,
      status: created.length ? "queued" : "empty"
    }
  });

  return {
    dry_run: false,
    campaign_id: campaign.id,
    recipients_found: recipients.length,
    queued: created.length,
    skipped: skipped.length,
    scheduled_at: scheduledAt.toISOString(),
    events: [{ type: "manual_broadcast_created", campaign_id: campaign.id, queued: created.length }]
  };
}

export async function queueAnnualHygieneBroadcast({ prompt = defaultAnnualHygienePrompt, limit = 200, useAi = false } = {}) {
  const recipients = await getAnnualHygieneRecipients({ limit });
  return createCampaignWithMessages({
    name: `Годовое напоминание о профгигиене ${currentYear()}`,
    prompt,
    filters: { annual_hygiene: true, limit },
    type: "annual_hygiene",
    recipients,
    useAi,
    dedupeScope: `annual_hygiene:${currentYear()}`
  });
}

function normalizeSendWindow(sendWindow = {}) {
  return {
    start: normalizeTime(sendWindow.start || sendWindow.start_time || config.reminderSendWindowStart || "09:00") || "09:00",
    end: normalizeTime(sendWindow.end || sendWindow.end_time || config.reminderSendWindowEnd || "21:00") || "21:00"
  };
}

function normalizeTime(value = "") {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Math.min(23, Math.max(0, Number(match[1])));
  const minutes = Math.min(59, Math.max(0, Number(match[2])));
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function nextAllowedSendAt(sendWindow = {}) {
  const window = normalizeSendWindow(sendWindow);
  const now = new Date();
  const start = dateAtTime(now, window.start);
  const end = dateAtTime(now, window.end);

  if (now < start) return start;
  if (now <= end) return now;

  const tomorrow = addDays(now, 1);
  return dateAtTime(tomorrow, window.start);
}

function dateAtTime(date, time) {
  const [hours, minutes] = String(time || "09:00").split(":").map(Number);
  const next = new Date(date);
  next.setHours(hours || 0, minutes || 0, 0, 0);
  return next;
}

export async function getOutboundQueue({ status = "", type = "", search = "", page = 1, pageSize = 50, limit = null } = {}) {
  const currentPage = Math.max(1, Number(page || 1));
  const take = toLimit(pageSize || limit, 50);
  const text = normalizeText(search);
  const where = {
    ...(normalizeText(status) ? { status: normalizeText(status) } : {}),
    ...(normalizeText(type) ? { type: normalizeText(type) } : {}),
    ...(text
      ? {
          OR: [
            { chatName: { contains: text, mode: "insensitive" } },
            { recipientName: { contains: text, mode: "insensitive" } },
            { chatId: { contains: text, mode: "insensitive" } },
            { messageText: { contains: text, mode: "insensitive" } }
          ]
        }
      : {})
  };
  const [items, total, grouped] = await Promise.all([
    prisma.outboundMessageQueue.findMany({
      where,
      orderBy: [{ scheduledAt: "desc" }, { id: "desc" }],
      skip: (currentPage - 1) * take,
      take,
      include: {
        contact: true,
        campaign: true
      }
    }),
    prisma.outboundMessageQueue.count({ where }),
    prisma.outboundMessageQueue.groupBy({
      by: ["status"],
      _count: { _all: true }
    })
  ]);

  return {
    items,
    pagination: {
      page: currentPage,
      page_size: take,
      total,
      total_pages: Math.max(Math.ceil(total / take), 1),
      has_prev: currentPage > 1,
      has_next: currentPage * take < total
    },
    stats: Object.fromEntries(grouped.map((row) => [row.status, row._count._all]))
  };
}

async function createCampaignWithMessages({ name, prompt, filters, type, recipients, useAi, dedupeScope = null }) {
  const safePrompt = normalizeText(prompt);
  if (!safePrompt) {
    throw new Error("prompt is required");
  }

  const campaign = await prisma.broadcastCampaign.create({
    data: {
      name: normalizeText(name) || null,
      prompt: safePrompt,
      filters,
      type,
      status: "queued",
      recipientsCount: recipients.length,
      startedAt: new Date()
    }
  });

  const created = [];
  const skipped = [];

  for (const recipient of recipients) {
    const dedupeKey = dedupeScope
      ? `${dedupeScope}:${recipient.contact_id}`
      : `broadcast:${campaign.id}:${recipient.contact_id || recipient.chat_id}`;
    const messageText = await buildPersonalizedMessage({ prompt: safePrompt, recipient, type, useAi });

    try {
      const row = await prisma.outboundMessageQueue.create({
        data: {
          campaignId: campaign.id,
          contactId: recipient.contact_id || null,
          chatId: recipient.chat_id,
          chatName: recipient.display_name || null,
          recipientName: recipient.patient_name || recipient.display_name || null,
          type,
          priority: type === "annual_hygiene" ? 80 : 60,
          dedupeKey,
          prompt: safePrompt,
          messageText,
          status: "queued",
          rawPayload: recipient
        }
      });
      created.push(row);
    } catch (error) {
      if (error.code === "P2002") {
        skipped.push({ recipient, reason: "dedupe" });
        continue;
      }
      throw error;
    }
  }

  await prisma.broadcastCampaign.update({
    where: { id: campaign.id },
    data: {
      recipientsCount: created.length,
      status: created.length ? "queued" : "empty"
    }
  });

  return {
    campaign_id: campaign.id,
    recipients_found: recipients.length,
    queued: created.length,
    skipped: skipped.length,
    skipped_items: skipped.slice(0, 20)
  };
}

async function buildPersonalizedMessage({ prompt, recipient, type, useAi }) {
  if (useAi && config.groqApiKey) {
    const generated = await generateWithGroq({ prompt, recipient, type }).catch(() => null);
    if (generated) return generated;
  }

  return renderTemplateMessage(prompt, recipient, type);
}

async function generateWithGroq({ prompt, recipient, type }) {
  const groq = new Groq({ apiKey: config.groqApiKey });
  const completion = await groq.chat.completions.create({
    model: config.groqModel,
    temperature: 0.55,
    max_tokens: 180,
    messages: [
      {
        role: "system",
        content: [
          "Ты администратор стоматологической клиники.",
          "Пиши одно короткое сообщение клиенту на русском.",
          "Не ставь диагнозы, не обещай результат лечения, не дави на клиента.",
          "Не используй markdown и кавычки вокруг ответа."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify({
          task_prompt: prompt,
          campaign_type: type,
          recipient
        }, null, 2)
      }
    ]
  });

  return normalizeText(completion.choices?.[0]?.message?.content || "").slice(0, 900);
}

function renderTemplateMessage(prompt, recipient, type) {
  const name = shortName(recipient.patient_name || recipient.display_name);
  const vars = {
    name,
    patient_name: recipient.patient_name || recipient.display_name || "",
    last_service: recipient.last_service || "профгигиена",
    last_visit_date: recipient.last_visit_date || "",
    clinic_name: config.clinicName || "DentalCare"
  };

  const hasVars = /\{\{\s*[a-z_]+\s*\}\}/iu.test(prompt);
  if (hasVars) {
    return prompt.replace(/\{\{\s*([a-z_]+)\s*\}\}/giu, (match, key) => vars[key] ?? "");
  }

  if (type === "annual_hygiene") {
    const prefix = name ? `${name}, добрый день! ` : "Добрый день! ";
    const datePart = recipient.last_visit_date ? `Последний раз вы были у нас ${recipient.last_visit_date}. ` : "";
    return normalizeText(`${prefix}${datePart}Напоминаем, что профессиональную гигиену полости рта обычно рекомендуют проходить примерно раз в год. Если хотите, подберем удобное время для записи.`);
  }

  const prefix = name ? `${name}, ` : "";
  return normalizeText(`${prefix}${prompt}`);
}

function buildRecipient(contact, lastVisit, memory = {}) {
  return {
    contact_id: contact.id,
    chat_id: contact.maxUserId,
    display_name: contact.displayName || null,
    patient_name: contact.patientName || memory.patient_name || lastVisit?.patientName || contact.displayName || null,
    phone: contact.phone || lastVisit?.phone || memory.phone || null,
    last_service: lastVisit?.service?.name || lastVisit?.serviceName || null,
    last_visit_date: toIsoDate(lastVisit?.visitDate),
    doctor: lastVisit?.doctor?.fullName || null,
    memory
  };
}

function serviceMatches(visit, query) {
  const lower = query.toLowerCase();
  return [
    visit.serviceName,
    visit.service?.name,
    visit.service?.slug,
    visit.notes
  ].some((value) => String(value || "").toLowerCase().includes(lower));
}

function isHygieneVisit(visit) {
  return hygienePattern.test([
    visit.serviceName,
    visit.service?.name,
    visit.service?.slug,
    visit.notes
  ].filter(Boolean).join(" "));
}
