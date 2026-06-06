import { classifyUserIntentWithLLM, humanizeReplyWithAI } from "./agent.js";
import crypto from "node:crypto";
import {
  buildClinicDateTime as buildParsedClinicDateTime,
  extractBookingFacts,
  formatDateForReply as formatBookingDateForReply,
  getAmbiguousAppointmentTimeClarification,
  getMissingAppointmentFields,
  isBookingIntent,
  isBookingConfirmationText,
  normalizeAppointmentDate,
  normalizeAppointmentTime,
  normalizeBookingMemory,
  toIsoDate as toBookingIsoDate
} from "./bookingParser.js";
import { config } from "./config.js";
import { prisma } from "./db.js";
import {
  extractExplicitPatientName,
  findKnownClinicPersonByName,
  findKnownDoctorMention,
  isKnownClinicPersonName,
  isNameInDoctorContext,
  namesReferToSameKnownPerson,
  normalizeName,
  normalizeNameKey
} from "./nameRole.js";
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

const BOOKING_STATE_STATUSES = new Set([
  "collecting_info",
  "suggesting_slot",
  "awaiting_confirmation",
  "confirmed",
  "handoff_required"
]);

const MEMORY_CLEAR_FIELD_MAP = {
  preferred_doctor: ["preferred_doctor"],
  doctor: ["preferred_doctor"],
  preferred_date: ["preferred_date"],
  date: ["preferred_date"],
  preferred_time: ["preferred_time"],
  time: ["preferred_time"],
  time_constraint: ["time_constraint"],
  requested_service: ["requested_service"],
  service: ["requested_service"],
  complaint: ["complaint"],
  patient_name: ["patient_name"],
  phone: ["phone"]
};

const BOOKING_STATE_CLEAR_FIELD_MAP = {
  preferred_doctor: ["doctor"],
  doctor: ["doctor"],
  preferred_date: ["date"],
  date: ["date"],
  preferred_time: ["time"],
  time: ["time"],
  time_constraint: ["time_constraint"],
  requested_service: ["service"],
  service: ["service"],
  complaint: ["complaint"],
  patient_name: ["patient_name"],
  phone: ["phone"],
  contact: ["contact"]
};

const BOOKING_CONFIRMATION_INVALIDATING_FIELDS = new Set([
  "preferred_doctor",
  "doctor",
  "preferred_date",
  "date",
  "preferred_time",
  "time",
  "time_constraint",
  "requested_service",
  "service"
]);

const TRUSTED_PATIENT_NAME_SOURCES = new Set(["explicit_user_name", "channel_profile"]);

function normalizeChannel(channel) {
  return (cleanScalar(channel) || "MAX").toUpperCase();
}

export function mergeMemory(currentMemory, ...updates) {
  const merged = { ...(currentMemory || {}) };

  for (const update of updates.filter(Boolean)) {
    const clearFields = normalizeClearFields(
      update.clear_fields,
      update.unset_fields,
      update.null_fields,
      isPlainObject(update.booking_state) ? update.booking_state.clear_fields : null,
      isPlainObject(update.booking_state) ? update.booking_state.unset_fields : null,
      isPlainObject(update.booking_state) ? update.booking_state.null_fields : null
    );
    if (clearFields.length) {
      applyMemoryFieldClears(merged, clearFields);
    }

    for (const [key, value] of Object.entries(update)) {
      if (["clear_fields", "unset_fields", "null_fields"].includes(key)) continue;
      if (value === null || value === undefined || value === "") continue;
      if (key === "booking_state" && isPlainObject(value)) {
        merged.booking_state = mergeBookingState(merged.booking_state, value);
        continue;
      }

      merged[key] = value;
    }
  }

  if (isPlainObject(merged.booking_state)) {
    merged.booking_state = mergeBookingState(merged.booking_state);
  }

  return Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== null && value !== undefined && value !== "")
  );
}

