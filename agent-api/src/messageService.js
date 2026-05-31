import { classifyUserIntentWithLLM, humanizeReplyWithAI } from "./agent.js";
import crypto from "node:crypto";
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
import { config } from "./config.js";
import { prisma } from "./db.js";
import { sanitizeReplyForUser } from "./replySanitizer.js";

const RESPONSE_DEBOUNCE_MS = 8000;
const DUPLICATE_TEXT_WINDOW_MS = 10 * 60 * 1000;
const LOCK_TTL_MS = 30 * 1000;

const CONVERSATION_STATES = new Set([
  "idle",
  "answering_question",
  "collecting_booking_data",
  "waiting_booking_confirmation",
  "appointment_booked",
  "cancellation_requested",
  "reschedule_requested",
  "human_takeover",
  "handoff_required"
]);

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
    message_direction: cleanOptional(payload.message_direction || payload.direction),
    external_message_id: cleanOptional(payload.external_message_id || payload.externalMessageId),
    message_text: messageText
  };
}

async function findOrCreateConversation(contactId, channel) {
  const existing = await prisma.conversation.findFirst({
    where: {
      contactId,
      channel,
      status: { in: ["active", "human_takeover", "handoff_required"] }
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

export function isConversationInHumanTakeover(conversation = {}) {
  return ["human_takeover", "handoff_required"].includes(conversation?.status);
}

export async function takeOverConversation({ conversationId, reason = "handoff_required" } = {}) {
  if (!conversationId) return null;

  return prisma.conversation.update({
    where: { id: conversationId },
    data: {
      status: "human_takeover",
      updatedAt: new Date()
    }
  });
}

export async function returnConversationToAI({ conversationId } = {}) {
  if (!conversationId) return null;

  return prisma.conversation.update({
    where: { id: conversationId },
    data: {
      status: "active",
      updatedAt: new Date()
    }
  });
}

async function acquireProcessingLock(lockKey) {
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + LOCK_TTL_MS);
  const lockToken = crypto.randomUUID();

  try {
    await prisma.conversationProcessingLock.create({
      data: {
        lockKey,
        lockToken,
        lockedUntil
      }
    });
    return { acquired: true, lockToken };
  } catch (error) {
    if (error.code !== "P2002") {
      throw error;
    }

    const updated = await prisma.conversationProcessingLock.updateMany({
      where: {
        lockKey,
        lockedUntil: { lt: now }
      },
      data: {
        lockToken,
        lockedUntil,
        updatedAt: now
      }
    });

    return { acquired: updated.count > 0, lockToken };
  }
}

async function releaseProcessingLock(lockKey, lockToken) {
  await prisma.conversationProcessingLock.deleteMany({
    where: {
      lockKey,
      lockToken
    }
  }).catch(() => {});
}

function buildSkippedResponse({ reason, contact, conversation, incomingMessage = null, externalMessageId = null }) {
  return {
    reply: null,
    skipped: true,
    reason,
    contact_id: contact.id,
    conversation_id: conversation.id,
    incoming_message_id: incomingMessage?.id || null,
    external_message_id: externalMessageId || null
  };
}

function normalizeComparableMessage(value = "") {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

export function avoidRepeatedBotReply(reply = "", recentMessages = []) {
  const text = String(reply || "").trim();
  if (!text) return text;

  const lastOutgoing = [...recentMessages]
    .reverse()
    .find((message) => message.direction === "outgoing" || message.role === "assistant");

  if (!lastOutgoing || normalizeComparableMessage(lastOutgoing.text) !== normalizeComparableMessage(text)) {
    return text;
  }

  const alternatives = getReplyAlternatives(text);
  return alternatives.find((candidate) => normalizeComparableMessage(candidate) !== normalizeComparableMessage(text)) || text;
}

function getReplyAlternatives(reply = "") {
  const lower = String(reply || "").toLowerCase();

  if (/не\s+совсем\s+понял|не\s+совсем\s+поняла|не\s+разобрала|не\s+уловила|сообщение\s+пришло\s+не\s+полностью/iu.test(lower)) {
    return [
      "Напишите чуть подробнее, пожалуйста. Я помогу с лечением, ценой или записью.",
      "Не разобрала вопрос. Уточните, пожалуйста, что нужно: лечение, стоимость или запись.",
      "Похоже, я не поняла сообщение. Сформулируйте чуть подробнее, и я отвечу.",
      "Если вопрос по стоматологии или записи, напишите его чуть подробнее."
    ];
  }

  if (/передам\s+администратор|автоматические\s+действия\s+останов/iu.test(lower)) {
    return [
      "Поняла вас. Автоматические действия остановлю и передам администратору на проверку.",
      "Хорошо, не буду продолжать автоматический сценарий. Передам администратору, чтобы всё проверили.",
      "Приняла. Остановлю авто-действия и передам ситуацию администратору."
    ];
  }

  return [reply];
}

function isOutgoingPayload(payload = {}) {
  const direction = cleanScalar(payload.message_direction || payload.direction).toLowerCase();
  const role = cleanScalar(payload.role).toLowerCase();
  return direction === "outgoing" || direction === "assistant" || role === "assistant";
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

  if (isOutgoingPayload(payload)) {
    return {
      reply: null,
      skipped: true,
      reason: "outgoing_message_ignored",
      max_user_id: maxUserId,
      channel
    };
  }

  const lockKey = `conversation:${channel}:${maxUserId}`;
  const lock = await acquireProcessingLock(lockKey);
  if (!lock.acquired) {
    return {
      reply: null,
      skipped: true,
      reason: "conversation_locked",
      max_user_id: maxUserId,
      channel
    };
  }

  try {

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
  const externalMessageId = payload.external_message_id;

  if (externalMessageId) {
    const existingExternalMessage = await prisma.message.findUnique({
      where: { externalMessageId }
    });

    if (existingExternalMessage) {
      return buildSkippedResponse({
        reason: "duplicate_external_message_id",
        contact,
        conversation,
        externalMessageId
      });
    }
  }

  const lastIncomingMessage = await prisma.message.findFirst({
    where: {
      conversationId: conversation.id,
      direction: "incoming"
    },
    orderBy: { createdAt: "desc" }
  });

  if (
    lastIncomingMessage &&
    normalizeComparableMessage(lastIncomingMessage.text) === normalizeComparableMessage(messageText) &&
    lastIncomingMessage.createdAt &&
    Date.now() - new Date(lastIncomingMessage.createdAt).getTime() < DUPLICATE_TEXT_WINDOW_MS
  ) {
    return buildSkippedResponse({
      reason: "duplicate_latest_incoming_text",
      contact,
      conversation,
      externalMessageId
    });
  }

  const incomingMessage = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      contactId: contact.id,
      direction: "incoming",
      role: "user",
      text: messageText,
      externalMessageId,
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

  if (isConversationInHumanTakeover(conversation)) {
    const events = [
      {
        type: "ai_disabled_after_handoff",
        reason: "conversation_in_human_takeover"
      }
    ];

    await prisma.agentAction.create({
      data: {
        conversationId: conversation.id,
        actionType: "ai_skipped_human_takeover",
        reason: "conversation_in_human_takeover",
        payload: {
          incoming_message_id: incomingMessage.id,
          events
        }
      }
    });
    await logPipelineEvents({ conversationId: conversation.id, events });

    return {
      reply: null,
      skipped: true,
      reason: "human_takeover",
      contact_id: contact.id,
      conversation_id: conversation.id,
      incoming_message_id: incomingMessage.id
    };
  }

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
  let baseMemory = activeAppointment
    ? memoryRow?.memory || {}
    : clearStaleBookingMemory(memoryRow?.memory || {});
  const hardGuardIntent = detectConversationIntent(messageText);

  if (
    !activeAppointment &&
    baseMemory.status === "cancellation_requested" &&
    hardGuardIntent.intent === "message" &&
    hasExplicitBookingRequest(messageText)
  ) {
    baseMemory = { ...clearAppointmentDraft(baseMemory), status: "collecting_booking_data" };
  }

  const agentResult = await classifyUserIntentWithLLM({
    userMessage: messageText,
    history: prepareHistoryForAgent(recentMessages, { activeAppointment }),
    memory: baseMemory,
    activeAppointment,
    conversationState: baseMemory.status || (activeAppointment?.status === "confirmed" ? "appointment_booked" : "idle"),
    bookingDraft: {
      service: baseMemory.requested_service,
      date: baseMemory.preferred_date,
      time: baseMemory.preferred_time,
      status: baseMemory.status
    }
  });
  const riskAssessment = classifyConversationRisk({
    userMessage: messageText,
    agentOutput: agentResult,
    context: {
      recentMessages,
      memory: baseMemory,
      activeAppointment
    }
  });
  const riskGuard = buildRiskGuard(riskAssessment);
  if (riskGuard) {
    return await handleGuardedScriptedTurn({
      contact,
      conversation,
      incomingMessage,
      externalMessageId,
      payload,
      messageText,
      baseMemory,
      activeAppointment,
      guard: riskGuard
    });
  }
  const conversationIntent = hardGuardIntent;
  const guardedTurn = await buildPostClassifierGuard({
    guard: hardGuardIntent,
    agentResult,
    messageText,
    recentMessages,
    activeAppointment,
    memory: baseMemory
  });

  if (guardedTurn) {
    return await handleGuardedScriptedTurn({
      contact,
      conversation,
      incomingMessage,
      externalMessageId,
      payload,
      messageText,
      baseMemory,
      activeAppointment,
      guard: guardedTurn
    });
  }
  const deterministicFacts = extractBookingFacts(messageText);
  const explicitBookingConfirmation = hasExplicitBookingConfirmation(messageText);
  if (explicitBookingConfirmation) {
    deterministicFacts.consent_to_book = true;
  }
  const classifierBookingSignal = isClassifierBookingSignal(agentResult);
  const currentMessageBookingSignal = conversationIntent.intent === "booking_request" || classifierBookingSignal || hasExplicitBookingRequest(messageText) || isBookingIntent({
    text: messageText,
    memory: deterministicFacts
  });
  const safeMemoryUpdate = !activeAppointment && !currentMessageBookingSignal
    ? clearStaleBookingMemory(sanitizeAgentMemoryUpdate(agentResult.memory_update, messageText))
    : sanitizeAgentMemoryUpdate(agentResult.memory_update, messageText);
  const safeAgentResult = {
    ...agentResult,
    memory_update: safeMemoryUpdate
  };
  const pipelineEvents = [
    ...(Array.isArray(agentResult.pipeline_events) ? agentResult.pipeline_events : []),
    ...(Array.isArray(riskAssessment.events) ? riskAssessment.events : [])
  ];
  const preValidationSafetyOverride = applyHardSafetyOverrides({
    agentResult: safeAgentResult,
    guard: conversationIntent
  });
  Object.assign(safeAgentResult, preValidationSafetyOverride.agentResult);
  pipelineEvents.push(...preValidationSafetyOverride.events);

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
  const conversationState = resolveConversationState({
    memory: baseMemory,
    activeAppointment,
    bookingIntent,
    informationQuestion: isInformationQuestion(messageText)
  });
  const postBookingSocialReply = hasConfirmedBooking
    ? buildPostBookingSocialReply({ messageText, appointmentRequest: activeAppointment, memory: nextMemory })
    : null;
  const missingBookingFields = getMissingAppointmentFields({ memory: nextMemory, payload });
  const workingHoursValidation = validateRequestedTimeAgainstWorkingHours({
    date: nextMemory.preferred_date,
    time: nextMemory.preferred_time,
    clinicConfig: config
  });
  if (bookingIntent) {
    pipelineEvents.push(...(workingHoursValidation.events || []));
  }
  const appointmentValidation = validateAppointmentCreation(safeAgentResult, nextMemory, {
    payload,
    messageText,
    bookingIntent,
    missingFields: missingBookingFields,
    conversationState,
    workingHoursValidation
  });
  const responseMissingBookingFields = bookingIntent ? appointmentValidation.missing_fields : [];
  const shouldCreateAppointmentRequest = appointmentValidation.allowed;
  let appointmentRequest = null;
  let slotConflict = null;

  if (bookingIntent && !appointmentValidation.allowed) {
    pipelineEvents.push({
      type: "create_appointment_blocked",
      reason: appointmentValidation.reason,
      missing_fields: appointmentValidation.missing_fields,
      downgraded_action: appointmentValidation.downgraded_action
    });

    if (appointmentValidation.missing_fields.length > 0) {
      pipelineEvents.push({
        type: "missing_required_booking_fields",
        reason: appointmentValidation.reason,
        missing_fields: appointmentValidation.missing_fields
      });
    }
  }

  if ((agentResult.action === "create_appointment" || agentResult.should_create_appointment_request) && !appointmentValidation.allowed) {
    pipelineEvents.push({
      type: "action_downgraded",
      from: "create_appointment",
      to: appointmentValidation.downgraded_action,
      reason: appointmentValidation.reason
    });
    pipelineEvents.push({
      type: "unsafe_action_downgraded",
      from: "create_appointment",
      to: appointmentValidation.downgraded_action,
      reason: appointmentValidation.reason
    });
    pipelineEvents.push({
      type: "accidental_booking_attempt",
      reason: appointmentValidation.reason,
      missing_fields: appointmentValidation.missing_fields
    });
    safeAgentResult.action = appointmentValidation.downgraded_action;
    safeAgentResult.should_create_appointment_request = false;
  }

  if (!safeAgentResult.should_handoff && shouldCreateAppointmentRequest) {
    const bookingResult = await upsertAppointmentRequest({
      conversationId: conversation.id,
      contactId: contact.id,
      payload,
      memory: nextMemory,
      confirm: shouldCreateAppointmentRequest,
      missingFields: appointmentValidation.missing_fields
    });
    appointmentRequest = bookingResult.appointmentRequest;
    slotConflict = bookingResult.slotConflict;
  }
  nextMemory.status = resolveNextConversationState({
    currentState: conversationState,
    bookingIntent,
    appointmentValidation,
    appointmentRequest,
    slotConflict,
    activeAppointment,
    informationQuestion: isInformationQuestion(messageText),
    agentResult: safeAgentResult
  });

  let finalReply = safeAgentResult.reply;
  let replySource = "agent";
  if (postBookingSocialReply) {
    finalReply = postBookingSocialReply;
    replySource = "post_booking_social";
  } else if (workingHoursValidation.valid === false && bookingIntent) {
    finalReply = buildOutsideWorkingHoursReply({ validation: workingHoursValidation, memory: nextMemory, messageText });
    replySource = "outside_working_hours";
  } else if (riskAssessment.risk_type === "price_objection") {
    finalReply = buildPriceObjectionReply({ messageText, memory: nextMemory, rounds: countRecentPriceObjections(recentMessages) + 1 });
    replySource = "price_objection";
  } else if (conversationIntent.intent === "pricing_question") {
    finalReply = buildDentalServiceInfoReply({ service: conversationIntent.service, serviceCategory: conversationIntent.service_category, messageText });
    replySource = "dental_service_info";
  } else if (slotConflict) {
    finalReply = buildSlotConflictReply({ memory: nextMemory, slotConflict, messageText });
    replySource = "slot_conflict";
  } else if (appointmentRequest && shouldCreateAppointmentRequest) {
    finalReply = buildBookingConfirmedReply({ appointmentRequest, memory: nextMemory, messageText });
    replySource = "booking_confirmed";
  } else if (conversationIntent.intent === "booking_request" && bookingIntent && !appointmentValidation.allowed) {
    finalReply = buildBookingProgressReply({ memory: nextMemory, payload, missingFields: appointmentValidation.missing_fields, messageText });
    replySource = "booking_progress";
  } else if (conversationIntent.intent === "booking_request" && isUnsafeDentalServiceReply(safeAgentResult.reply)) {
    finalReply = buildBookingProgressReply({ memory: nextMemory, payload, missingFields: appointmentValidation.missing_fields, messageText });
    replySource = "booking_progress";
  } else if (bookingIntent && shouldUseWorkflowProgressReply({
    agentReply: safeAgentResult.reply,
    missingFields: appointmentValidation.missing_fields,
    messageText
  })) {
    finalReply = buildBookingProgressReply({ memory: nextMemory, payload, missingFields: appointmentValidation.missing_fields, messageText });
    replySource = "booking_progress";
  } else if (!String(finalReply || "").trim()) {
    finalReply = buildClassifierGuidedReply({
      agentResult: safeAgentResult,
      memory: nextMemory,
      payload,
      messageText,
      appointmentValidation,
      bookingIntent
    });
    replySource = "reply_builder";
  }
  finalReply = sanitizeStaleBookingReply({
    reply: finalReply,
    messageText,
    memory: nextMemory,
    activeAppointment,
    bookingIntent
  });
  finalReply = softenInformationQuestionReply(finalReply, { messageText, bookingIntent });
  if (shouldHumanizeReplySource(replySource)) {
    const humanized = await humanizeReplyWithAI({
      safeReply: finalReply,
      userMessage: messageText,
      action: appointmentValidation.allowed ? "create_appointment" : appointmentValidation.downgraded_action,
      state: nextMemory.status
    });
    pipelineEvents.push(...humanized.events);
    finalReply = humanized.reply || finalReply;
  }
  finalReply = sanitizeReplyForUser(finalReply, { userMessage: messageText });
  finalReply = avoidRepeatedBotReply(finalReply, recentMessages);

  const recentOutgoingMessage = await prisma.message.findFirst({
    where: {
      conversationId: conversation.id,
      direction: "outgoing",
      createdAt: { gte: new Date(Date.now() - RESPONSE_DEBOUNCE_MS) }
    },
    orderBy: { createdAt: "desc" }
  });

  if (
    recentOutgoingMessage &&
    normalizeComparableMessage(recentOutgoingMessage.text) === normalizeComparableMessage(finalReply)
  ) {
    return buildSkippedResponse({
      reason: "duplicate_recent_outgoing_reply",
      contact,
      conversation,
      incomingMessage,
      externalMessageId
    });
  }

  const outgoingMessage = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      contactId: contact.id,
      direction: "outgoing",
      role: "assistant",
      text: finalReply,
      rawPayload: {
        ...safeAgentResult,
        memory_update: safeAgentResult.memory_update,
        reply: finalReply,
        deterministic_facts: deterministicFacts,
        risk: riskAssessment,
        appointment_validation: appointmentValidation,
        working_hours_validation: workingHoursValidation,
        pipeline_events: pipelineEvents,
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
      actionType: safeAgentResult.action || (safeAgentResult.should_handoff ? "handoff" : "answer"),
      reason: safeAgentResult.handoff_reason || safeAgentResult.intent || null,
      payload: {
        ...safeAgentResult,
        risk: riskAssessment,
        appointment_validation: appointmentValidation,
        working_hours_validation: workingHoursValidation,
        pipeline_events: pipelineEvents
      }
    }
  });

  await logPipelineEvents({ conversationId: conversation.id, events: pipelineEvents });

  if (safeAgentResult.should_handoff) {
    await prisma.handoff.create({
      data: {
        conversationId: conversation.id,
        contactId: contact.id,
        reason: safeAgentResult.handoff_reason || "agent_requested_handoff",
        status: "open"
      }
    });
    await takeOverConversation({
      conversationId: conversation.id,
      reason: safeAgentResult.handoff_reason || "agent_requested_handoff"
    });
  }

  return {
    reply: finalReply,
    intent: bookingIntent ? "book_appointment" : safeAgentResult.intent,
    urgency: safeAgentResult.urgency,
    should_handoff: safeAgentResult.should_handoff,
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
  } finally {
    await releaseProcessingLock(lockKey, lock.lockToken);
  }
}

async function buildPostClassifierGuard({
  guard,
  agentResult = {},
  messageText = "",
  recentMessages = [],
  activeAppointment = null,
  memory = {}
} = {}) {
  const contextualGreeting = isGreetingOnly(messageText) && shouldUseContextualGreeting({ recentMessages, activeAppointment, memory });

  if (!guard || (["message", "booking_request", "pricing_question"].includes(guard.intent) && !contextualGreeting)) {
    return null;
  }

  const classifierSummary = summarizeAgentOutput(agentResult);

  if (["cancel", "reschedule", "abuse", "noise"].includes(guard.intent)) {
    return {
      ...guard,
      classifier_output: classifierSummary,
      events: [
        ...(guard.events || []),
        {
          type: "hard_safety_guard_applied",
          guard_intent: guard.intent,
          classifier_intent: agentResult.intent || null,
          classifier_action: agentResult.action || null
        }
      ]
    };
  }

  if (guard.intent === "greeting" || contextualGreeting) {
    const afterReminder = activeAppointment
      ? await hasRecentSentReminder(activeAppointment.id)
      : false;

    return {
      intent: "greeting",
      action: "answer_question",
      state: afterReminder ? "appointment_booked" : "idle",
      shouldHandoff: false,
      classifier_output: classifierSummary,
      events: [
        { type: "contextual_first_reply", reason: afterReminder ? "after_reminder" : "greeting_only" },
        {
          type: "hard_safety_guard_applied",
          guard_intent: "greeting",
          classifier_intent: agentResult.intent || null,
          classifier_action: agentResult.action || null
        }
      ],
      afterReminder
    };
  }

  return null;
}

function summarizeAgentOutput(agentResult = {}) {
  return {
    intent: agentResult.intent || null,
    action: agentResult.action || null,
    safe_next_action: agentResult.safe_next_action || null,
    should_handoff: Boolean(agentResult.should_handoff),
    handoff_reason: agentResult.handoff_reason || null,
    urgency: agentResult.urgency || null,
    extracted: agentResult.extracted || {},
    memory_patch: agentResult.memory_patch || {}
  };
}

async function handleGuardedScriptedTurn({
  contact,
  conversation,
  incomingMessage,
  externalMessageId,
  payload,
  messageText,
  baseMemory,
  activeAppointment,
  guard
}) {
  const pipelineEvents = [...(guard.events || [])];
  let nextMemory = { ...(baseMemory || {}) };
  let actionType = guard.action || "answer_question";
  let shouldHandoff = Boolean(guard.shouldHandoff);
  let handoffReason = guard.reason || null;

  if (guard.intent === "cancel") {
    const clearResult = await clearPendingBooking({
      conversationId: conversation.id,
      contactId: contact.id,
      activeAppointment,
      needsAdminReview: guard.angry
    });
    pipelineEvents.push(...clearResult.events);
    nextMemory = {
      ...clearAppointmentDraft(nextMemory),
      status: guard.angry ? "handoff_required" : "cancellation_requested"
    };
    actionType = guard.angry ? "handoff_to_admin" : (clearResult.touchedAppointments > 0 ? "cancel_appointment" : "none");
    shouldHandoff = guard.angry || /зачем|почему|не просил|мы еще ничего не обговорили/iu.test(messageText);
    handoffReason = shouldHandoff ? "cancel_or_wrong_booking_complaint" : "cancel_intent_detected";
  } else if (guard.intent === "reschedule") {
    nextMemory = {
      ...nextMemory,
      status: "reschedule_requested"
    };
    actionType = activeAppointment ? "reschedule_appointment" : "collect_datetime";
  } else if (guard.intent === "greeting") {
    nextMemory.status = guard.state || "idle";
  } else if (guard.intent === "abuse") {
    nextMemory = {
      ...clearAppointmentDraft(nextMemory),
      status: "handoff_required"
    };
    actionType = "handoff_to_admin";
    shouldHandoff = true;
    handoffReason = guard.reason || "abuse_or_complaint";
  } else if (guard.intent === "handoff") {
    nextMemory = {
      ...clearAppointmentDraft(nextMemory),
      status: "handoff_required"
    };
    actionType = "handoff_to_admin";
    shouldHandoff = true;
    handoffReason = guard.reason || guard.risk?.risk_type || "high_risk_conversation";
  } else if (guard.intent === "noise") {
    actionType = "none";
    pipelineEvents.push({ type: "noise_ignored_without_state_change", previous_status: nextMemory.status || null });
  }

  const safeReply = buildSafeScriptedReply({
    intent: guard.intent,
    action: actionType,
    state: nextMemory.status,
    memory: nextMemory,
    payload,
    messageText,
    activeAppointment,
    afterReminder: guard.afterReminder,
    shouldHandoff
  });
  const humanized = await humanizeReplyWithAI({
    safeReply,
    userMessage: messageText,
    action: actionType,
    state: nextMemory.status
  });
  pipelineEvents.push(...humanized.events);
  const finalReply = avoidRepeatedBotReply(
    sanitizeReplyForUser(humanized.reply || safeReply, { userMessage: messageText }),
    await prisma.message.findMany({
      where: {
        conversationId: conversation.id,
        id: { not: incomingMessage.id }
      },
      orderBy: { createdAt: "desc" },
      take: 8
    })
  );

  const recentOutgoingMessage = await prisma.message.findFirst({
    where: {
      conversationId: conversation.id,
      direction: "outgoing",
      createdAt: { gte: new Date(Date.now() - RESPONSE_DEBOUNCE_MS) }
    },
    orderBy: { createdAt: "desc" }
  });

  if (
    recentOutgoingMessage &&
    normalizeComparableMessage(recentOutgoingMessage.text) === normalizeComparableMessage(finalReply)
  ) {
    return buildSkippedResponse({
      reason: "duplicate_recent_outgoing_reply",
      contact,
      conversation,
      incomingMessage,
      externalMessageId
    });
  }

  const outgoingMessage = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      contactId: contact.id,
      direction: "outgoing",
      role: "assistant",
      text: finalReply,
      rawPayload: {
        reply: finalReply,
        safe_reply: safeReply,
        guard,
        action: actionType,
        state: nextMemory.status,
        pipeline_events: pipelineEvents,
        reply_source: `${guard.intent}_guard`
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
      actionType,
      reason: handoffReason || guard.reason || guard.intent,
      payload: {
        guard,
        state: nextMemory.status,
        safe_reply: safeReply,
        reply: finalReply,
        pipeline_events: pipelineEvents
      }
    }
  });

  await logPipelineEvents({ conversationId: conversation.id, events: pipelineEvents });

  if (shouldHandoff) {
    await prisma.handoff.create({
      data: {
        conversationId: conversation.id,
        contactId: contact.id,
        reason: handoffReason || "guard_requested_handoff",
        status: "open"
      }
    });
    await takeOverConversation({
      conversationId: conversation.id,
      reason: handoffReason || "guard_requested_handoff"
    });
  }

  return {
    reply: finalReply,
    intent: guard.intent,
    action: actionType,
    urgency: guard.angry ? "medium" : "low",
    should_handoff: shouldHandoff,
    should_create_appointment_request: false,
    slot_conflict: null,
    missing_booking_fields: [],
    contact_id: contact.id,
    conversation_id: conversation.id,
    incoming_message_id: incomingMessage.id,
    outgoing_message_id: outgoingMessage.id,
    appointment_request_id: null,
    memory: nextMemory
  };
}

async function clearPendingBooking({ conversationId, contactId, activeAppointment = null, needsAdminReview = false }) {
  const targetStatus = needsAdminReview ? "needs_admin_review" : "cancelled";
  const appointments = await prisma.appointmentRequest.findMany({
    where: {
      conversationId,
      contactId,
      status: { in: ["new", "pending", "collecting", "waiting_confirmation", "confirmed"] }
    },
    select: { id: true, status: true }
  });

  const appointmentIds = appointments.map((appointment) => appointment.id);
  if (activeAppointment?.id && !appointmentIds.includes(activeAppointment.id)) {
    appointmentIds.push(activeAppointment.id);
  }

  if (appointmentIds.length > 0) {
    await prisma.appointmentRequest.updateMany({
      where: { id: { in: appointmentIds } },
      data: {
        status: targetStatus,
        updatedAt: new Date()
      }
    });

    await prisma.appointmentReminder.updateMany({
      where: {
        appointmentRequestId: { in: appointmentIds },
        status: "pending"
      },
      data: {
        status: "cancelled",
        error: needsAdminReview ? "appointment_needs_admin_review" : "appointment_cancelled",
        updatedAt: new Date()
      }
    });
  }

  const events = [
    { type: "cancel_intent_detected", reason: needsAdminReview ? "complaint_or_aggression" : "user_cancelled" },
    { type: "pending_booking_cleared", appointment_ids: appointmentIds },
    ...(needsAdminReview ? [{ type: "appointment_needs_admin_review", appointment_ids: appointmentIds }] : [])
  ];

  return {
    touchedAppointments: appointmentIds.length,
    events
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

export function detectConversationIntent(text = "") {
  const lower = String(text || "").toLowerCase();
  const dentalService = detectDentalServiceIntent(lower);
  const explicitCancel = detectExplicitAppointmentCancel(lower);
  const ambiguousDelete = detectAmbiguousDeleteIntent(lower, dentalService, explicitCancel);
  const angry = isAngryOrComplaint(lower);

  if (ambiguousDelete.detected) {
    return {
      intent: "abuse",
      action: "handoff_to_admin",
      state: "handoff_required",
      shouldHandoff: true,
      angry: true,
      reason: "ambiguous_delete_intent",
      service: dentalService.service,
      service_category: dentalService.service_category,
      events: [
        { type: "dental_service_detected", service: dentalService.service, service_category: dentalService.service_category },
        { type: "ambiguous_delete_intent", reason: ambiguousDelete.reason },
        { type: "unsafe_action_downgraded", from: "cancel_or_booking", to: "handoff_to_admin", reason: "ambiguous_delete_intent" }
      ]
    };
  }

  if (explicitCancel.detected) {
    return {
      intent: "cancel",
      action: angry ? "handoff_to_admin" : "cancel_appointment",
      state: angry ? "handoff_required" : "cancellation_requested",
      shouldHandoff: angry || /(зачем\s+вы\s+меня\s+записали|я\s+не\s+просил|я\s+не\s+просила|мы\s+ещ[её]\s+ничего\s+не\s+обговорили)/iu.test(lower),
      angry,
      reason: angry ? "angry_cancel_or_wrong_booking" : explicitCancel.reason,
      events: [
        { type: "delete_word_disambiguated_as_cancel", reason: explicitCancel.reason },
        { type: "cancel_intent_detected", reason: angry ? "angry_or_complaint" : explicitCancel.reason },
        { type: "unsafe_action_downgraded", from: "create_appointment", to: angry ? "handoff_to_admin" : "cancel_appointment", reason: "cancel_priority" }
      ]
    };
  }

  if (dentalService.detected) {
    const pricing = isInformationQuestion(lower);
    return {
      intent: pricing ? "pricing_question" : "booking_request",
      sub_intent: dentalService.sub_intent,
      action: pricing ? "provide_info" : "collect_datetime",
      state: pricing ? "answering_question" : "collecting_booking_data",
      shouldHandoff: false,
      angry: false,
      confidence: dentalService.confidence,
      service: dentalService.service,
      service_category: dentalService.service_category,
      extracted: {
        service: dentalService.service,
        service_category: dentalService.service_category,
        relative_date: lower.includes("послезавтра") ? "day_after_tomorrow" : (lower.includes("завтра") ? "tomorrow" : null),
        appointment_reference: "none"
      },
      safe_next_action: pricing ? "provide_info" : (normalizeAppointmentTime(lower) ? "collect_date" : "collect_time"),
      reason: dentalService.reason,
      events: [
        { type: "dental_service_detected", service: dentalService.service, service_category: dentalService.service_category },
        { type: "delete_word_disambiguated_as_service", reason: dentalService.reason }
      ]
    };
  }

  const abuse = detectComplaintOrAbuse(lower);
  if (abuse.detected) {
    return {
      intent: "abuse",
      action: "handoff_to_admin",
      state: "handoff_required",
      shouldHandoff: true,
      angry: true,
      reason: abuse.reason,
      events: [
        { type: "abuse_or_complaint_detected", reason: abuse.reason },
        { type: "unsafe_action_downgraded", from: "dialogue", to: "handoff_to_admin", reason: abuse.reason }
      ]
    };
  }

  const noise = detectNoiseMessage(lower);
  if (noise.detected) {
    return {
      intent: "noise",
      action: "none",
      state: "idle",
      shouldHandoff: false,
      angry: false,
      reason: noise.reason,
      events: [{ type: "noise_detected", reason: noise.reason }]
    };
  }

  const reschedule = /(перенести|перенесите|перезаписаться|перезапишите|другое\s+время|другой\s+день|можно\s+на\s+другое\s+время)/iu.test(lower);
  if (reschedule) {
    return {
      intent: "reschedule",
      action: "reschedule_appointment",
      state: "reschedule_requested",
      shouldHandoff: false,
      angry: false,
      reason: "reschedule_intent_detected",
      events: [{ type: "reschedule_intent_detected" }]
    };
  }

  return {
    intent: "message",
    action: "none",
    state: "idle",
    shouldHandoff: false,
    angry: false,
    events: []
  };
}

export function classifyConversationRisk({ userMessage = "", agentOutput = {}, context = {} } = {}) {
  const text = String(userMessage || "").toLowerCase();
  const recentMessages = context.recentMessages || [];
  const rules = config.handoffRules || {};
  const events = [{ type: "risk_classified", source: "hard_guard" }];

  const result = {
    risk_level: "low",
    risk_type: "none",
    should_handoff: false,
    reason: "no_risk",
    events
  };

  const setRisk = ({ level, type, shouldHandoff, reason, event }) => {
    result.risk_level = level;
    result.risk_type = type;
    result.should_handoff = Boolean(shouldHandoff);
    result.reason = reason;
    if (event) events.push(event);
    return result;
  };

  if (detectWrongBookingComplaint(text)) {
    return setRisk({
      level: "high",
      type: "wrong_booking_complaint",
      shouldHandoff: rules.handoff_on_wrong_booking_complaint !== false,
      reason: "wrong_booking_complaint",
      event: { type: "wrong_booking_complaint_detected" }
    });
  }

  if (detectLegalThreat(text)) {
    return setRisk({
      level: "high",
      type: "legal_threat",
      shouldHandoff: rules.handoff_on_legal_threat !== false,
      reason: "legal_threat",
      event: { type: "legal_threat_detected" }
    });
  }

  if (detectBadReviewThreat(text)) {
    return setRisk({
      level: "high",
      type: "bad_review_threat",
      shouldHandoff: rules.handoff_on_bad_review_threat !== false,
      reason: "bad_review_threat",
      event: { type: "bad_review_threat_detected" }
    });
  }

  if (detectReputationRisk(text)) {
    return setRisk({
      level: "high",
      type: "reputation_risk",
      shouldHandoff: rules.handoff_on_reputation_risk !== false,
      reason: "reputation_risk",
      event: { type: "reputation_risk_detected" }
    });
  }

  if (detectAggressionWithComplaint(text)) {
    return setRisk({
      level: "high",
      type: "aggression",
      shouldHandoff: rules.handoff_on_aggression !== false,
      reason: "aggression_with_complaint",
      event: { type: "aggression_with_complaint_detected" }
    });
  }

  if (detectMedicalRisk(text)) {
    return setRisk({
      level: "high",
      type: "medical_risk",
      shouldHandoff: rules.handoff_on_medical_risk !== false || agentOutput.should_handoff,
      reason: "medical_risk",
      event: { type: "medical_risk_detected" }
    });
  }

  if (detectDiscountRequest(text)) {
    return setRisk({
      level: "medium",
      type: "discount_request",
      shouldHandoff: rules.handoff_on_discount_request === true,
      reason: "discount_request",
      event: { type: "discount_request_detected" }
    });
  }

  if (detectPriceObjection(text)) {
    const rounds = countRecentPriceObjections(recentMessages) + 1;
    const threshold = Number(rules.price_objection_rounds_before_handoff || 2);
    const shouldHandoff = rounds >= threshold;
    events.push({ type: "price_objection_detected", rounds, threshold });
    if (shouldHandoff) {
      events.push({ type: "price_objection_handoff_threshold_reached", rounds, threshold });
    }
    return setRisk({
      level: shouldHandoff ? "medium" : "low",
      type: "price_objection",
      shouldHandoff,
      reason: shouldHandoff ? "price_objection_threshold_reached" : "price_objection"
    });
  }

  return result;
}

function buildRiskGuard(risk = {}) {
  if (!risk.should_handoff) return null;

  return {
    intent: "handoff",
    action: "handoff_to_admin",
    state: "handoff_required",
    shouldHandoff: true,
    angry: ["aggression", "wrong_booking_complaint"].includes(risk.risk_type),
    reason: risk.reason || risk.risk_type || "high_risk_conversation",
    risk,
    events: [
      ...(risk.events || []),
      { type: "handoff_created_high_risk", risk_type: risk.risk_type, risk_level: risk.risk_level },
      { type: "ai_disabled_after_handoff", reason: risk.reason || risk.risk_type }
    ]
  };
}

function detectPriceObjection(text = "") {
  return /(дорог|дорого|конск.{0,10}цен|почему\s+так\s+дорого|у\s+других\s+дешевле|в\s+другой\s+клинике\s+дешевле|дешевле|за\s*\d{3,6}\s*(?:руб|р|₽)?\s*(?:сделаете|можно|будет)|скиньте\s+цену)/iu.test(text);
}

function detectDiscountRequest(text = "") {
  return /(скидк|скиньте|торг|дешевле\s+сдела|можно\s+подешевле|за\s*\d{3,6}\s*(?:руб|р|₽)?\s*(?:сделаете|можно|будет))/iu.test(text);
}

function detectBadReviewThreat(text = "") {
  return /(отзыв|отзовик|яндекс|2гис|google|гугл).{0,40}(плох|негатив|напиш|остав|жалоб)|напишу.{0,40}(плох|негатив).{0,40}отзыв/iu.test(text);
}

function detectReputationRisk(text = "") {
  return /(всем\s+расскаж|везде\s+напиш|опозор|репутац|разнесу|в\s+соцсет|в\s+инст|в\s+телеграм|в\s+групп)/iu.test(text);
}

function detectLegalThreat(text = "") {
  return /(суд|юрист|адвокат|прокуратур|роспотреб|минздрав|иск|заявлени[ея]\s+на\s+вас|буду\s+жаловаться)/iu.test(text);
}

function detectWrongBookingComplaint(text = "") {
  return /(зачем\s+вы\s+меня\s+записал|я\s+не\s+просил|я\s+не\s+просила|без\s+моего\s+подтверждения|мы\s+еще\s+ничего\s+не\s+обговорили|мы\s+ещё\s+ничего\s+не\s+обговорили|я\s+не\s+подтверждал|я\s+не\s+подтверждала)/iu.test(text);
}

function detectAggressionWithComplaint(text = "") {
  const aggressive = /(ебан|ебл|нах|хуй|пизд|бля|сука|охуел|охуели|урод|долбо|туп)/iu.test(text);
  const complaint = /(запис|цена|дорог|почему|что\s+за|вы\s+что|вы\s+чо|не\s+просил|не\s+надо|отмен|удалите\s+запись)/iu.test(text);
  return aggressive && complaint;
}

function detectMedicalRisk(text = "") {
  return /(отек|отёк|температур|кровотеч|кровь\s+не\s+останавливается|травм|сильн.{0,20}бол|дышать\s+тяжело|глотать\s+тяжело|гной|инфекц|после\s+операц)/iu.test(text);
}

function countRecentPriceObjections(messages = []) {
  return messages.filter((message) => message.direction === "incoming" && detectPriceObjection(message.text || "")).length;
}

export function detectDentalServiceIntent(text = "") {
  const lower = String(text || "").toLowerCase();
  const wisdom = /(удал(?:ить|ите|ение|ен[а-я]*)|вырвать|вырывать).{0,40}(зуб(?:а|ы)?\s+мудрости|мудрости|восьм[её]рк[ауи]?)|(зуб(?:а|ы)?\s+мудрости|восьм[её]рк[ауи]?).{0,40}(удал(?:ить|ите|ение|ен[а-я]*)|вырвать|вырывать)/iu.test(lower);
  if (wisdom) {
    return {
      detected: true,
      confidence: 0.98,
      service: "удаление зуба мудрости",
      service_category: "wisdom_tooth_extraction",
      sub_intent: "dental_service_request",
      reason: "delete_word_near_wisdom_tooth"
    };
  }

  const extraction = /(удал(?:ить|ите|ение|ен[а-я]*)|вырвать|вырывать).{0,40}(зуб|зуба|зубы|корень|нерв)|(зуб|зуба|зубы|корень|нерв).{0,40}(удал(?:ить|ите|ение|ен[а-я]*)|вырвать|вырывать)/iu.test(lower);
  if (extraction) {
    return {
      detected: true,
      confidence: 0.94,
      service: "удаление зуба",
      service_category: "tooth_extraction",
      sub_intent: "dental_service_request",
      reason: "delete_word_near_tooth_entity"
    };
  }

  return { detected: false, confidence: 0, service: null, service_category: null, sub_intent: null, reason: null };
}

export function detectExplicitAppointmentCancel(text = "") {
  const lower = String(text || "").toLowerCase();

  if (/(отменить|отмени|отмените).{0,30}(запис|при[её]м|визит|бронь)|(запис|при[её]м|визит|бронь).{0,30}(отменить|отмени|отмените)/iu.test(lower)) {
    return { detected: true, reason: "explicit_cancel_appointment_reference" };
  }

  if (/(удалить|удалите|убрать|уберите).{0,30}(запис|при[её]м|визит|бронь)|(запис|при[её]м|визит|бронь).{0,30}(удалить|удалите|убрать|уберите)/iu.test(lower)) {
    return { detected: true, reason: "explicit_delete_appointment_reference" };
  }

  if (/(не\s+надо|не\s+нужно|денег\s+нет|передумал|передумала|не\s+приду|не\s+актуально|зачем\s+вы\s+меня\s+записали|мы\s+еще\s+ничего\s+не\s+обговорили|мы\s+ещё\s+ничего\s+не\s+обговорили|я\s+не\s+просил|я\s+не\s+просила|запись\s+не\s+нужна)/iu.test(lower)) {
    return { detected: true, reason: "cancel_context_without_delete_word" };
  }

  return { detected: false, reason: null };
}

export function detectAmbiguousDeleteIntent(text = "", dentalService = detectDentalServiceIntent(text), explicitCancel = detectExplicitAppointmentCancel(text)) {
  const lower = String(text || "").toLowerCase();
  if (!dentalService.detected || !explicitCancel.detected) return { detected: false, reason: null };
  if (/(запис|при[её]м|визит|бронь|не\s+нужна|не\s+надо|отмен)/iu.test(lower)) {
    return { detected: true, reason: "dental_service_and_cancel_reference" };
  }
  return { detected: false, reason: null };
}

function isAngryOrComplaint(text = "") {
  return /(ебан|нах|хуй|пизд|бля|вы\s+что|почему\s+записали|зачем\s+вы\s+меня\s+записали|я\s+не\s+просил|я\s+не\s+просила|мы\s+ещ[её]\s+ничего\s+не\s+обговорили)/iu.test(String(text || ""));
}

export function detectComplaintOrAbuse(text = "") {
  const lower = String(text || "").toLowerCase();
  if (/(зачем\s+вы\s+меня\s+записали|почему\s+записали|я\s+не\s+просил|я\s+не\s+просила|без\s+моего\s+соглас|вы\s+что)/iu.test(lower)) {
    return { detected: true, reason: "wrong_booking_complaint" };
  }

  if (/(вы\s+ч[еёо]\s+ебан|вы\s+ебан|ебланы|долбо[её]б|нахуй|пошли\s+нах|хуйня|пиздец|блять|блядь)/iu.test(lower)) {
    return { detected: true, reason: "angry_abuse" };
  }

  return { detected: false, reason: null };
}

export function detectNoiseMessage(text = "") {
  const normalized = String(text || "").replace(/\s+/gu, " ").trim();
  const compact = normalized.replace(/[?!.,\s]/gu, "");
  if (!normalized || !compact) return { detected: true, reason: "empty_or_punctuation" };
  if (/^[?!.]{3,}$/u.test(normalized)) return { detected: true, reason: "punctuation_noise" };
  if (/^(бля|блин|нах|хуй|пизд|еба|ёба|минетик|минет)$/iu.test(compact)) {
    return { detected: true, reason: "rude_noise" };
  }
  if (compact.length <= 2 && !/[а-яёa-z0-9]/iu.test(compact)) {
    return { detected: true, reason: "symbol_noise" };
  }
  return { detected: false, reason: null };
}

function clearAppointmentDraft(memory = {}) {
  const cleaned = clearStaleBookingMemory(memory);
  delete cleaned.status;
  return cleaned;
}

export function resolveConversationState({
  memory = {},
  activeAppointment = null,
  bookingIntent = false,
  informationQuestion = false
} = {}) {
  if (CONVERSATION_STATES.has(memory.status)) return memory.status;
  if (activeAppointment?.status === "confirmed") return "appointment_booked";
  if (activeAppointment?.status === "waiting_confirmation") return "waiting_booking_confirmation";
  if (isDraftAppointmentStatus(activeAppointment?.status)) return "collecting_booking_data";
  if (bookingIntent) return "collecting_booking_data";
  if (informationQuestion) return "answering_question";
  return "idle";
}

function resolveNextConversationState({
  currentState = "idle",
  bookingIntent = false,
  appointmentValidation = {},
  appointmentRequest = null,
  slotConflict = null,
  activeAppointment = null,
  informationQuestion = false,
  agentResult = {}
} = {}) {
  if (currentState === "cancellation_requested" || currentState === "handoff_required" || currentState === "human_takeover") return currentState;
  if (agentResult.should_handoff) return "handoff_required";
  if (slotConflict) return "collecting_booking_data";
  if (appointmentRequest?.status === "confirmed" || appointmentValidation.allowed) return "appointment_booked";
  if (activeAppointment?.status === "confirmed") return "appointment_booked";
  if (bookingIntent && appointmentValidation?.missing_fields?.length === 1 && appointmentValidation.missing_fields.includes("consent_to_book")) {
    return "waiting_booking_confirmation";
  }
  if (bookingIntent) return "collecting_booking_data";
  if (informationQuestion) return "answering_question";
  return "idle";
}

export function buildSafeScriptedReply({
  intent = "message",
  action = "none",
  state = "idle",
  memory = {},
  payload = {},
  messageText = "",
  activeAppointment = null,
  afterReminder = false,
  shouldHandoff = false
} = {}) {
  const name = shortName(memory.patient_name || payload.display_name || "");
  const prefix = name ? `${name}, ` : "";

  if (intent === "cancel") {
    if (shouldHandoff) {
      return "Вы правы, без подтверждения запись создавать нельзя. Я остановлю автоматические действия и передам администратору.";
    }

    if (activeAppointment?.status === "confirmed") {
      return `${prefix}поняла, автоматические действия по записи остановлю. Передам администратору, чтобы отмену проверили.`;
    }

    return `${prefix}поняла, запись создавать или подтверждать не буду. Передам администратору, чтобы всё проверили.`;
  }

  if (intent === "reschedule") {
    if (activeAppointment?.status === "confirmed") {
      return `${prefix}поняла, можно перенести. Напишите новый удобный день и время, я проверю вариант.`;
    }

    return `${prefix}напишите удобный день и время, а администратор проверит, можно ли так записать.`;
  }

  if (intent === "greeting") {
    if (afterReminder || state === "appointment_booked") {
      return `${prefix}здравствуйте! Вижу, у вас была запись или напоминание. Хотите уточнить детали или изменить время?`;
    }

    if (memory.requested_service) {
      return `${prefix}здравствуйте! Подскажу по ${memory.requested_service} и свободному времени для записи.`;
    }

    return `${prefix}здравствуйте! Подскажите, что хотите уточнить по лечению, стоимости или записи?`;
  }

  if (intent === "handoff") {
    if (/зачем|не\s+просил|без\s+подтверждения|записал/iu.test(messageText)) {
      return "Вы правы, без подтверждения запись создавать нельзя. Я остановлю автоматические действия и передам администратору.";
    }

    if (/отзыв|суд|юрист|прокуратур|роспотреб|минздрав|жалоб|репутац|всем\s+расскаж/iu.test(messageText)) {
      return "Понимаю, вопрос важный. Я остановлю автоматические ответы и передам администратору, чтобы он разобрался лично.";
    }

    if (/дорог|дешевле|скидк|подешевле|торг/iu.test(messageText)) {
      return "Понимаю вопрос по стоимости. Передам администратору, чтобы он проверил возможные варианты и ответил точнее.";
    }

    return "Понимаю, ситуация требует внимания. Я остановлю автоматические действия и передам администратору, чтобы всё проверили.";
  }

  if (intent === "abuse") {
    if (activeAppointment?.status === "confirmed" || state === "handoff_required") {
      return "Понимаю, ситуация неприятная. Автоматические действия остановлю и передам администратору, чтобы всё проверили.";
    }

    return "Понимаю, что сообщение эмоциональное. Передам администратору, чтобы он проверил ситуацию и ответил по делу.";
  }

  if (intent === "noise") {
    return pickNoiseReply(messageText);
  }

  return "Подскажите, пожалуйста, что хотите уточнить по услугам, стоимости или записи.";
}

function pickNoiseReply(messageText = "") {
  const replies = [
    "Не совсем понял сообщение. Могу помочь с услугами, стоимостью или записью.",
    "Не разобрала, что нужно уточнить. Напишите, пожалуйста, про лечение, цену или запись.",
    "Похоже, сообщение пришло не полностью. Напишите чуть подробнее, и я помогу.",
    "Не совсем поняла. Если вопрос по стоматологии или записи, напишите его чуть подробнее."
  ];
  const hash = [...String(messageText || "")].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return replies[hash % replies.length];
}

function buildDentalServiceInfoReply({ service = "", serviceCategory = "", messageText = "" } = {}) {
  if (serviceCategory === "wisdom_tooth_extraction") {
    return "Удаление зуба мудрости зависит от сложности и положения зуба. Могу сориентировать по диапазону или передать администратору для точной стоимости.";
  }

  if (serviceCategory === "tooth_extraction") {
    return "Удаление зуба по стоимости зависит от сложности. Подскажите, какой зуб беспокоит, и я сориентирую по записи или передам вопрос администратору.";
  }

  return `${service || "Услуга"} зависит от ситуации после осмотра. Могу подсказать по записи или передать вопрос администратору.`;
}

function buildPriceObjectionReply({ messageText = "", memory = {}, rounds = 1 } = {}) {
  const service = memory.requested_service || memory.complaint || "";

  if (/за\s*\d{3,6}/iu.test(messageText) || /скидк|подешевле|торг|скиньте/iu.test(messageText)) {
    return service
      ? `По ${service} цену лучше не обещать наугад: она зависит от объема и сложности. Могу передать администратору, чтобы он проверил, есть ли подходящие варианты по стоимости.`
      : "По скидкам и точной стоимости лучше проверит администратор. Могу передать ему вопрос, чтобы он сориентировал по возможным вариантам.";
  }

  if (rounds > 1) {
    return "Понимаю, что стоимость важна. Цена зависит от объема лечения и материалов, поэтому точнее сориентирует администратор или врач после уточнения ситуации.";
  }

  return service
    ? `По ${service} стоимость зависит от сложности случая и объема лечения. Могу сориентировать по прайсу или передать администратору для точного расчета.`
    : "Понимаю вопрос по цене. Стоимость зависит от услуги и объема лечения, поэтому могу сориентировать по прайсу или передать администратору для точного ответа.";
}

function buildOutsideWorkingHoursReply({ validation = {}, memory = {}, messageText = "" } = {}) {
  const casual = isCasualMessage(messageText);
  const date = validation.date ? formatBookingDateForReply(validation.date) : null;
  const time = validation.time || memory.preferred_time || "";

  if (validation.reason === "clinic_closed") {
    return casual
      ? `В этот день клиника не работает. Киньте другой день и время, проверю вариант.`
      : `В выбранный день клиника не работает. Подскажите, пожалуйста, другой день и удобное время.`;
  }

  const windowText = validation.open && validation.close
    ? `Рабочее время в этот день: ${validation.open}-${validation.close}.`
    : "Запись доступна в рабочее время клиники.";

  return casual
    ? `${time ? `На ${time}` : "На это время"} не получится, это вне рабочего времени. ${windowText} Напишите другое время, проверю.`
    : `${date && time ? `На ${date} в ${time}` : "На выбранное время"} записать не получится: это вне рабочего времени клиники. ${windowText} Подскажите другое удобное время.`;
}

export function applyHardSafetyOverrides({ agentResult = {}, guard = {}, appointmentValidation = {} } = {}) {
  const safeAgentResult = {
    ...agentResult,
    memory_update: { ...(agentResult.memory_update || {}) },
    memory_patch: { ...(agentResult.memory_patch || {}) }
  };
  const events = [];

  if (guard.intent === "booking_request" && isUnsafeDentalServiceAction(safeAgentResult)) {
    const downgradedAction = appointmentValidation.downgraded_action || guard.safe_next_action || "collect_datetime";
    events.push({
      type: "unsafe_action_downgraded",
      from: safeAgentResult.action || safeAgentResult.intent,
      to: downgradedAction,
      reason: "dental_service_not_cancel"
    });
    events.push({
      type: "delete_word_disambiguated_as_service",
      service: guard.service || guard.extracted?.service || null,
      service_category: guard.service_category || guard.extracted?.service_category || null
    });

    safeAgentResult.intent = "booking";
    safeAgentResult.action = downgradedAction;
    safeAgentResult.safe_next_action = downgradedAction;
    safeAgentResult.should_handoff = false;
    safeAgentResult.handoff_reason = null;
    safeAgentResult.should_create_appointment_request = false;
    safeAgentResult.memory_update.status = "collecting_booking_data";
    safeAgentResult.memory_patch.status = "collecting_booking_data";
  }

  if (guard.intent === "cancel" && safeAgentResult.action === "create_appointment") {
    const downgradedAction = guard.shouldHandoff ? "handoff_to_admin" : "cancel_appointment";
    events.push({
      type: "unsafe_action_downgraded",
      from: "create_appointment",
      to: downgradedAction,
      reason: "cancel_priority"
    });
    safeAgentResult.action = downgradedAction;
    safeAgentResult.safe_next_action = downgradedAction;
    safeAgentResult.should_create_appointment_request = false;
    safeAgentResult.memory_update.status = guard.state || "cancellation_requested";
    safeAgentResult.memory_patch.status = guard.state || "cancellation_requested";
  }

  return { agentResult: safeAgentResult, events };
}

function isUnsafeDentalServiceAction(result = {}) {
  return result.intent === "cancel" ||
    result.action === "cancel_appointment" ||
    result.action === "handoff_to_admin" ||
    result.memory_update?.status === "cancellation_requested" ||
    result.memory_patch?.status === "cancellation_requested";
}

function isUnsafeDentalServiceReply(reply = "") {
  return /(отмен(ил|ю|ять|а|им)|удал(ил|ю|ять).{0,30}(запис|при[её]м|визит|бронь)|передам.{0,50}отмен|запис[ьи].{0,30}не\s+буду|автоматические\s+действия\s+останов)/iu.test(String(reply || ""));
}

function isGreetingOnly(text = "") {
  return /^(здравствуйте|здравствуй|добрый\s+день|добрый\s+вечер|доброе\s+утро|привет|дратути)[!.?\s]*$/iu.test(String(text || "").trim());
}

function shouldUseContextualGreeting({ recentMessages = [], activeAppointment = null, memory = {} } = {}) {
  if (activeAppointment) return true;
  if (memory?.status === "appointment_booked") return true;
  return recentMessages.length === 0;
}

async function hasRecentSentReminder(appointmentRequestId) {
  if (!appointmentRequestId) return false;
  const reminder = await prisma.appointmentReminder.findFirst({
    where: {
      appointmentRequestId,
      status: "sent",
      sentAt: { gte: new Date(Date.now() - 48 * 60 * 60 * 1000) }
    },
    orderBy: { sentAt: "desc" }
  });
  return Boolean(reminder);
}

function shouldHumanizeReplySource(replySource = "") {
  if (!config.humanizerEnabled) return false;
  if (!config.humanizerOnlyForComplex) {
    return new Set([
      "booking_progress",
      "booking_confirmed",
      "slot_conflict",
      "post_booking_social",
      "dental_service_info",
      "outside_working_hours",
      "price_objection",
      "reply_builder"
    ]).has(replySource);
  }

  return new Set([
    "slot_conflict",
    "dental_service_info",
    "outside_working_hours",
    "price_objection",
    "reply_builder"
  ]).has(replySource);
}

function isClassifierBookingSignal(agentResult = {}) {
  if (agentResult.classifier_intent !== "booking_request" && agentResult.intent !== "booking") return false;
  if (agentResult.flags?.is_cancel_appointment) return false;
  if (["cancel_appointment", "handoff_to_admin"].includes(agentResult.action)) return false;
  return true;
}

function buildClassifierGuidedReply({
  agentResult = {},
  memory = {},
  payload = {},
  messageText = "",
  appointmentValidation = {},
  bookingIntent = false
} = {}) {
  const classifierIntent = agentResult.classifier_intent || agentResult.intent || "unknown";
  const extracted = agentResult.extracted || {};

  if (agentResult.should_handoff || agentResult.action === "handoff_to_admin") {
    return buildSafeScriptedReply({
      intent: "handoff",
      action: "handoff_to_admin",
      state: "handoff_required",
      memory,
      payload,
      messageText,
      shouldHandoff: true
    });
  }

  if (classifierIntent === "noise") {
    return buildSafeScriptedReply({ intent: "noise", memory, payload, messageText });
  }

  if (classifierIntent === "greeting") {
    return buildSafeScriptedReply({ intent: "greeting", state: memory.status || "idle", memory, payload, messageText });
  }

  if (bookingIntent || classifierIntent === "booking_request") {
    const missingFields = appointmentValidation.missing_fields?.length
      ? appointmentValidation.missing_fields
      : getMissingAppointmentFields({ memory, payload });
    return buildBookingProgressReply({ memory, payload, missingFields, messageText });
  }

  if (classifierIntent === "pricing_question") {
    return buildDentalServiceInfoReply({
      service: extracted.service || memory.requested_service,
      serviceCategory: extracted.service_category,
      messageText
    });
  }

  if (classifierIntent === "doctor_question") {
    return "По врачам сориентирую: в клинике принимают стоматологи по разным направлениям. Напишите, какая услуга нужна, и я подскажу, кого лучше уточнить у администратора.";
  }

  if (classifierIntent === "service_question") {
    return buildDentalServiceInfoReply({
      service: extracted.service || memory.requested_service,
      serviceCategory: extracted.service_category,
      messageText
    });
  }

  if (classifierIntent === "medical_question") {
    return "По симптомам лучше не ставить диагноз в переписке. Опишите, что беспокоит и как давно, а при сильной боли, отеке, температуре или кровотечении лучше связаться с клиникой как можно быстрее.";
  }

  return "Напишите, пожалуйста, что хотите уточнить по лечению, стоимости или записи.";
}

export function validateRequestedTimeAgainstWorkingHours({ date, relative_date, time, clinicConfig = config } = {}) {
  const preferredDate = normalizeAppointmentDate(date || relative_date);
  const preferredTime = normalizeAppointmentTime(time);

  if (!preferredDate || !preferredTime) {
    return {
      valid: true,
      applicable: false,
      reason: "missing_date_or_time",
      events: []
    };
  }

  const workingHours = clinicConfig.workingHours || {};
  const timezone = workingHours.timezone || clinicConfig.reminderTimezone || "Europe/Moscow";
  const dayKey = weekdayKey(preferredDate, timezone);
  const dayConfig = workingHours.days?.[dayKey] ?? null;

  if (!dayConfig || dayConfig.closed === true) {
    return {
      valid: false,
      applicable: true,
      reason: "clinic_closed",
      day: dayKey,
      date: toBookingIsoDate(preferredDate),
      time: preferredTime,
      events: [
        { type: "time_outside_working_hours", reason: "clinic_closed", day: dayKey, date: toBookingIsoDate(preferredDate), time: preferredTime },
        { type: "action_downgraded_outside_hours", to: "collect_datetime", reason: "clinic_closed" }
      ]
    };
  }

  const requestedMinutes = minutesFromTime(preferredTime);
  const openMinutes = minutesFromTime(dayConfig.open || "09:00");
  const closeMinutes = minutesFromTime(dayConfig.close || "20:00");
  const valid = requestedMinutes >= openMinutes && requestedMinutes < closeMinutes;

  if (!valid) {
    return {
      valid: false,
      applicable: true,
      reason: "outside_working_hours",
      day: dayKey,
      date: toBookingIsoDate(preferredDate),
      time: preferredTime,
      open: dayConfig.open,
      close: dayConfig.close,
      events: [
        {
          type: "time_outside_working_hours",
          reason: "outside_working_hours",
          day: dayKey,
          date: toBookingIsoDate(preferredDate),
          time: preferredTime,
          open: dayConfig.open,
          close: dayConfig.close
        },
        { type: "action_downgraded_outside_hours", to: "collect_datetime", reason: "outside_working_hours" }
      ]
    };
  }

  return {
    valid: true,
    applicable: true,
    reason: null,
    day: dayKey,
    date: toBookingIsoDate(preferredDate),
    time: preferredTime,
    open: dayConfig.open,
    close: dayConfig.close,
    events: [
      {
        type: "working_hours_validation_passed",
        day: dayKey,
        date: toBookingIsoDate(preferredDate),
        time: preferredTime
      }
    ]
  };
}

export function validateAppointmentCreation(output = {}, memory = {}, context = {}) {
  const messageText = context.messageText || "";
  const missingFields = [...new Set(context.missingFields || [])];
  const explicitConfirmation = hasExplicitBookingConfirmation(messageText) || memory.consent_to_book === true;
  const effectiveMissing = explicitConfirmation
    ? missingFields.filter((field) => field !== "consent_to_book")
    : [...new Set([...missingFields, "consent_to_book"])];

  if (context.cancelIntent || memory.status === "cancellation_requested" || memory.status === "handoff_required" || memory.status === "human_takeover" || context.conversationState === "cancellation_requested" || context.conversationState === "handoff_required" || context.conversationState === "human_takeover") {
    return {
      allowed: false,
      missing_fields: [],
      downgraded_action: memory.status === "handoff_required" || memory.status === "human_takeover" || context.conversationState === "handoff_required" || context.conversationState === "human_takeover" ? "handoff_to_admin" : "cancel_appointment",
      reason: "cancel_or_handoff_state_blocks_booking"
    };
  }

  if (context.workingHoursValidation?.valid === false) {
    return {
      allowed: false,
      missing_fields: effectiveMissing.includes("preferred_time") ? effectiveMissing : [...new Set([...effectiveMissing, "preferred_time"])],
      downgraded_action: "collect_datetime",
      reason: context.workingHoursValidation.reason || "time_outside_working_hours"
    };
  }

  if (context.conversationState === "reschedule_requested") {
    return {
      allowed: false,
      missing_fields: effectiveMissing,
      downgraded_action: "reschedule_appointment",
      reason: "reschedule_state_blocks_new_booking"
    };
  }

  if (!context.bookingIntent) {
    return {
      allowed: false,
      missing_fields: effectiveMissing,
      downgraded_action: isInformationQuestion(messageText) ? "answer_question" : "none",
      reason: "no_explicit_booking_intent"
    };
  }

  if (!explicitConfirmation) {
    return {
      allowed: false,
      missing_fields: effectiveMissing,
      downgraded_action: "offer_booking",
      reason: "missing_explicit_confirmation"
    };
  }

  if (effectiveMissing.length > 0) {
    return {
      allowed: false,
      missing_fields: effectiveMissing,
      downgraded_action: chooseDowngradedBookingAction(effectiveMissing),
      reason: "missing_required_booking_fields"
    };
  }

  return {
    allowed: true,
    missing_fields: [],
    downgraded_action: output.action === "create_appointment" ? "create_appointment" : "none",
    reason: null
  };
}

function chooseDowngradedBookingAction(missingFields = []) {
  if (missingFields.includes("patient_name")) return "collect_name";
  if (missingFields.includes("contact")) return "collect_phone";
  if (missingFields.includes("preferred_date") || missingFields.includes("preferred_time")) return "collect_datetime";
  if (missingFields.includes("reason")) return "collect_more_info";
  if (missingFields.includes("consent_to_book")) return "offer_booking";
  return "collect_more_info";
}

function weekdayKey(date, timezone = "Europe/Moscow") {
  const weekday = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: timezone
  }).format(date).toLowerCase();
  return weekday;
}

function minutesFromTime(time = "00:00") {
  const match = String(time || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

function hasExplicitBookingRequest(text = "") {
  const lower = String(text || "").toLowerCase();
  if (isInformationQuestion(lower)) return false;
  return /(запишите\s+меня|хочу\s+записа|можно\s+записа|давайте\s+запиш|подходит,\s*запиш|да,\s*запиш|запишите\s+на|записывайте|оформите\s+запись|забронируйте|book|appointment)/iu.test(lower);
}

function hasExplicitBookingConfirmation(text = "") {
  const lower = String(text || "").toLowerCase();
  if (isInformationQuestion(lower)) return false;
  return /(запишите\s+меня|хочу\s+записа|да,\s*запиш|^подходит[!.?\s]*$|подходит,\s*запиш|^давайте[!.?\s]*$|давайте\s+запиш|запишите\s+на|записывайте|оформите\s+запись|фиксируйте\s+запись|подтверждаю\s+запись)/iu.test(lower);
}

function isInformationQuestion(text = "") {
  const lower = String(text || "").toLowerCase();
  return /(сколько|скок|скока|цена|стоимост|прайс|какие\s+врачи|какой\s+врач|кто\s+врач|когда\s+можно|есть\s+ли\s+врач|консультаци|при[её]м\s+сколько|можно\s+приехать)/iu.test(lower) &&
    !/(запишите|хочу\s+записа|давайте\s+запиш|подходит,\s*запиш|оформите\s+запись)/iu.test(lower);
}

async function logPipelineEvents({ conversationId, events = [] }) {
  const relevantEvents = events.filter(Boolean);
  if (!relevantEvents.length) return;

  await prisma.agentAction.createMany({
    data: relevantEvents.map((event) => ({
      conversationId,
      actionType: event.type || "pipeline_event",
      reason: event.reason || null,
      payload: event
    }))
  });
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
  if (isAgentBookingIntent(agentResult.intent)) return true;

  return false;
}

function isAgentBookingIntent(intent) {
  return intent === "book_appointment" || intent === "booking";
}

export function shouldUseWorkflowProgressReply({ agentReply = "", missingFields = [], messageText = "" }) {
  const reply = String(agentReply || "").trim().toLowerCase();
  if (!reply) return true;

  const lowerMessage = String(messageText || "").toLowerCase();
  if (/(какие|что есть|услуг|цен|стоимост|прайс|сколько стоит)/iu.test(lowerMessage)) {
    return false;
  }

  const claimsBookingDone = /(готово|записал[аи]?|записываю|запись подтвержд|жд[её]м|напоминание.{0,40}создан|приходите|вас записали)/iu.test(reply);
  if (missingFields.length > 0 && claimsBookingDone) {
    return true;
  }

  if (missingFields.includes("patient_name") && !/(как вас зовут|имя|зовут)/iu.test(reply)) {
    return true;
  }

  if (missingFields.includes("contact") && !/(телефон|номер|контакт|как с вами связаться)/iu.test(reply)) {
    return true;
  }

  if (missingFields.includes("reason") && !/(что беспокоит|какая услуга|услуг|жалоб|причин)/iu.test(reply)) {
    return true;
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

function softenInformationQuestionReply(reply = "", { messageText = "", bookingIntent = false } = {}) {
  if (bookingIntent || !isInformationQuestion(messageText)) return reply;

  return String(reply || "")
    .replace(/\s*(?:Когда|На какой день|Во сколько)\s+[^.!?]{0,80}(?:удобно|сможете|можете)[^.!?]*\?/giu, " Если решите записаться на консультацию, помогу подобрать время.")
    .replace(/\s*Хотите\s+записаться[^.!?]*\?/giu, " Если решите записаться, помогу подобрать время.")
    .replace(/\s+/gu, " ")
    .trim();
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
      ? `${prefix}${service}${replyDate ? ` на ${replyDate}` : ""}${time ? ` в ${time}` : ""}. Записать вас?`
      : `${prefix}${service}${replyDate ? ` на ${replyDate}` : ""}${time ? ` в ${time}` : ""}. Подтвердите, записать вас?`;
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
