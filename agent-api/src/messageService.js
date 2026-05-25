import { generateAgentResponse } from "./agent.js";
import {
  buildClinicDateTime as buildParsedClinicDateTime,
  extractBookingFacts,
  formatDateForReply as formatBookingDateForReply,
  getMissingAppointmentFields,
  isBookingIntent,
  normalizeAppointmentDate,
  normalizeAppointmentTime,
  normalizeBookingMemory,
  toIsoDate as toBookingIsoDate
} from "./bookingParser.js";
import { prisma } from "./db.js";

function normalizeChannel(channel) {
  return (cleanScalar(channel) || "MAX").toUpperCase();
}

function mergeMemory(currentMemory, ...updates) {
  return Object.fromEntries(
    Object.entries({
      ...(currentMemory || {}),
      ...Object.assign({}, ...updates.filter(Boolean))
    }).filter(([, value]) => value !== null && value !== undefined && value !== "")
  );
}

function cleanIncomingText(value) {
  return cleanScalar(value);
}

function cleanScalar(value) {
  if (value === null || value === undefined) return "";

  let text = String(value).replace(/\u00a0/g, " ").trim();
  while (text.startsWith("=")) {
    text = text.slice(1).trim();
  }

  if (/^(null|undefined)$/iu.test(text)) return "";
  return text;
}

function cleanOptional(value) {
  return cleanScalar(value) || null;
}

function normalizeIncomingPayload(payload = {}) {
  const messageText = cleanIncomingText(payload.message_text);
  const maxUserId = cleanScalar(payload.max_user_id);
  const channel = normalizeChannel(payload.channel);

  return {
    ...payload,
    channel,
    max_user_id: maxUserId,
    display_name: cleanOptional(payload.display_name),
    phone: cleanOptional(payload.phone),
    message_text: messageText
  };
}

async function findOrCreateConversation(contactId, channel) {
  const existing = await prisma.conversation.findFirst({
    where: {
      contactId,
      channel,
      status: "active"
    },
    orderBy: { createdAt: "desc" }
  });

  if (existing) return existing;

  return prisma.conversation.create({
    data: {
      contactId,
      channel,
      status: "active",
      lastMessageAt: new Date()
    }
  });
}