function applyMemoryFieldClears(memory = {}, clearFields = []) {
  const normalizedFields = normalizeClearFields(clearFields);

  for (const field of normalizedFields) {
    for (const memoryField of MEMORY_CLEAR_FIELD_MAP[field] || []) {
      delete memory[memoryField];
    }
  }

  if (normalizedFields.some((field) => BOOKING_CONFIRMATION_INVALIDATING_FIELDS.has(field))) {
    delete memory.consent_to_book;
    if (memory.status === "waiting_booking_confirmation" || memory.status === "appointment_booked") {
      memory.status = "collecting_booking_data";
    }
  }

  if (isPlainObject(memory.booking_state)) {
    memory.booking_state = mergeBookingState(memory.booking_state, { clear_fields: normalizedFields });
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeClearFields(...values) {
  return [...new Set(values.flatMap((value) => {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    return String(value).split(/[,\s]+/u);
  }).map((field) => String(field || "").trim()).filter(Boolean))];
}

export function mergeBookingState(currentState = {}, ...updates) {
  const next = isPlainObject(currentState) ? { ...currentState } : {};

  for (const update of updates.filter(isPlainObject)) {
    const clearFields = normalizeClearFields(update.clear_fields, update.unset_fields, update.null_fields);
    for (const field of clearFields) {
      for (const stateField of BOOKING_STATE_CLEAR_FIELD_MAP[field] || []) {
        delete next[stateField];
      }
    }

    if (clearFields.some((field) => BOOKING_CONFIRMATION_INVALIDATING_FIELDS.has(field))) {
      next.status = "collecting_info";
      const missingFields = new Set(Array.isArray(next.missing_fields) ? next.missing_fields : []);
      for (const field of clearFields) {
        const stateField = (BOOKING_STATE_CLEAR_FIELD_MAP[field] || [])[0];
        if (stateField) missingFields.add(stateField);
      }
      next.missing_fields = [...missingFields];
    }

    for (const [key, value] of Object.entries(update)) {
      if (["clear_fields", "unset_fields", "null_fields"].includes(key)) continue;
      if (value === null || value === undefined || value === "") continue;

      if (["missing_fields", "secondary_intents"].includes(key) && Array.isArray(value)) {
        next[key] = [...new Set(value.filter(Boolean))];
        continue;
      }

      if (["asked_fields", "history"].includes(key) && Array.isArray(value)) {
        const previous = Array.isArray(next[key]) ? next[key] : [];
        next[key] = [...previous, ...value].filter(Boolean).slice(-12);
        continue;
      }

      if (key === "status" && !BOOKING_STATE_STATUSES.has(value)) continue;
      next[key] = value;
    }
  }

  return Object.fromEntries(
    Object.entries(next).filter(([, value]) => value !== null && value !== undefined && value !== "")
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

function normalizeAppointmentPhone(value) {
  const text = cleanScalar(value);
  if (!text) return null;
  const digits = text.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return null;
  if (text.trim().startsWith("+")) return `+${digits}`;
  if (digits.length === 11 && digits[0] === "8") return `+7${digits.slice(1)}`;
  if (digits.length === 10 && digits[0] === "9") return `+7${digits}`;
  return digits;
}

function truncateDbString(value, maxLength) {
  const text = cleanScalar(value);
  if (!text) return null;
  return text.length > maxLength ? text.slice(0, maxLength) : text;
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

function normalizeChannelProfileName(value = "") {
  const name = normalizeName(value);
  if (!name || isKnownClinicPersonName(name)) return null;
  return name;
}

function getSafePatientName(memory = {}, payload = {}, fallbackName = "") {
  const explicitName = normalizeName(memory.patient_name || memory.booking_state?.patient_name || "");
  const explicitSource = memory.patient_name_source || memory.booking_state?.patient_name_source || null;
  if (explicitName && TRUSTED_PATIENT_NAME_SOURCES.has(explicitSource) && !isKnownClinicPersonName(explicitName)) {
    return explicitName;
  }

  const fallback = normalizeName(fallbackName);
  if (fallback && !isKnownClinicPersonName(fallback)) return fallback;

  return normalizeChannelProfileName(payload.display_name);
}

function getSafePatientPrefix(memory = {}, payload = {}, fallbackName = "") {
  const name = getSafePatientName(memory, payload, fallbackName);
  return name ? `${shortName(name)}, ` : "";
}

function stripUnsafeDoctorAddressing(reply = "", { memory = {}, payload = {} } = {}) {
  const text = String(reply || "").trim();
  if (!text) return text;

  const safeName = getSafePatientName(memory, payload);
  const prefix = text.match(/^([^,!.?]{2,80}),\s+/u);
  if (!prefix) return text;

  const addressedName = normalizeName(prefix[1]);
  if (safeName && normalizeNameKey(addressedName) === normalizeNameKey(safeName)) return text;
  if (isKnownClinicPersonName(addressedName) || namesReferToSameKnownPerson(addressedName, memory.preferred_doctor || memory.booking_state?.doctor || "")) {
    return text.slice(prefix[0].length).trimStart();
  }

  return text;
}

function hasActiveBookingState(memory = {}) {
  const state = memory.booking_state || {};
  return Boolean(
    memory.status === "collecting_booking_data" ||
    memory.status === "waiting_booking_confirmation" ||
    state.status === "collecting_info" ||
    state.status === "suggesting_slot" ||
    state.status === "awaiting_confirmation" ||
    memory.intent === "book_appointment" ||
    state.intent === "book_appointment" ||
    memory.requested_service ||
    memory.complaint ||
    memory.preferred_date ||
    memory.preferred_time ||
    memory.preferred_doctor ||
    memory.time_constraint ||
    state.service ||
    state.date ||
    state.time ||
    state.doctor ||
    state.time_constraint
  );
}

function isAwaitingBookingConfirmation(memory = {}) {
  return memory.status === "waiting_booking_confirmation" ||
    memory.booking_state?.status === "awaiting_confirmation" ||
    memory.booking_state?.status === "suggesting_slot";
}

function enrichMemoryWithBookingState(memory = {}, {
  previousMemory = {},
  payload = {},
  bookingIntent = false,
  appointmentValidation = null,
  appointmentRequest = null,
  activeAppointment = null,
  slotConflict = null,
  agentResult = {},
  missingFields = null
} = {}) {
  const previousState = memory.booking_state || previousMemory.booking_state || {};
  const payloadMaxUserId = payload.max_user_id || payload.maxUserId || null;
  const previousPhone = previousState.phone === payloadMaxUserId ? null : previousState.phone;
  const payloadProfileName = normalizeChannelProfileName(payload.display_name);
  const patientName = memory.patient_name || previousState.patient_name || payloadProfileName;
  const patientNameSource = memory.patient_name_source ||
    previousState.patient_name_source ||
    (payloadProfileName && patientName === payloadProfileName ? "channel_profile" : null);
  const shouldTrackBooking = bookingIntent ||
    hasActiveBookingState(memory) ||
    hasActiveBookingState(previousMemory) ||
    Boolean(appointmentValidation || appointmentRequest || activeAppointment || slotConflict || agentResult.should_handoff);

  if (!shouldTrackBooking) return memory;

  const normalizedDate = normalizeAppointmentDate(memory.preferred_date);
  const normalizedTime = normalizeAppointmentTime(memory.preferred_time);
  const legacyStatus = memory.status || previousMemory.status || null;
  let status = resolveBookingStateStatus({
    previousStatus: previousState.status,
    legacyStatus,
    bookingIntent,
    appointmentValidation,
    appointmentRequest,
    activeAppointment,
    slotConflict,
    agentResult
  });
  if (
    bookingIntent &&
    memory.consent_to_book !== true &&
    status === "collecting_info" &&
    hasConcreteBookingProposal({
      ...memory,
      booking_state: mergeBookingState(previousState, {
        service: memory.requested_service || previousState.service,
        doctor: memory.preferred_doctor || previousState.doctor,
        date: normalizedDate ? toBookingIsoDate(normalizedDate) : previousState.date,
        time: normalizedTime || previousState.time
      })
    })
  ) {
    status = "awaiting_confirmation";
  }
  const mappedMissingFields = mapMissingFieldsToBookingState(
    missingFields || appointmentValidation?.missing_fields || previousState.missing_fields || []
  );

  const bookingState = mergeBookingState(previousState, {
    intent: memory.intent || previousState.intent || (bookingIntent || hasActiveBookingState(memory) ? "book_appointment" : null),
    service: memory.requested_service || previousState.service,
    doctor: memory.preferred_doctor || previousState.doctor,
    date: normalizedDate ? toBookingIsoDate(normalizedDate) : previousState.date,
    time: normalizedTime || previousState.time,
    time_constraint: memory.time_constraint || previousState.time_constraint,
    patient_name: patientName,
    patient_name_source: patientNameSource,
    phone: normalizeAppointmentPhone(memory.phone) || normalizeAppointmentPhone(previousPhone) || normalizeAppointmentPhone(payload.phone),
    contact: previousState.contact || payloadMaxUserId,
    complaint: memory.complaint || previousState.complaint,
    status,
    missing_fields: mappedMissingFields
  });

  const next = { ...memory, booking_state: bookingState };
  if (bookingState.intent && !next.intent) next.intent = bookingState.intent;
  if (bookingState.service && !next.requested_service) next.requested_service = bookingState.service;
  if (bookingState.complaint && !next.complaint) next.complaint = bookingState.complaint;
  if (bookingState.doctor && !next.preferred_doctor) next.preferred_doctor = bookingState.doctor;
  if (bookingState.date && !next.preferred_date) next.preferred_date = bookingState.date;
  if (bookingState.time && !next.preferred_time) next.preferred_time = bookingState.time;
  if (bookingState.time_constraint && !next.time_constraint) next.time_constraint = bookingState.time_constraint;
  if (bookingState.patient_name && !next.patient_name && bookingState.patient_name !== payload.display_name) {
    next.patient_name = bookingState.patient_name;
  }
  if (bookingState.patient_name_source && !next.patient_name_source && next.patient_name) {
    next.patient_name_source = bookingState.patient_name_source;
  }
  if (bookingState.phone && !next.phone && bookingState.phone !== payloadMaxUserId) {
    next.phone = bookingState.phone;
  }

  return normalizeBookingMemory(next);
}

function resolveBookingStateStatus({
  previousStatus = null,
  legacyStatus = null,
  bookingIntent = false,
  appointmentValidation = null,
  appointmentRequest = null,
  activeAppointment = null,
  slotConflict = null,
  agentResult = {}
} = {}) {
  if (agentResult.should_handoff || legacyStatus === "handoff_required" || legacyStatus === "human_takeover") return "handoff_required";
  if (appointmentRequest?.status === "confirmed" || appointmentValidation?.allowed || activeAppointment?.status === "confirmed") return "confirmed";
  if (slotConflict) return "collecting_info";
  if (appointmentValidation?.missing_fields?.length === 1 && appointmentValidation.missing_fields.includes("consent_to_book")) return "awaiting_confirmation";
  if (legacyStatus === "waiting_booking_confirmation") return "awaiting_confirmation";
  if (legacyStatus === "collecting_booking_data" || bookingIntent) return "collecting_info";
  if (BOOKING_STATE_STATUSES.has(previousStatus)) return previousStatus;
  return null;
}

function mapMissingFieldsToBookingState(missingFields = []) {
  const mapping = {
    reason: "service",
    preferred_doctor: "doctor",
    preferred_date: "date",
    preferred_time: "time",
    consent_to_book: "confirmation",
    contact: "phone",
    patient_name: "patient_name"
  };
  return [...new Set((missingFields || []).map((field) => mapping[field] || field).filter(Boolean))];
}

function normalizeBookingMissingFieldsForState(missingFields = [], { memory = {}, payload = {}, bookingIntent = false } = {}) {
  const withoutConfirmation = [...new Set(missingFields || [])].filter((field) => field !== "consent_to_book");
  if (!getSafePatientName(memory, payload) && !withoutConfirmation.includes("patient_name")) {
    withoutConfirmation.push("patient_name");
  }
  if (!bookingIntent) return withoutConfirmation;

  const hasService = isBookingFieldPresent("reason", memory, payload);
  const hasDate = isBookingFieldPresent("preferred_date", memory, payload);
  const hasTime = isBookingFieldPresent("preferred_time", memory, payload);
  const hasDoctor = isBookingFieldPresent("preferred_doctor", memory, payload);
  const explicitConfirmation = memory.consent_to_book === true;

  if (!explicitConfirmation && hasService && hasDate && hasTime && !hasDoctor) {
    return [...new Set([...withoutConfirmation, "preferred_doctor"])];
  }

  if (shouldRequireBookingConfirmation({ memory, missingFields: withoutConfirmation, bookingIntent })) {
    return [...new Set([...withoutConfirmation, "consent_to_book"])];
  }

  return withoutConfirmation;
}

function shouldRequireBookingConfirmation({ memory = {}, missingFields = [], bookingIntent = false } = {}) {
  if (!bookingIntent || memory.consent_to_book === true) return false;
  if ((missingFields || []).filter((field) => field !== "consent_to_book").length > 0) return false;
  const state = memory.booking_state || {};
  const statusAllowsConfirmation = state.status === "awaiting_confirmation" || memory.status === "waiting_booking_confirmation";
  return statusAllowsConfirmation && hasConcreteBookingProposal(memory);
}

function hasConcreteBookingProposal(memory = {}) {
  return Boolean(
    (memory.requested_service || memory.complaint || memory.booking_state?.service || memory.booking_state?.complaint) &&
    normalizeAppointmentDate(memory.preferred_date || memory.booking_state?.date) &&
    normalizeAppointmentTime(memory.preferred_time || memory.booking_state?.time) &&
    (memory.preferred_doctor || memory.booking_state?.doctor)
  );
}

function filterMissingBookingFieldsForReply(missingFields = [], { memory = {}, payload = {}, recentMessages = [] } = {}) {
  const stillMissing = [...new Set(missingFields || [])].filter((field) => !isBookingFieldPresent(field, memory, payload));
  const notRecentlyAsked = stillMissing.filter((field) => !wasBookingFieldAskedRecently(field, recentMessages));
  return notRecentlyAsked.length ? notRecentlyAsked : stillMissing;
}

function isBookingFieldPresent(field, memory = {}, payload = {}) {
  const state = memory.booking_state || {};
  const payloadMaxUserId = payload.max_user_id || payload.maxUserId || null;
  if (field === "patient_name") return Boolean(getSafePatientName(memory, payload));
  if (field === "contact") return Boolean(normalizeAppointmentPhone(memory.phone) || normalizeAppointmentPhone(state.phone) || normalizeAppointmentPhone(payload.phone) || state.contact || payloadMaxUserId);
  if (field === "reason") return Boolean(memory.requested_service || memory.complaint || state.service || state.complaint);
  if (field === "preferred_doctor") return Boolean(memory.preferred_doctor || state.doctor);
  if (field === "preferred_date") return Boolean(normalizeAppointmentDate(memory.preferred_date || state.date));
  if (field === "preferred_time") return Boolean(normalizeAppointmentTime(memory.preferred_time || state.time));
  if (field === "consent_to_book") return memory.consent_to_book === true;
  return false;
}

function wasBookingFieldAskedRecently(field, recentMessages = []) {
  const stateField = mapMissingFieldsToBookingState([field])[0];
  const recentAssistantTexts = (recentMessages || [])
    .filter((message) => message.role === "assistant" || message.direction === "outgoing")
    .slice(-3)
    .map((message) => String(message.text || "").toLowerCase());

  return recentAssistantTexts.some((text) => {
    if (stateField === "service") return /(что беспокоит|какую услугу|на какую услугу)/iu.test(text);
    if (stateField === "date") return /(какой день|на какой день|дата|когда)/iu.test(text);
    if (stateField === "time") return /(какое время|на какое время|во сколько|точное время)/iu.test(text);
    if (stateField === "doctor") return /(к какому врачу|какой врач|врач)/iu.test(text);
    if (stateField === "confirmation") return /(подтверд|записать вас|подтверждаете)/iu.test(text);
    if (stateField === "phone") return /(телефон|номер|контакт)/iu.test(text);
    if (stateField === "patient_name") return /(как вас зовут|имя|зовут)/iu.test(text);
    return false;
  });
}

function recordBookingStateTurn(memory = {}, { reply = "", missingFields = [] } = {}) {
  if (!hasActiveBookingState(memory) && !memory.booking_state) return memory;
  const askedFields = inferAskedBookingFields(reply, missingFields);
  if (!askedFields.length) return memory;

  const now = new Date().toISOString();
  const entries = askedFields.map((field) => ({
    field,
    at: now,
    question: String(reply || "").slice(0, 180)
  }));

  return {
    ...memory,
    booking_state: mergeBookingState(memory.booking_state, {
      asked_fields: entries,
      history: [{ role: "assistant", text: String(reply || "").slice(0, 240), at: now }]
    })
  };
}

function inferAskedBookingFields(reply = "", missingFields = []) {
  const lower = String(reply || "").toLowerCase();
  const fields = new Set(mapMissingFieldsToBookingState(missingFields));
  if (/(что беспокоит|какую услугу|на какую услугу)/iu.test(lower)) fields.add("service");
  if (/(какой день|на какой день|дата|когда)/iu.test(lower)) fields.add("date");
  if (/(какое время|на какое время|во сколько|точное время)/iu.test(lower)) fields.add("time");
  if (/(к какому врачу|какой врач)/iu.test(lower)) fields.add("doctor");
  if (/(подтверд|записать вас|подтверждаете)/iu.test(lower)) fields.add("confirmation");
  if (/(телефон|номер|контакт)/iu.test(lower)) fields.add("phone");
  if (/(как вас зовут|имя|зовут)/iu.test(lower)) fields.add("patient_name");
  return [...fields].filter(Boolean);
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
    const takeoverMemoryRow = await prisma.conversationMemory.findUnique({
      where: { conversationId: conversation.id }
    });
    const latestOpenHandoff = await prisma.handoff.findFirst({
      where: { conversationId: conversation.id, status: "open" },
      orderBy: { createdAt: "desc" }
    });
    const canResumeAi = canResumeAiFromHumanTakeover(messageText, {
      memory: takeoverMemoryRow?.memory || {},
      conversation,
      latestHandoff: latestOpenHandoff
    });

    if (canResumeAi) {
      const resumedMemory = {
        ...clearStaleBookingMemory(takeoverMemoryRow?.memory || {}),
        status: getResumeMemoryStatus(messageText)
      };
      await prisma.conversationMemory.upsert({
        where: { conversationId: conversation.id },
        update: {
          memory: resumedMemory,
          updatedAt: new Date()
        },
        create: {
          conversationId: conversation.id,
          memory: resumedMemory
        }
      });
      await prisma.handoff.updateMany({
        where: { conversationId: conversation.id, status: "open" },
        data: {
          status: "resolved",
          resolvedAt: new Date()
        }
      });
      await returnConversationToAI({ conversationId: conversation.id });
      conversation.status = "active";
    } else {
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
    : normalizeBookingMemory(memoryRow?.memory || {});
  baseMemory = enrichMemoryWithBookingState(baseMemory, {
    previousMemory: memoryRow?.memory || {},
    payload,
    activeAppointment
  });
  const hardGuardIntent = detectConversationIntent(messageText);
  const actionableBookingCorrection = isActionableBookingCorrection(messageText, {
    memory: baseMemory,
    activeAppointment
  });

  if (
    !activeAppointment &&
    baseMemory.status === "cancellation_requested" &&
    hardGuardIntent.intent === "message" &&
    hasExplicitBookingRequest(messageText)
  ) {
    baseMemory = { ...clearAppointmentDraft(baseMemory), status: "collecting_booking_data" };
  }

  if (
    !activeAppointment &&
    ["handoff_required", "human_takeover"].includes(baseMemory.status) &&
    actionableBookingCorrection
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
      doctor: baseMemory.preferred_doctor,
      date: baseMemory.preferred_date,
      time: baseMemory.preferred_time,
      time_constraint: baseMemory.time_constraint,
      status: baseMemory.status,
      booking_state: baseMemory.booking_state || null
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
  const deterministicFacts = postValidateMemoryNameRoles(extractBookingFacts(messageText), {
    messageText,
    payload,
    strictPatientSource: true
  });
  const awaitingBookingConfirmation = isAwaitingBookingConfirmation(baseMemory);
  const explicitBookingConfirmation = hasExplicitBookingConfirmation(messageText) ||
    (awaitingBookingConfirmation && isBookingConfirmationText(messageText));
  if (explicitBookingConfirmation) {
    deterministicFacts.consent_to_book = true;
  }
  const classifierBookingSignal = isClassifierBookingSignal(agentResult);
  const continuingBookingStateSignal = hasActiveBookingState(baseMemory) && (
    hasActionableBookingFacts(deterministicFacts) ||
    deterministicFacts.confirmation === true ||
    explicitBookingConfirmation
  );
  const currentMessageBookingSignal = conversationIntent.intent === "booking_request" ||
    classifierBookingSignal ||
    actionableBookingCorrection ||
    continuingBookingStateSignal ||
    hasExplicitBookingRequest(messageText) ||
    isBookingIntent({
      text: messageText,
      memory: deterministicFacts
    });
  const safeMemoryUpdate = !activeAppointment && !currentMessageBookingSignal
    ? clearStaleBookingMemory(sanitizeAgentMemoryUpdate(agentResult.memory_update, messageText, payload))
    : sanitizeAgentMemoryUpdate(agentResult.memory_update, messageText, payload);
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

  const correctionSafetyOverride = applyActionableCorrectionSafetyOverride({
    agentResult: safeAgentResult,
    messageText,
    memory: baseMemory,
    activeAppointment
  });
  Object.assign(safeAgentResult, correctionSafetyOverride.agentResult);
  pipelineEvents.push(...correctionSafetyOverride.events);

  let nextMemory = normalizeBookingMemory(mergeMemory(
    baseMemory,
    safeAgentResult.memory_update,
    deterministicFacts
  ));
  const ambiguousTimeClarification = getAmbiguousAppointmentTimeClarification(messageText);
  if (ambiguousTimeClarification && nextMemory.preferred_time === "05:00") {
    nextMemory = { ...nextMemory };
    delete nextMemory.preferred_time;
    pipelineEvents.push({
      type: "ambiguous_time_cleared",
      source_text: messageText.slice(0, 160),
      previous_time: "05:00",
      suggested_time: ambiguousTimeClarification.suggested_time,
      reason: "low_hour_without_day_part"
    });
  }
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
  nextMemory = enrichMemoryWithBookingState(nextMemory, {
    previousMemory: baseMemory,
    payload,
    bookingIntent,
    activeAppointment
  });
  const conversationState = resolveConversationState({
    memory: baseMemory,
    activeAppointment,
    bookingIntent,
    informationQuestion: isInformationQuestion(messageText)
  });
  const postBookingSocialReply = hasConfirmedBooking
    ? buildPostBookingSocialReply({ messageText, appointmentRequest: activeAppointment, memory: nextMemory })
    : null;
  const missingBookingFields = normalizeBookingMissingFieldsForState(
    getMissingAppointmentFields({ memory: nextMemory, payload }),
    { memory: nextMemory, payload, bookingIntent }
  );
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
  const responseMissingBookingFields = bookingIntent
    ? filterMissingBookingFieldsForReply(appointmentValidation.missing_fields, { memory: nextMemory, payload, recentMessages })
    : [];
  const replyAppointmentValidation = {
    ...appointmentValidation,
    missing_fields: responseMissingBookingFields
  };
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
  nextMemory = enrichMemoryWithBookingState(nextMemory, {
    previousMemory: baseMemory,
    payload,
    bookingIntent,
    appointmentValidation,
    appointmentRequest,
    activeAppointment,
    slotConflict,
    agentResult: safeAgentResult,
    missingFields: appointmentValidation.missing_fields
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
  } else if (conversationIntent.intent === "service_question") {
    finalReply = buildDentalServiceInfoReply({ service: conversationIntent.service, serviceCategory: conversationIntent.service_category, messageText });
    replySource = "dental_service_info";
  } else if (slotConflict) {
    finalReply = buildSlotConflictReply({ memory: nextMemory, slotConflict, messageText });
    replySource = "slot_conflict";
  } else if (appointmentRequest && shouldCreateAppointmentRequest) {
    finalReply = buildBookingConfirmedReply({ appointmentRequest, memory: nextMemory, messageText });
    replySource = "booking_confirmed";
  } else if (actionableBookingCorrection && bookingIntent && !appointmentValidation.allowed) {
    finalReply = buildActionableBookingCorrectionReply({
      memory: nextMemory,
      payload,
      missingFields: responseMissingBookingFields,
      messageText
    });
    replySource = "booking_correction_progress";
  } else if (conversationIntent.intent === "booking_request" && bookingIntent && !appointmentValidation.allowed) {
    finalReply = buildBookingProgressReply({ memory: nextMemory, payload, missingFields: responseMissingBookingFields, messageText, recentMessages });
    replySource = "booking_progress";
  } else if (conversationIntent.intent === "booking_request" && isUnsafeDentalServiceReply(safeAgentResult.reply)) {
    finalReply = buildBookingProgressReply({ memory: nextMemory, payload, missingFields: responseMissingBookingFields, messageText, recentMessages });
    replySource = "booking_progress";
  } else if (bookingIntent && shouldUseWorkflowProgressReply({
    agentReply: safeAgentResult.reply,
    missingFields: responseMissingBookingFields,
    messageText
  })) {
    finalReply = buildBookingProgressReply({ memory: nextMemory, payload, missingFields: responseMissingBookingFields, messageText, recentMessages });
    replySource = "booking_progress";
  } else if (!String(finalReply || "").trim()) {
    finalReply = buildClassifierGuidedReply({
      agentResult: safeAgentResult,
      memory: nextMemory,
      payload,
      messageText,
      appointmentValidation: replyAppointmentValidation,
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
  finalReply = stripUnsafeDoctorAddressing(finalReply, { memory: nextMemory, payload });
  if (shouldHumanizeReplySource(replySource)) {
    const humanized = await humanizeReplyWithAI({
      safeReply: finalReply,
      userMessage: messageText,
      action: appointmentValidation.allowed ? "create_appointment" : appointmentValidation.downgraded_action,
      state: nextMemory.status
    });
    pipelineEvents.push(...humanized.events);
    finalReply = humanized.reply || finalReply;
    finalReply = stripUnsafeDoctorAddressing(finalReply, { memory: nextMemory, payload });
  }
  finalReply = sanitizeReplyForUser(finalReply, { userMessage: messageText });
  finalReply = stripUnsafeDoctorAddressing(finalReply, { memory: nextMemory, payload });
  finalReply = avoidRepeatedBotReply(finalReply, recentMessages);
  nextMemory = recordBookingStateTurn(nextMemory, {
    reply: finalReply,
    missingFields: responseMissingBookingFields
  });

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

    await prisma.appointmentSlot.deleteMany({
      where: {
        appointmentRequestId: { in: appointmentIds }
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
    if (confirm && preferredDate && preferredTime) {
      await prisma.appointmentSlot.deleteMany({
        where: {
          slotDate: preferredDate,
          slotTime: preferredTime,
          appointmentRequest: {
            status: { notIn: ["new", "pending", "collecting", "waiting_confirmation", "confirmed"] }
          }
        }
      });
    }

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
      const appointmentPhone = normalizeAppointmentPhone(memory.phone) || normalizeAppointmentPhone(payload.phone);

      const data = {
        patientName: truncateDbString(getSafePatientName(memory, payload), 255),
        phone: appointmentPhone,
        complaint: memory.complaint || null,
        requestedService: truncateDbString(memory.requested_service, 255),
        preferredDate,
        preferredTime,
        preferredDoctor: truncateDbString(memory.preferred_doctor, 255),
        urgency: truncateDbString(memory.urgency, 50) || "normal",
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
  delete cleaned.time_constraint;
  delete cleaned.booking_state;
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
    facts.time_constraint ||
    facts.requested_service ||
    facts.preferred_doctor ||
    facts.consent_to_book === true ||
    facts.confirmation === true
  );
}

function hasSchedulingBookingFacts(facts = {}) {
  return Boolean(
    facts.intent === "book_appointment" ||
    facts.patient_name ||
    facts.phone ||
    facts.preferred_date ||
    facts.preferred_time ||
    facts.time_constraint ||
    facts.preferred_doctor ||
    facts.consent_to_book === true ||
    facts.confirmation === true
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
    const medicalRisk = detectMedicalRisk(lower);
    const serviceQuestion = isDentalServiceQuestionContext(lower, dentalService);
    const intent = medicalRisk
      ? "medical_question"
      : (pricing ? "pricing_question" : (serviceQuestion ? "service_question" : "booking_request"));
    const answeringQuestion = intent === "pricing_question" || intent === "service_question";
    return {
      intent,
      sub_intent: pricing && dentalService.complaint ? "medical_context_price" : dentalService.sub_intent,
      secondary_intents: pricing && dentalService.complaint
        ? ["medical_question", "service_question"]
        : (serviceQuestion && dentalService.complaint ? ["medical_question"] : []),
      action: medicalRisk ? "handoff_to_admin" : (answeringQuestion ? "provide_info" : "collect_datetime"),
      state: medicalRisk ? "handoff_required" : (answeringQuestion ? "answering_question" : "collecting_booking_data"),
      shouldHandoff: medicalRisk,
      angry: false,
      confidence: dentalService.confidence,
      service: dentalService.service,
      service_category: dentalService.service_category,
      complaint: dentalService.complaint || null,
      extracted: {
        service: dentalService.service,
        service_category: dentalService.service_category,
        complaint: dentalService.complaint || null,
        relative_date: lower.includes("послезавтра") ? "day_after_tomorrow" : (lower.includes("завтра") ? "tomorrow" : null),
        appointment_reference: "none"
      },
      safe_next_action: medicalRisk ? "handoff_to_admin" : (answeringQuestion ? "provide_info" : (normalizeAppointmentTime(lower) ? "collect_date" : "collect_time")),
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

  if (detectHumanEscalationRequest(text)) {
    return setRisk({
      level: "high",
      type: "human_requested",
      shouldHandoff: true,
      reason: "human_requested",
      event: { type: "human_escalation_requested" }
    });
  }

  if (detectAggressionWithComplaint(text, context)) {
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

function detectHumanEscalationRequest(text = "") {
  return /(администратор|админа|оператор|человек|живой\s+сотрудник|позовите\s+руковод|руководств)/iu.test(text);
}

function detectWrongBookingComplaint(text = "") {
  return /(зачем\s+вы\s+меня\s+записал|я\s+не\s+просил|я\s+не\s+просила|без\s+моего\s+подтверждения|мы\s+еще\s+ничего\s+не\s+обговорили|мы\s+ещё\s+ничего\s+не\s+обговорили|я\s+не\s+подтверждал|я\s+не\s+подтверждала)/iu.test(text);
}

function detectAggressionWithComplaint(text = "", context = {}) {
  if (isActionableBookingCorrection(text, context) && detectMildAggression(text) && !detectHighAggression(text) && !detectHumanEscalationRequest(text)) {
    return false;
  }

  const aggressive = detectMildAggression(text) || detectHighAggression(text);
  const complaint = /(запис|цена|дорог|почему|что\s+за|вы\s+что|вы\s+чо|не\s+просил|не\s+надо|отмен|удалите\s+запись)/iu.test(text);
  return aggressive && complaint;
}

function detectMildAggression(text = "") {
  return /(тупите|тупишь|вы\s+ч[еёо]|бля|блин|ебать|ёбать)/iu.test(text);
}

function detectHighAggression(text = "") {
  return /(нахуй|пошли\s+нах|долбо[её]б|уеб|уёб|сука.*клиник|мраз|урод|ебан|еблан|пизд)/iu.test(text);
}

export function isActionableBookingCorrection(text = "", context = {}) {
  const lower = String(text || "").toLowerCase();
  const memory = context.memory || {};
  const hasCorrection = /(имею\s+в\s*виду|имел[а]?\s+в\s*виду|я\s+имел|я\s+имела|17\s*:?\s*00|17\s+00|5\s+дня|пять\s+дня|в\s+5\s+(?:дня|вечера)|не\s+05|не\s+утра)/iu.test(lower);
  if (!hasCorrection) return false;

  const hasBookingContextInText = /(запис|время|завтра|сегодня|послезавтра|врач|дмитр|при[её]м|чистк|гигиен|слот|принять|примет)/iu.test(lower);
  const hasBookingContextInMemory = Boolean(
    memory.intent === "book_appointment" ||
    memory.requested_service ||
    memory.complaint ||
    memory.preferred_date ||
    memory.preferred_doctor ||
    memory.status === "collecting_booking_data" ||
    memory.status === "handoff_required" ||
    context.activeAppointment
  );

  return hasBookingContextInText || hasBookingContextInMemory;
}

function canResumeAiAfterActionableCorrection(text = "", context = {}) {
  if (!isActionableBookingCorrection(text, context)) return false;
  if (detectLegalThreat(text) || detectBadReviewThreat(text) || detectReputationRisk(text) || detectHumanEscalationRequest(text)) return false;
  if (detectHighAggression(text)) return false;
  return true;
}

export function canResumeAiFromHumanTakeover(text = "", context = {}) {
  if (canResumeAiAfterActionableCorrection(text, context)) return true;

  const latestHandoff = context.latestHandoff || {};
  if (!["aggression_with_complaint", "angry_abuse", "cancel_or_wrong_booking_complaint"].includes(latestHandoff.reason)) {
    return false;
  }

  if (detectLegalThreat(text) || detectBadReviewThreat(text) || detectReputationRisk(text) || detectHumanEscalationRequest(text) || detectHighAggression(text)) {
    return false;
  }

  return isSafeBusinessResumeMessage(text);
}

function isSafeBusinessResumeMessage(text = "") {
  const lower = String(text || "").toLowerCase();
  if (isGreetingOnly(text)) return true;
  if (hasExplicitBookingRequest(text)) return true;
  if (isBookingIntent({ text, memory: extractBookingFacts(text) })) return true;
  if (detectDentalServiceIntent(lower).detected) return true;
  return /(запис|при[её]м|чистк|гигиен|кариес|лечени|консультац|завтра|сегодня|послезавтра|врач|стоматолог|болит|стоимост|цена|сколько|скок)/iu.test(lower);
}

function getResumeMemoryStatus(text = "") {
  return isGreetingOnly(text) ? "idle" : "collecting_booking_data";
}

function applyActionableCorrectionSafetyOverride({ agentResult = {}, messageText = "", memory = {}, activeAppointment = null } = {}) {
  const safeAgentResult = {
    ...agentResult,
    memory_update: { ...(agentResult.memory_update || {}) },
    memory_patch: { ...(agentResult.memory_patch || {}) }
  };
  const events = [];

  if (!canResumeAiAfterActionableCorrection(messageText, { memory, activeAppointment })) {
    return { agentResult: safeAgentResult, events };
  }

  const asksForHandoff = Boolean(safeAgentResult.should_handoff) ||
    safeAgentResult.action === "handoff_to_admin" ||
    safeAgentResult.safe_next_action === "handoff_to_admin" ||
    safeAgentResult.memory_update.status === "handoff_required" ||
    safeAgentResult.memory_patch.status === "handoff_required";

  if (!asksForHandoff) {
    return { agentResult: safeAgentResult, events };
  }

  events.push({
    type: "handoff_suppressed_for_actionable_booking_correction",
    previous_action: safeAgentResult.action || null,
    previous_reason: safeAgentResult.handoff_reason || null
  });

  safeAgentResult.intent = "booking";
  safeAgentResult.action = "collect_datetime";
  safeAgentResult.safe_next_action = "collect_datetime";
  safeAgentResult.should_handoff = false;
  safeAgentResult.handoff_reason = null;
  safeAgentResult.should_create_appointment_request = false;
  safeAgentResult.memory_update.status = "collecting_booking_data";
  safeAgentResult.memory_patch.status = "collecting_booking_data";

  if (/администратор|передам|остановлю|handoff/iu.test(String(safeAgentResult.reply || ""))) {
    safeAgentResult.reply = "";
  }

  return { agentResult: safeAgentResult, events };
}

function detectMedicalRisk(text = "") {
  return /(отек|отёк|температур|кровотеч|кровь\s+не\s+останавливается|травм|сильн.{0,20}бол|дышать\s+тяжело|глотать\s+тяжело|гной|инфекц|после\s+операц)/iu.test(text);
}

function countRecentPriceObjections(messages = []) {
  return messages.filter((message) => message.direction === "incoming" && detectPriceObjection(message.text || "")).length;
}

export function detectDentalServiceIntent(text = "") {
  const lower = String(text || "").toLowerCase();
  const wisdomTerm = /(зуб(?:а|ы)?\s+мудрости|восьм[её]рк[а-я]*)/iu.test(lower);
  const wisdomComplaint = detectWisdomToothComplaint(lower);
  const wisdomExtraction = /(удал(?:ить|ите|ение|ен[а-я]*)|вырвать|вырывать).{0,40}(зуб(?:а|ы)?\s+мудрости|мудрости|восьм[её]рк[а-я]*)|(зуб(?:а|ы)?\s+мудрости|восьм[её]рк[а-я]*).{0,40}(удал(?:ить|ите|ение|ен[а-я]*)|вырвать|вырывать)/iu.test(lower);
  if (wisdomExtraction) {
    return {
      detected: true,
      confidence: 0.98,
      service: "удаление зуба мудрости",
      service_category: "wisdom_tooth_extraction",
      complaint: wisdomComplaint,
      sub_intent: "dental_service_request",
      reason: "delete_word_near_wisdom_tooth"
    };
  }

  if (wisdomTerm) {
    return {
      detected: true,
      confidence: wisdomComplaint ? 0.86 : 0.78,
      service: "зубы мудрости",
      service_category: "wisdom_tooth_extraction",
      complaint: wisdomComplaint,
      sub_intent: wisdomComplaint ? "dental_complaint" : "dental_service_context",
      reason: wisdomComplaint ? "wisdom_tooth_eruption_context" : "wisdom_tooth_context"
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

function detectWisdomToothComplaint(text = "") {
  const lower = String(text || "").toLowerCase();
  if (!/(зуб(?:а|ы)?\s+мудрости|восьм[её]рк[а-я]*)/iu.test(lower)) return null;
  if (/(реж(?:е|у)тся|режется|лез(?:е|у)т|лезет|прорез(?:ыва)?[а-я]*)/iu.test(lower)) {
    return "режутся зубы мудрости";
  }
  if (/(болит|ноет|беспоко[иь]т|тянет)/iu.test(lower)) {
    return "беспокоят зубы мудрости";
  }
  return null;
}

function isDentalServiceQuestionContext(text = "", dentalService = {}) {
  const lower = String(text || "").toLowerCase();
  return dentalService.sub_intent === "dental_complaint" ||
    /((чо|че|чё|что)\s+делать|как\s+быть|болит|ноет|реж(?:е|у)тся|режется|лез(?:е|у)т|лезет)/iu.test(lower);
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
  if (memory.booking_state?.status === "awaiting_confirmation" || memory.booking_state?.status === "suggesting_slot") return "waiting_booking_confirmation";
  if (memory.booking_state?.status === "collecting_info") return "collecting_booking_data";
  if (memory.booking_state?.status === "confirmed") return "appointment_booked";
  if (memory.booking_state?.status === "handoff_required") return "handoff_required";
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
  const prefix = getSafePatientPrefix(memory, payload);

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

  const topicReply = buildUnderstoodDentalTopicReply({ messageText, memory });
  if (topicReply) return topicReply;

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
    const warning = hasWisdomToothComplaint(messageText)
      ? " Если есть сильная боль, отек или температура, лучше обратиться быстрее."
      : "";
    if (!isInformationQuestion(messageText) && /((чо|че|чё|что)\s+делать|как\s+быть)/iu.test(String(messageText || ""))) {
      return `Если режутся зубы мудрости, лучше записаться на осмотр к стоматологу-хирургу: врач посмотрит положение зуба и скажет, нужно ли удаление.${warning}`;
    }
    return `Стоимость удаления зуба мудрости зависит от сложности. Точную цену врач скажет после осмотра, могу передать вопрос администратору.${warning}`;
  }

  if (serviceCategory === "tooth_extraction") {
    return "Удаление зуба по стоимости зависит от сложности. Подскажите, какой зуб беспокоит, и я сориентирую по записи или передам вопрос администратору.";
  }

  return `${service || "Услуга"} зависит от ситуации после осмотра. Могу подсказать по записи или передать вопрос администратору.`;
}

function buildUnderstoodDentalTopicReply({ messageText = "", memory = {}, extracted = {} } = {}) {
  const dentalService = detectDentalServiceIntent(messageText);
  const hasPriceSignal = isInformationQuestion(messageText);
  const serviceCategory = extracted.service_category || dentalService.service_category || null;
  const service = extracted.service || dentalService.service || memory.requested_service || "";
  const complaint = extracted.complaint || dentalService.complaint || memory.complaint || "";

  if (!hasPriceSignal && !serviceCategory && !service && !complaint) return null;

  if (serviceCategory || service || complaint || hasPriceSignal) {
    return buildDentalServiceInfoReply({
      service: service || complaint,
      serviceCategory,
      messageText
    });
  }

  return null;
}

function hasWisdomToothComplaint(messageText = "") {
  return Boolean(detectWisdomToothComplaint(messageText));
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

  if (["unknown", "noise", "message"].includes(classifierIntent)) {
    const topicReply = buildUnderstoodDentalTopicReply({ messageText, memory, extracted });
    if (topicReply) return topicReply;
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

  if (classifierIntent === "pricing_question" || classifierIntent === "pricing") {
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
  const missingWithoutConfirmation = missingFields.filter((field) => field !== "consent_to_book");
  const shouldAskConfirmation = shouldRequireBookingConfirmation({
    memory,
    missingFields: missingWithoutConfirmation,
    bookingIntent: context.bookingIntent
  });
  const effectiveMissing = explicitConfirmation
    ? missingWithoutConfirmation
    : (shouldAskConfirmation ? [...new Set([...missingWithoutConfirmation, "consent_to_book"])] : missingWithoutConfirmation);

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

  if (!explicitConfirmation && shouldAskConfirmation) {
    return {
      allowed: false,
      missing_fields: effectiveMissing,
      downgraded_action: "offer_booking",
      reason: "missing_explicit_confirmation"
    };
  }

  if (!explicitConfirmation) {
    return {
      allowed: false,
      missing_fields: effectiveMissing,
      downgraded_action: chooseDowngradedBookingAction(effectiveMissing),
      reason: effectiveMissing.length ? "missing_required_booking_fields" : "missing_explicit_confirmation"
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
  if (missingFields.includes("preferred_doctor")) return "collect_more_info";
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
  if (isBookingConfirmationText(lower)) return true;
  return /(запишите\s+меня|хочу\s+записа|да,\s*запиш|^подходит[!.?\s]*$|подходит,\s*запиш|^давайте[!.?\s]*$|давайте\s+запиш|запишите\s+на|записывайте|оформите\s+запись|фиксируйте\s+запись|подтверждаю\s+запись)/iu.test(lower);
}

function isInformationQuestion(text = "") {
  const lower = String(text || "").toLowerCase();
  return /(по\s+бабк|как\s+по\s+бабк|как\s+по\s+деньг|по\s+деньгам|(?:^|\s)деньги(?:\s|$)|сколько|скок|скока|цена|стоимост|стоить|стоит|прайс|ценник|какие\s+врачи|какой\s+врач|кто\s+врач|когда\s+можно|есть\s+ли\s+врач|консультаци|при[её]м\s+сколько|можно\s+приехать)/iu.test(lower) &&
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

export function postValidateMemoryNameRoles(update = {}, {
  messageText = "",
  payload = {},
  strictPatientSource = true
} = {}) {
  const cleaned = { ...(update || {}) };
  const explicitPatient = extractExplicitPatientName(messageText);
  const doctorMention = findKnownDoctorMention(messageText);

  if (doctorMention && !cleaned.preferred_doctor) {
    cleaned.preferred_doctor = doctorMention.preferredName;
  }

  if (cleaned.patient_name) {
    cleaned.patient_name = normalizeName(cleaned.patient_name);
  }

  if (cleaned.preferred_doctor) {
    cleaned.preferred_doctor = normalizeDoctorName(cleaned.preferred_doctor);
  }

  const patientName = cleaned.patient_name;
  const doctorName = cleaned.preferred_doctor || doctorMention?.preferredName || "";
  if (patientName) {
    const source = resolvePatientNameSource(patientName, {
      explicitPatient,
      payload,
      currentSource: cleaned.patient_name_source
    });
    const patientIsDoctor = Boolean(
      namesReferToSameKnownPerson(patientName, doctorName) ||
      (doctorName && normalizeNameKey(patientName) === normalizeNameKey(doctorName)) ||
      isKnownClinicPersonName(patientName) ||
      isNameInDoctorContext(patientName, messageText)
    );

    if (patientIsDoctor || (strictPatientSource && !source)) {
      delete cleaned.patient_name;
      delete cleaned.patient_name_source;
    } else if (source) {
      cleaned.patient_name_source = source;
    }
  } else {
    delete cleaned.patient_name_source;
  }

  if (cleaned.patient_name && cleaned.preferred_doctor && normalizeNameKey(cleaned.patient_name) === normalizeNameKey(cleaned.preferred_doctor)) {
    delete cleaned.patient_name;
    delete cleaned.patient_name_source;
  }

  return cleaned;
}

function resolvePatientNameSource(patientName = "", { explicitPatient = null, payload = {}, currentSource = null } = {}) {
  if (TRUSTED_PATIENT_NAME_SOURCES.has(currentSource) && currentSource !== "channel_profile") return currentSource;

  if (explicitPatient?.name && normalizeNameKey(explicitPatient.name) === normalizeNameKey(patientName)) {
    return explicitPatient.source;
  }

  const profileName = normalizeChannelProfileName(payload.display_name);
  if (profileName && normalizeNameKey(profileName) === normalizeNameKey(patientName)) {
    return "channel_profile";
  }

  if (currentSource === "channel_profile" && profileName && normalizeNameKey(profileName) === normalizeNameKey(patientName)) {
    return "channel_profile";
  }

  return null;
}

function normalizeDoctorName(value = "") {
  const person = findKnownClinicPersonByName(value);
  if (person?.role === "doctor") return person.preferredName;
  return normalizeName(value);
}

function sanitizeAgentMemoryUpdate(update = {}, messageText = "", payload = {}) {
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

  if (cleaned.phone && !normalizeAppointmentPhone(cleaned.phone)) {
    delete cleaned.phone;
  }

  return postValidateMemoryNameRoles(cleaned, { messageText, payload, strictPatientSource: true });
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

  if (missingFields.includes("preferred_doctor") && !/(врач|доктор|специалист)/iu.test(reply)) {
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

  const name = shortName(getSafePatientName(memory));

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
  const prefix = getSafePatientPrefix(memory, {}, appointmentRequest.patientName);
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
  const name = getSafePatientPrefix(memory);
  const date = formatReplyDate(formatBookingDateForReply(slotConflict.preferred_date), casual);
  return casual
    ? `${name}на ${date} в ${slotConflict.preferred_time} уже занято. Киньте другой день или время, проверю.`
    : `${name}на ${date} в ${slotConflict.preferred_time} уже есть запись. Напишите другой удобный день или время, и я проверю вариант.`;
}

export function buildBookingConfirmedReply({ appointmentRequest, memory, messageText }) {
  const casual = isCasualMessage(messageText);
  const name = shortName(getSafePatientName(memory, {}, appointmentRequest.patientName));
  const service = memory.requested_service || appointmentRequest.requestedService;
  const date = formatBookingDateForReply(memory.preferred_date || appointmentRequest.preferredDate);
  const time = normalizeAppointmentTime(memory.preferred_time || appointmentRequest.preferredTime);
  const doctor = memory.preferred_doctor || appointmentRequest.preferredDoctor;
  const doctorText = doctor ? ` к ${formatDoctorForReply(doctor)}` : "";
  const prefix = name ? `${name}, ` : "";
  const visitText = formatVisitText(service);
  const slot = `${formatReplyDate(date, casual)} в ${time}${doctorText}`;

  return casual
    ? `${prefix}готово, запись ${visitText} ${slot} подтверждена. Напоминание тоже поставила. Если что - пишите сюда.`
    : `${prefix}отлично, запись ${visitText} на ${slot} подтверждена. Напоминание перед визитом создала. Если что-то изменится, просто напишите.`;
}

export function buildBookingProgressReply({ memory, payload, missingFields, messageText, recentMessages = [], baseDate = new Date() }) {
  const casual = isCasualMessage(messageText);
  const prefix = getSafePatientPrefix(memory, payload);
  const service = formatProgressService(memory.requested_service || memory.complaint || "прием");
  const date = memory.preferred_date ? formatBookingDateForReply(memory.preferred_date) : null;
  const time = normalizeAppointmentTime(memory.preferred_time);
  const doctor = memory.preferred_doctor;
  const doctorText = doctor ? ` к ${formatDoctorForReply(doctor)}` : "";
  const ambiguousTime = getAmbiguousAppointmentTimeClarification(messageText);
  const effectiveMissingFields = filterMissingBookingFieldsForReply(missingFields, { memory, payload, recentMessages });

  if (effectiveMissingFields.includes("patient_name")) {
    return casual ? "Как вас зовут?" : "Подскажите, как вас зовут?";
  }

  if (effectiveMissingFields.includes("reason")) {
    return casual
      ? `${prefix}что беспокоит или на какую услугу записать?`
      : `${prefix}подскажите, что беспокоит или на какую услугу хотите записаться?`;
  }

  if (effectiveMissingFields.includes("preferred_date") && effectiveMissingFields.includes("preferred_time")) {
    return casual ? `${prefix}на какой день и время удобно?` : `${prefix}на какой день и время вам удобно записаться?`;
  }

  if (effectiveMissingFields.includes("preferred_date")) {
    return casual ? `${prefix}на какой день удобно?` : `${prefix}на какой день вам удобно записаться?`;
  }

  if (effectiveMissingFields.includes("preferred_time")) {
    if (ambiguousTime) {
      return casual
        ? `${prefix}${ambiguousTime.question}`
        : `${prefix}${ambiguousTime.question} Напишите, пожалуйста, точное время.`;
    }

    return casual ? `${prefix}на какое время удобно?` : `${prefix}на какое время вам удобно записаться?`;
  }

  if (effectiveMissingFields.includes("preferred_doctor")) {
    return casual ? `${prefix}к какому врачу записать?` : `${prefix}подскажите, к какому врачу хотите записаться?`;
  }

  if (effectiveMissingFields.includes("consent_to_book")) {
    const replyDate = memory.preferred_date ? formatBookingProposalDate(memory.preferred_date, casual, baseDate) : (date ? formatReplyDate(date, casual) : null);
    if (replyDate && time) {
      return `${prefix}Могу предложить ${replyDate} в ${time}${doctorText}. Подтверждаете?`;
    }
    return casual
      ? `${prefix}${service}${replyDate ? ` на ${replyDate}` : ""}${time ? ` в ${time}` : ""}${doctorText}. Записать вас?`
      : `${prefix}${service}${replyDate ? ` на ${replyDate}` : ""}${time ? ` в ${time}` : ""}${doctorText}. Подтвердите, записать вас?`;
  }

  return casual
    ? `${prefix}напишите услугу, дату и удобное время.`
    : `${prefix}уточните детали записи: услугу, дату и удобное время.`;
}

function buildActionableBookingCorrectionReply({ memory = {}, payload = {}, missingFields = [], messageText = "" } = {}) {
  const time = normalizeAppointmentTime(memory.preferred_time);
  const date = memory.preferred_date ? formatBookingDateForReply(memory.preferred_date) : null;
  const service = formatProgressService(memory.requested_service || memory.complaint || "прием");
  const doctor = memory.preferred_doctor ? ` к ${formatDoctorForReply(memory.preferred_doctor)}` : "";

  if (missingFields.includes("preferred_time")) {
    const ambiguousTime = getAmbiguousAppointmentTimeClarification(messageText);
    return ambiguousTime
      ? `Извините, уточню время: ${ambiguousTime.question}`
      : buildBookingProgressReply({ memory, payload, missingFields, messageText });
  }

  const understood = time ? `Извините, понял вас: ${time}.` : "Извините, понял вас.";
  if (date || service || doctor) {
    const details = [
      service ? `на ${service}` : null,
      doctor || null,
      date ? `на ${formatReplyDate(date, isCasualMessage(messageText))}` : null,
      time ? `в ${time}` : null
    ].filter(Boolean).join(" ");

    if (missingFields.includes("consent_to_book")) {
      return `${understood} ${details}. Подтвердите, записать вас?`;
    }

    return `${understood} Сейчас проверю возможность записи ${details}.`;
  }

  return `${understood} Продолжим запись.`;
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

function formatDoctorForReply(doctor = "") {
  const normalized = String(doctor || "").trim();
  if (/^дмитрий\s+алексеевич$/iu.test(normalized)) return "Дмитрию Алексеевичу";
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

function formatBookingProposalDate(value, casual = false, baseDate = new Date()) {
  const date = normalizeAppointmentDate(value);
  if (!date) return formatReplyDate(formatBookingDateForReply(value), casual);

  const targetIso = toBookingIsoDate(date);
  const now = baseDate instanceof Date ? baseDate : new Date(baseDate);
  const todayIso = toBookingIsoDate(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
  const tomorrowIso = toBookingIsoDate(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + 1)));

  if (targetIso === todayIso) return "сегодня";
  if (targetIso === tomorrowIso) return "завтра";
  return formatReplyDate(formatBookingDateForReply(value), casual);
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
