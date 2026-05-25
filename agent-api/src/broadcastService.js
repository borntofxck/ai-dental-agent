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

export async function queueBroadcast({ name, prompt, filters = {}, type = "broadcast", useAi = false }) {
  const recipients = await getBroadcastRecipients(filters);
  return createCampaignWithMessages({
    name,
    prompt,
    filters,
    type,
    recipients,
    useAi
  });
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

export async function getOutboundQueue({ status = "", limit = 100 } = {}) {
  const where = normalizeText(status) ? { status: normalizeText(status) } : {};
  const [items, grouped] = await Promise.all([
    prisma.outboundMessageQueue.findMany({
      where,
      orderBy: [{ scheduledAt: "desc" }, { id: "desc" }],
      take: toLimit(limit, 100),
      include: {
        contact: true,
        campaign: true
      }
    }),
    prisma.outboundMessageQueue.groupBy({
      by: ["status"],
      _count: { _all: true }
    })
  ]);

  return {
    items,
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
          priority: type === "annual_hygiene" ? 60 : 70,
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
    patient_name: memory.patient_name || lastVisit?.patientName || contact.displayName || null,
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