export async function processIncomingMessage(input) {
  const rawPayload = input?.body && !input.message_text ? input.body : input;
  const payload = normalizeIncomingPayload(rawPayload);
  const messageText = payload.message_text;
  const maxUserId = payload.max_user_id;
  const channel = payload.channel;

  if (!messageText) {
    throw new Error("message_text is required");
  }

  if (!maxUserId) {
    throw new Error("max_user_id is required");
  }

  const contact = await prisma.contact.upsert({
    where: { maxUserId },
    update: {
      displayName: payload.display_name || undefined,
      phone: payload.phone || undefined,
      updatedAt: new Date()
    },
    create: {
      maxUserId,
      displayName: payload.display_name || null,
      phone: payload.phone || null
    }
  });

  const conversation = await findOrCreateConversation(contact.id, channel);

  const incomingMessage = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      contactId: contact.id,
      direction: "incoming",
      role: "user",
      text: messageText,
      rawPayload: payload
    }
  });

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      lastMessageAt: new Date(),
      updatedAt: new Date()
    }
  });

  const memoryRow = await prisma.conversationMemory.findUnique({
    where: { conversationId: conversation.id }
  });

  const recentMessagesDesc = await prisma.message.findMany({
    where: {
      conversationId: conversation.id,
      id: { not: incomingMessage.id }
    },
    orderBy: { createdAt: "desc" },
    take: 12
  });
  const recentMessages = recentMessagesDesc.reverse();
  const activeAppointment = await findActiveAppointmentRequest({
    conversationId: conversation.id,
    contactId: contact.id
  });
  const baseMemory = activeAppointment
    ? memoryRow?.memory || {}
    : clearStaleBookingMemory(memoryRow?.memory || {});

  const agentResult = await generateAgentResponse({
    userMessage: messageText,
    history: prepareHistoryForAgent(recentMessages, { activeAppointment }),
    memory: baseMemory
  });
  const deterministicFacts = extractBookingFacts(messageText);
  const currentMessageBookingSignal = isBookingIntent({
    text: messageText,
    memory: deterministicFacts
  }) || hasSchedulingBookingFacts(deterministicFacts);
  const safeMemoryUpdate = !activeAppointment && !currentMessageBookingSignal
    ? clearStaleBookingMemory(sanitizeAgentMemoryUpdate(agentResult.memory_update, messageText))
    : sanitizeAgentMemoryUpdate(agentResult.memory_update, messageText);
  const safeAgentResult = {
    ...agentResult,
    memory_update: safeMemoryUpdate
  };

  const nextMemory = normalizeBookingMemory(mergeMemory(
    baseMemory,
    safeAgentResult.memory_update,
    deterministicFacts
  ));
  const hasBookingDraft = isDraftAppointmentStatus(activeAppointment?.status);
  const hasConfirmedBooking = activeAppointment?.status === "confirmed";
  const bookingIntent = currentMessageBookingSignal || (
    hasBookingDraft &&
    shouldContinueBookingDraft({
      messageText,
      agentResult: safeAgentResult,
      deterministicFacts
    })
  );
  const postBookingSocialReply = hasConfirmedBooking
    ? buildPostBookingSocialReply({ messageText, appointmentRequest: activeAppointment, memory: nextMemory })
    : null;
  const missingBookingFields = getMissingAppointmentFields({ memory: nextMemory, payload });
  const responseMissingBookingFields = bookingIntent ? missingBookingFields : [];
  const shouldCreateAppointmentRequest = !agentResult.should_handoff &&
    bookingIntent &&
    missingBookingFields.length === 0;
  let appointmentRequest = null;
  let slotConflict = null;

  if (!agentResult.should_handoff && bookingIntent) {
    const bookingResult = await upsertAppointmentRequest({
      conversationId: conversation.id,
      contactId: contact.id,
      payload,
      memory: nextMemory,
      confirm: shouldCreateAppointmentRequest,
      missingFields: missingBookingFields
    });
    appointmentRequest = bookingResult.appointmentRequest;
    slotConflict = bookingResult.slotConflict;
  }

  let finalReply = agentResult.reply;
  let replySource = "agent";
  if (postBookingSocialReply) {
    finalReply = postBookingSocialReply;
    replySource = "post_booking_social";
  } else if (slotConflict) {
    finalReply = buildSlotConflictReply({ memory: nextMemory, slotConflict, messageText });
    replySource = "slot_conflict";
  } else if (appointmentRequest && shouldCreateAppointmentRequest) {
    finalReply = buildBookingConfirmedReply({ appointmentRequest, memory: nextMemory, messageText });
    replySource = "booking_confirmed";
  } else if (bookingIntent && shouldUseWorkflowProgressReply({
    agentReply: agentResult.reply,
    missingFields: missingBookingFields,
    messageText
  })) {
    finalReply = buildBookingProgressReply({ memory: nextMemory, payload, missingFields: missingBookingFields, messageText });
    replySource = "booking_progress";
  }
  finalReply = sanitizeStaleBookingReply({
    reply: finalReply,
    messageText,
    memory: nextMemory,
    activeAppointment,
    bookingIntent
  });

  const outgoingMessage = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      contactId: contact.id,
      direction: "outgoing",
      role: "assistant",
      text: finalReply,
      rawPayload: {
        ...agentResult,
        memory_update: safeAgentResult.memory_update,
        reply: finalReply,
        deterministic_facts: deterministicFacts,
        booking_intent: bookingIntent,
        missing_booking_fields: responseMissingBookingFields,
        slot_conflict: slotConflict,
        reply_source: replySource
      }
    }
  });

  await prisma.conversationMemory.upsert({
    where: { conversationId: conversation.id },
    update: {
      memory: nextMemory,
      updatedAt: new Date()
    },
    create: {
      conversationId: conversation.id,
      memory: nextMemory
    }
  });

  await prisma.agentAction.create({
    data: {
      conversationId: conversation.id,
      actionType: agentResult.should_handoff ? "handoff" : "answer",
      reason: agentResult.handoff_reason || agentResult.intent || null,
      payload: safeAgentResult
    }
  });

  if (agentResult.should_handoff) {
    await prisma.handoff.create({
      data: {
        conversationId: conversation.id,
        contactId: contact.id,
        reason: agentResult.handoff_reason || "agent_requested_handoff",
        status: "open"
      }
    });
  }

  return {
    reply: finalReply,
    intent: bookingIntent ? "book_appointment" : agentResult.intent,
    urgency: agentResult.urgency,
    should_handoff: agentResult.should_handoff,
    should_create_appointment_request: shouldCreateAppointmentRequest && !slotConflict,
    slot_conflict: slotConflict,
    missing_booking_fields: responseMissingBookingFields,
    contact_id: contact.id,
    conversation_id: conversation.id,
    incoming_message_id: incomingMessage.id,
    outgoing_message_id: outgoingMessage.id,
    appointment_request_id: appointmentRequest?.id || null,
    memory: nextMemory
  };
}

