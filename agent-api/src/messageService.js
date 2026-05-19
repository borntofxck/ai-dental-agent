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
  return (channel || "MAX").toUpperCase();
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
  const text = String(value || "").trim();
  return text.startsWith("=") ? text.slice(1).trim() : text;
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
  const payload = input?.body && !input.message_text ? input.body : input;
  const messageText = cleanIncomingText(payload.message_text);
  const maxUserId = String(payload.max_user_id || "").trim();
  const channel = normalizeChannel(payload.channel);

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

  const agentResult = await generateAgentResponse({
    userMessage: messageText,
    history: recentMessages,
    memory: memoryRow?.memory || {}
  });

  const deterministicFacts = extractBookingFacts(messageText);
  const nextMemory = normalizeBookingMemory(mergeMemory(
    memoryRow?.memory,
    agentResult.memory_update,
    deterministicFacts
  ));
  const currentMessageBookingSignal = isBookingIntent({
    text: messageText,
    memory: deterministicFacts
  }) || hasActionableBookingFacts(deterministicFacts);
  const hasBookingDraft = isDraftAppointmentStatus(activeAppointment?.status);
  const hasConfirmedBooking = activeAppointment?.status === "confirmed";
  const bookingIntent = currentMessageBookingSignal || hasBookingDraft;
  const postBookingSocialReply = hasConfirmedBooking
    ? buildPostBookingSocialReply({ messageText, appointmentRequest: activeAppointment, memory: nextMemory })
    : null;
  const missingBookingFields = getMissingAppointmentFields({ memory: nextMemory, payload });
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
  if (postBookingSocialReply) {
    finalReply = postBookingSocialReply;
  } else if (slotConflict) {
    finalReply = buildSlotConflictReply({ memory: nextMemory, slotConflict, messageText });
  } else if (appointmentRequest && shouldCreateAppointmentRequest) {
    finalReply = buildBookingConfirmedReply({ appointmentRequest, memory: nextMemory, messageText });
  } else if (bookingIntent) {
    finalReply = buildBookingProgressReply({ memory: nextMemory, payload, missingFields: missingBookingFields, messageText });
  }

  const outgoingMessage = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      contactId: contact.id,
      direction: "outgoing",
      role: "assistant",
      text: finalReply,
      rawPayload: {
        ...agentResult,
        reply: finalReply,
        deterministic_facts: deterministicFacts,
        booking_intent: bookingIntent,
        missing_booking_fields: missingBookingFields,
        slot_conflict: slotConflict
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
      payload: agentResult
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
    missing_booking_fields: missingBookingFields,
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
      const existing = await tx.appointmentRequest.findFirst({
        where: {
          conversationId,
          contactId,
          status: { in: ["new", "pending", "collecting", "waiting_confirmation", "confirmed"] }
        },
        orderBy: { createdAt: "desc" }
      });

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

      const appointment = existing
        ? await tx.appointmentRequest.update({
            where: { id: existing.id },
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
  return prisma.appointmentRequest.findFirst({
    where: {
      conversationId,
      contactId,
      status: { in: ["new", "pending", "collecting", "waiting_confirmation", "confirmed"] }
    },
    orderBy: { createdAt: "desc" }
  });
}

function isDraftAppointmentStatus(status) {
  return ["new", "pending", "collecting", "waiting_confirmation"].includes(status);
}

function hasActionableBookingFacts(facts = {}) {
  return Boolean(
    facts.intent === "book_appointment" ||
    facts.patient_name ||
    facts.phone ||
    facts.preferred_date ||
    facts.preferred_time ||
    facts.requested_service ||
    facts.preferred_doctor ||
    facts.consent_to_book === true
  );
}

function buildPostBookingSocialReply({ messageText, appointmentRequest, memory }) {
  const lower = String(messageText || "").toLowerCase();
  const casual = isCasualMessage(messageText);
  const name = memory.patient_name || appointmentRequest.patientName || "";
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
  const name = memory.patient_name ? `${memory.patient_name}, ` : "";
  const date = formatReplyDate(formatBookingDateForReply(slotConflict.preferred_date), casual);
  return casual
    ? `${name}на ${date} в ${slotConflict.preferred_time} уже занято. Киньте другой день или время, проверю.`
    : `${name}на ${date} в ${slotConflict.preferred_time} уже есть запись. Напишите другой удобный день или время, и я проверю вариант.`;
}

function buildBookingConfirmedReply({ appointmentRequest, memory, messageText }) {
  const casual = isCasualMessage(messageText);
  const name = memory.patient_name || appointmentRequest.patientName;
  const service = memory.requested_service || appointmentRequest.requestedService;
  const date = formatBookingDateForReply(memory.preferred_date || appointmentRequest.preferredDate);
  const time = normalizeAppointmentTime(memory.preferred_time || appointmentRequest.preferredTime);
  const prefix = name ? `${name}, ` : "";
  const visitText = service ? `на ${service}` : "на прием";
  const slot = `${formatReplyDate(date, casual)} в ${time}`;

  return casual
    ? `${prefix}готово, записала ${visitText} ${slot}. Напоминание тоже поставила. Если что - пишите сюда.`
    : `${prefix}готово, записала вас ${visitText} ${slot}. Напоминание перед визитом создала. Если что-то изменится, просто напишите.`;
}

function buildBookingProgressReply({ memory, payload, missingFields, messageText }) {
  const casual = isCasualMessage(messageText);
  const name = memory.patient_name || payload.display_name;
  const prefix = name ? `${name}, ` : "";
  const service = memory.requested_service || "прием";
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