async function upsertAppointmentRequest({ conversationId, contactId, payload, memory, confirm = false, missingFields = [] }) {
  const preferredDate = normalizeAppointmentDate(memory.preferred_date);
  const preferredTime = normalizeAppointmentTime(memory.preferred_time);
  const status = confirm
    ? "confirmed"
    : missingFields.length === 1 && missingFields[0] === "consent_to_book"
      ? "waiting_confirmation"
      : "collecting";

  try {
    const appointmentRequest = await prisma.$transaction(async (tx) => {
      const existingCandidates = await tx.appointmentRequest.findMany({
        where: {
          conversationId,
          contactId,
          status: { in: ["new", "pending", "collecting", "waiting_confirmation", "confirmed"] }
        },
        orderBy: { createdAt: "desc" },
        take: 10
      });
      const reusableExisting = existingCandidates.find(isAppointmentStillRelevant) || null;

      const data = {
        patientName: memory.patient_name || payload.display_name || null,
        phone: memory.phone || payload.phone || null,
        complaint: memory.complaint || null,
        requestedService: memory.requested_service || null,
        preferredDate,
        preferredTime,
        preferredDoctor: memory.preferred_doctor || null,
        urgency: memory.urgency || "normal",
        consentToBook: Boolean(memory.consent_to_book),
        status,
        updatedAt: new Date()
      };

      const appointment = reusableExisting
        ? await tx.appointmentRequest.update({
            where: { id: reusableExisting.id },
            data
          })
        : await tx.appointmentRequest.create({
            data: {
              conversationId,
              contactId,
              ...data
            }
          });

      if (confirm) {
        await tx.appointmentSlot.upsert({
          where: { appointmentRequestId: appointment.id },
          update: {
            slotDate: preferredDate,
            slotTime: preferredTime,
            status: "booked",
            updatedAt: new Date()
          },
          create: {
            appointmentRequestId: appointment.id,
            slotDate: preferredDate,
            slotTime: preferredTime,
            status: "booked"
          }
        });

        await createReminderRows(tx, {
          appointmentRequestId: appointment.id,
          contactId,
          preferredDate,
          preferredTime
        });
      }

      return appointment;
    });

    return { appointmentRequest, slotConflict: null };
  } catch (error) {
    if (error.code === "P2002") {
      return {
        appointmentRequest: null,
        slotConflict: {
          preferred_date: toBookingIsoDate(preferredDate),
          preferred_time: preferredTime
        }
      };
    }

    throw error;
  }
}

async function findActiveAppointmentRequest({ conversationId, contactId }) {
  const appointments = await prisma.appointmentRequest.findMany({
    where: {
      conversationId,
      contactId,
      status: { in: ["new", "pending", "collecting", "waiting_confirmation", "confirmed"] }
    },
    orderBy: { createdAt: "desc" }
  });

  return appointments.find(isAppointmentStillRelevant) || null;
}

function isDraftAppointmentStatus(status) {
  return ["new", "pending", "collecting", "waiting_confirmation"].includes(status);
}

function isAppointmentStillRelevant(appointment) {
  if (!appointment) return false;
  if (isDraftAppointmentStatus(appointment.status)) return true;
  if (appointment.status !== "confirmed") return false;

  const appointmentAt = buildParsedClinicDateTime(appointment.preferredDate, appointment.preferredTime);
  if (!appointmentAt) return true;

  return appointmentAt > new Date();
}

function clearStaleBookingMemory(memory = {}) {
  const cleaned = { ...(memory || {}) };

  delete cleaned.intent;
  delete cleaned.preferred_date;
  delete cleaned.preferred_time;
  delete cleaned.consent_to_book;
  delete cleaned.preferred_doctor;
  delete cleaned.requested_service;
  delete cleaned.urgency;
  delete cleaned.complaint;

  return cleaned;
}

function prepareHistoryForAgent(messages = [], { activeAppointment = null } = {}) {
  const prepared = [];
  let previousKey = "";

  for (const message of messages) {
    const text = cleanScalar(message.text);
    if (!text) continue;

    if (!activeAppointment && isStaleBookingHistoryMessage(message)) {
      continue;
    }

    const key = `${message.role}:${text.toLowerCase()}`;
    if (key === previousKey) continue;

    prepared.push({ ...message, text });
    previousKey = key;
  }

  return prepared.slice(-8);
}

function isStaleBookingHistoryMessage(message) {
  const text = String(message.text || "").toLowerCase();
  if (message.role === "assistant") {
    return /(запис|ждем|ждём|напоминан|визит|при[её]м).{0,80}(\d{1,2}:\d{2}|\d{1,2}\.\d{1,2})/iu.test(text) ||
      /(запись подтвержд|готово, записала|напоминание)/iu.test(text);
  }

  return false;
}

function hasActionableBookingFacts(facts = {}) {
  return Boolean(
    facts.intent === "book_appointment" ||
    facts.patient_name ||
    facts.phone ||
    facts.complaint ||
    facts.preferred_date ||
    facts.preferred_time ||
    facts.requested_service ||
    facts.preferred_doctor ||
    facts.consent_to_book === true
  );
}

function hasSchedulingBookingFacts(facts = {}) {
  return Boolean(
    facts.intent === "book_appointment" ||
    facts.patient_name ||
    facts.phone ||
    facts.preferred_date ||
    facts.preferred_time ||
    facts.preferred_doctor ||
    facts.consent_to_book === true
  );
}

function sanitizeAgentMemoryUpdate(update = {}, messageText = "") {
  const cleaned = { ...(update || {}) };
  const lower = String(messageText || "").toLowerCase().trim();
  const socialOrNoise = /^(спасибо|благодарю|хорошо|понял|поняла|ок|окей|да|нет|ага|угу|ладно|класс|супер)[.!?\s]*$/iu.test(lower) ||
    /(лол|бот|робот|какашка|нах|хуй|пизд|еба|ёба|бля)/iu.test(lower);

  if (socialOrNoise) {
    delete cleaned.complaint;
    delete cleaned.requested_service;
    if (cleaned.intent && cleaned.intent !== "book_appointment") {
      delete cleaned.intent;
    }
    return cleaned;
  }

  if (cleaned.complaint && !looksLikeDentalTopic(messageText) && cleanScalar(cleaned.complaint) === cleanScalar(messageText)) {
    delete cleaned.complaint;
  }

  if (cleaned.requested_service && !looksLikeDentalTopic(messageText) && cleanScalar(cleaned.requested_service) === cleanScalar(messageText)) {
    delete cleaned.requested_service;
  }

  return cleaned;
}

function looksLikeDentalTopic(text = "") {
  return /(зуб|десн|бол|ноет|кариес|пломб|пульпит|периодонт|чистк|гигиен|удален|удалит|имплант|коронк|протез|брекет|элайнер|прикус|консультац|осмотр|лечение|лечить|стоматолог|врач)/iu.test(String(text || ""));
}

function shouldContinueBookingDraft({ messageText, agentResult = {}, deterministicFacts = {} }) {
  const lower = String(messageText || "").toLowerCase();
  const memoryUpdate = agentResult.memory_update || {};

  if (/(какие|что есть|услуг|цен|стоимост|прайс|сколько стоит)/iu.test(lower)) {
    return false;
  }

  if (/(спасибо|благодар|хорошо|понял|поняла|окей|^ок$|лол|бот|робот|нах|хуй|пизд|еба|ёба|бля)/iu.test(lower)) {
    return false;
  }

  if (hasActionableBookingFacts(deterministicFacts)) return true;
  if (hasActionableBookingFacts(memoryUpdate)) return true;
  if (agentResult.intent === "book_appointment") return true;

  return false;
}

function shouldUseWorkflowProgressReply({ agentReply = "", missingFields = [], messageText = "" }) {
  const reply = String(agentReply || "").trim().toLowerCase();
  if (!reply) return true;

  const lowerMessage = String(messageText || "").toLowerCase();
  if (/(какие|что есть|услуг|цен|стоимост|прайс|сколько стоит)/iu.test(lowerMessage)) {
    return false;
  }

  const genericPatterns = [
    /чем могу помочь/u,
    /что беспокоит или на какую услугу/u,
    /подскажите, что беспокоит/u,
    /напишите услугу, дату/u
  ];

  if (genericPatterns.some((pattern) => pattern.test(reply))) {
    return true;
  }

  if (missingFields.includes("consent_to_book")) {
    return !/(фиксир|запис|подтверд|оформ|передать заявку|подходит|соглас)/iu.test(reply);
  }

  if (missingFields.includes("preferred_date") && !/(день|дат|когда|сегодня|завтра)/iu.test(reply)) {
    return true;
  }

  if (missingFields.includes("preferred_time") && !/(время|когда|во сколько|час)/iu.test(reply)) {
    return true;
  }

  return false;
}

function sanitizeStaleBookingReply({ reply = "", messageText = "", memory = {}, activeAppointment = null, bookingIntent = false }) {
  if (activeAppointment || bookingIntent) return reply;

  const text = String(reply || "").trim();
  const lowerReply = text.toLowerCase();
  const lowerMessage = String(messageText || "").toLowerCase().trim();
  const mentionsOldVisit = /(ждем|ждём|напоминан|подтвержден|подтверждена|запись подтвержд)/iu.test(lowerReply) ||
    /(\d{1,2}:\d{2}|\d{1,2}\.\d{1,2}(?:\.20\d{2})?)/u.test(lowerReply);
  if (!mentionsOldVisit) return reply;

  const name = shortName(memory.patient_name || "");

  if (/^(привет|здравствуйте|добрый день|добрый вечер|дратути)[!.?\s]*$/iu.test(lowerMessage)) {
    return name ? `Привет, ${name}. Чем могу помочь?` : "Здравствуйте! Чем могу помочь?";
  }

  if (/^(спасибо|благодарю|хорошо|ок|окей|понял|поняла)[!.?\s]*$/iu.test(lowerMessage)) {
    return "Пожалуйста.";
  }

  if (/(бот|робот|повтор|одно и то же|нах|хуй|пизд|еба|ёба|бля)/iu.test(lowerMessage)) {
    return "Поняла, повторяться не буду. Напишите, что нужно уточнить по услугам или записи.";
  }

  return name
    ? `${name}, уточните, пожалуйста, что сейчас нужно: услуги, цена или новая запись?`
    : "Уточните, пожалуйста, что сейчас нужно: услуги, цена или новая запись?";
}

function buildPostBookingSocialReply({ messageText, appointmentRequest, memory }) {
  const lower = String(messageText || "").toLowerCase();
  const casual = isCasualMessage(messageText);
  const name = shortName(memory.patient_name || appointmentRequest.patientName || "");
  const prefix = name ? `${name}, ` : "";
  const date = appointmentRequest.preferredDate ? formatBookingDateForReply(appointmentRequest.preferredDate) : null;
  const time = appointmentRequest.preferredTime || null;
  const slot = date && time ? ` ${formatReplyDate(date, casual)} в ${time}` : "";

  if (/(что|чо|че|чё).{0,30}(писать|написать)|если\s+(что|чо|че|чё)/iu.test(lower)) {
    return casual
      ? `${prefix}просто пишите сюда: "перенести", "отменить" или что нужно уточнить. Я пойму.`
      : `${prefix}если что-то изменится, просто напишите сюда: перенести, отменить или уточнить запись.`;
  }

  if (/(спасибо|благодар|хорошо|понял|поняла|окей|^ок$|^да$)/iu.test(lower)) {
    return casual
      ? `${prefix}да, пожалуйста. Ждем вас${slot}.`
      : `${prefix}пожалуйста. Ждем вас${slot}.`;
  }

  if (/(одно и то же|повтор|лоль|лол|бот|робот|нах|хуй|пизд|еба|ёба|бля)/iu.test(lower)) {
    return casual
      ? `${prefix}поняла, не буду повторяться. Запись стоит${slot}. Если что - пишите сюда.`
      : `${prefix}поняла, повторяться не буду. Запись уже стоит${slot}; если нужно изменить время или что-то уточнить, просто напишите.`;
  }

  if (/(отмен|не приду|не получится|перенес|перенёс|другое время|другой день)/iu.test(lower)) {
    return casual
      ? `${prefix}ок, напишите новый день и время, я проверю.`
      : `${prefix}поняла. Напишите, на какой день и время перенести запись, и я проверю вариант.`;
  }

  return null;
}

function buildSlotConflictReply({ memory, slotConflict, messageText }) {
  const casual = isCasualMessage(messageText);
  const name = memory.patient_name ? `${shortName(memory.patient_name)}, ` : "";
  const date = formatReplyDate(formatBookingDateForReply(slotConflict.preferred_date), casual);
  return casual
    ? `${name}на ${date} в ${slotConflict.preferred_time} уже занято. Киньте другой день или время, проверю.`
    : `${name}на ${date} в ${slotConflict.preferred_time} уже есть запись. Напишите другой удобный день или время, и я проверю вариант.`;
}

function buildBookingConfirmedReply({ appointmentRequest, memory, messageText }) {
  const casual = isCasualMessage(messageText);
  const name = shortName(memory.patient_name || appointmentRequest.patientName);
  const service = memory.requested_service || appointmentRequest.requestedService;
  const date = formatBookingDateForReply(memory.preferred_date || appointmentRequest.preferredDate);
  const time = normalizeAppointmentTime(memory.preferred_time || appointmentRequest.preferredTime);
  const prefix = name ? `${name}, ` : "";
  const visitText = formatVisitText(service);
  const slot = `${formatReplyDate(date, casual)} в ${time}`;

  return casual
    ? `${prefix}готово, записала ${visitText} ${slot}. Напоминание тоже поставила. Если что - пишите сюда.`
    : `${prefix}готово, записала вас ${visitText} ${slot}. Напоминание перед визитом создала. Если что-то изменится, просто напишите.`;
}

function buildBookingProgressReply({ memory, payload, missingFields, messageText }) {
  const casual = isCasualMessage(messageText);
  const name = shortName(memory.patient_name || payload.display_name);
  const prefix = name ? `${name}, ` : "";
  const service = formatProgressService(memory.requested_service || memory.complaint || "прием");
  const date = memory.preferred_date ? formatBookingDateForReply(memory.preferred_date) : null;
  const time = normalizeAppointmentTime(memory.preferred_time);

  if (missingFields.includes("patient_name")) {
    return casual ? "Как вас зовут?" : "Подскажите, как вас зовут?";
  }

  if (missingFields.includes("reason")) {
    return casual
      ? `${prefix}что беспокоит или на какую услугу записать?`
      : `${prefix}подскажите, что беспокоит или на какую услугу хотите записаться?`;
  }

  if (missingFields.includes("preferred_date") && missingFields.includes("preferred_time")) {
    return casual ? `${prefix}на какой день и время удобно?` : `${prefix}на какой день и время вам удобно записаться?`;
  }

  if (missingFields.includes("preferred_date")) {
    return casual ? `${prefix}на какой день удобно?` : `${prefix}на какой день вам удобно записаться?`;
  }

  if (missingFields.includes("preferred_time")) {
    return casual ? `${prefix}на какое время удобно?` : `${prefix}на какое время вам удобно записаться?`;
  }

  if (missingFields.includes("consent_to_book")) {
    const replyDate = date ? formatReplyDate(date, casual) : null;
    return casual
      ? `${prefix}${service}${replyDate ? ` на ${replyDate}` : ""}${time ? ` в ${time}` : ""}. Фиксирую?`
      : `${prefix}проверяю данные: ${service}${replyDate ? ` на ${replyDate}` : ""}${time ? ` в ${time}` : ""}. Подтвердите, зафиксировать запись?`;
  }

  return casual
    ? `${prefix}напишите услугу, дату и удобное время.`
    : `${prefix}уточните детали записи: услугу, дату и удобное время.`;
}

function shortName(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.split(/\s+/u)[0];
}

function formatVisitText(service = "") {
  const normalized = String(service || "").trim().toLowerCase();
  if (!normalized || /^(лечение|лечение зубов|прием|приём)$/iu.test(normalized)) {
    return "на прием";
  }

  if (/при[её]м/u.test(normalized)) {
    return `на ${service}`;
  }

  return `на ${service}`;
}

function formatProgressService(service = "") {
  const normalized = String(service || "").trim();
  if (!normalized) return "прием";
  if (/^(лечение|лечение зубов)$/iu.test(normalized)) return "прием к стоматологу";
  return normalized;
}

function isCasualMessage(text = "") {
  const lower = String(text || "").toLowerCase();
  return /(чо|че|чё|шо|ща|щас|кароч|короч|базар|вокзал|если чо|если че|если чё|спс|пасиб|ага|норм|го|лол|кек|пж|плиз|нах|хуй|пизд|еба|ёба|бля)/iu.test(lower);
}

function formatReplyDate(dateText, casual = false) {
  const text = String(dateText || "");
  if (!casual) return text;

  return text.replace(/\.20\d{2}$/u, "");
}

function createReminderRows(tx, { appointmentRequestId, contactId, preferredDate, preferredTime }) {
  const appointmentAt = buildParsedClinicDateTime(preferredDate, preferredTime);
  if (!appointmentAt) return Promise.resolve();

  const now = new Date();
  const reminderOffsets = [
    { type: "24h_before", milliseconds: 24 * 60 * 60 * 1000 },
    { type: "2h_before", milliseconds: 2 * 60 * 60 * 1000 }
  ];
  const rows = reminderOffsets
    .map((offset) => ({
      appointmentRequestId,
      contactId,
      type: offset.type,
      remindAt: new Date(appointmentAt.getTime() - offset.milliseconds),
      status: "pending"
    }))
    .filter((row) => row.remindAt > now);

  if (!rows.length) return Promise.resolve();

  return tx.appointmentReminder.deleteMany({
    where: {
      appointmentRequestId,
      status: "pending"
    }
  }).then(() => tx.appointmentReminder.createMany({
    data: rows
  }));
}
