import { parseJsonObject } from "./json.js";

export const SAFE_USER_FALLBACK = "Подскажите, пожалуйста, что вас интересует: услуга, цена или запись на прием?";

const allowedIntents = new Set([
  "booking",
  "pricing",
  "service_question",
  "reschedule",
  "cancel",
  "complaint",
  "abuse",
  "handoff",
  "unknown"
]);

const legacyIntentMap = {
  book_appointment: "booking",
  price_question: "pricing",
  consultation: "service_question",
  clarification: "unknown",
  other: "unknown"
};

const allowedActions = new Set([
  "none",
  "answer_question",
  "provide_info",
  "offer_booking",
  "collect_more_info",
  "collect_name",
  "collect_phone",
  "collect_datetime",
  "create_appointment",
  "reschedule_appointment",
  "cancel_appointment",
  "handoff_to_admin",
  "send_reminder",
  "reactivation"
]);

const allowedUrgency = new Set(["low", "medium", "high"]);
const allowedRiskLevels = new Set(["low", "medium", "high"]);
const allowedRiskTypes = new Set([
  "none",
  "price_objection",
  "aggression",
  "bad_review_threat",
  "reputation_risk",
  "discount_request",
  "medical_risk",
  "wrong_booking_complaint",
  "legal_threat"
]);

const legacyUrgencyMap = {
  normal: "medium",
  urgent: "high"
};

const internalPatterns = [
  /проверяю\s+данные/iu,
  /зафиксировал[аи]?/iu,
  /сохраняю/iu,
  /передаю\s+в\s+систем/iu,
  /\bmemory\b/iu,
  /\bmemory_patch\b/iu,
  /\bmemory_update\b/iu,
  /\bintent\b/iu,
  /\baction\b/iu,
  /\bhandoff\b/iu,
  /\btool\b/iu,
  /\bjson\b/iu,
  /\bsystem\b/iu,
  /\bassistant\b/iu,
  /\breasoning\b/iu,
  /\bstatus\b/iu,
  /tool_calls?/iu,
  /```/
];

const provocationPatterns = [
  /минет/iu,
  /секс/iu,
  /орал/iu,
  /порно/iu,
  /хули/iu,
  /бля/iu,
  /нах/iu,
  /хуй/iu,
  /пизд/iu,
  /еба/iu,
  /ёба/iu
];

export function normalizeStructuredAgentOutput(raw, userMessage = "") {
  const parsed = parseRawOutput(raw);
  const memoryPatch = normalizeMemoryPatch(parsed.memory_patch || parsed.memory_update || {});
  const reply = sanitizeReplyForUser(parsed.reply ?? raw, { userMessage });
  const intent = normalizeIntent(parsed.intent);
  const action = normalizeAction(parsed.action);
  const urgency = normalizeUrgency(parsed.urgency);

  return {
    reply,
    intent,
    sub_intent: cleanPatchValue(parsed.sub_intent),
    confidence: normalizeConfidence(parsed.confidence),
    extracted: normalizeClassifierExtracted(parsed.extracted || {}),
    action,
    safe_next_action: cleanPatchValue(parsed.safe_next_action || action),
    requires_clarification: Boolean(parsed.requires_clarification),
    clarification_question: cleanPatchValue(parsed.clarification_question),
    classifier_reason: cleanPatchValue(parsed.reason),
    should_handoff: Boolean(parsed.should_handoff),
    handoff_reason: parsed.handoff_reason || null,
    urgency,
    risk: normalizeRisk(parsed.risk || {}),
    memory_patch: memoryPatch,
    pipeline_events: Array.isArray(parsed.pipeline_events) ? parsed.pipeline_events : [],
    // Backward-compatible fields used by the current booking workflow.
    memory_update: toLegacyMemoryUpdate(memoryPatch, parsed.memory_update || {}),
    should_create_appointment_request: action === "create_appointment" || Boolean(parsed.should_create_appointment_request)
  };
}

function normalizeConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(1, number));
}

function normalizeClassifierExtracted(value = {}) {
  const extracted = value && typeof value === "object" ? value : {};
  return {
    name: cleanPatchValue(extracted.name),
    phone: cleanPatchValue(extracted.phone),
    service: cleanPatchValue(extracted.service),
    service_category: cleanPatchValue(extracted.service_category),
    complaint: cleanPatchValue(extracted.complaint),
    date: cleanPatchValue(extracted.date),
    relative_date: cleanPatchValue(extracted.relative_date),
    time: cleanPatchValue(extracted.time),
    doctor: cleanPatchValue(extracted.doctor),
    appointment_reference: cleanPatchValue(extracted.appointment_reference)
  };
}

export function sanitizeReplyForUser(raw, { userMessage = "" } = {}) {
  const parsed = parseRawOutput(raw);
  let reply = typeof parsed.reply === "string" ? parsed.reply : String(raw ?? "");
  reply = stripArtifacts(reply);

  if (!reply || isSuspiciousReply(reply)) {
    console.warn(JSON.stringify({
      event: "unsafe_reply_sanitized",
      reason: !reply ? "empty_reply" : "suspicious_reply"
    }));
    return SAFE_USER_FALLBACK;
  }

  return reply;
}

export function isProvocationOrNoise(text = "") {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return true;

  const compact = normalized.replace(/[?!.,\s]/g, "");
  if (!compact) return true;
  if (/^[?!.]{3,}$/u.test(normalized)) return true;
  if (compact.length <= 2 && !/[а-яёa-z0-9]/iu.test(compact)) return true;
  if (provocationPatterns.some((pattern) => pattern.test(normalized))) return true;

  return false;
}

export function isSuspiciousReply(reply = "") {
  const text = String(reply || "").trim();
  if (!text) return true;
  if (looksLikeJson(text)) return true;
  if (internalPatterns.some((pattern) => pattern.test(text))) return true;
  return false;
}

function parseRawOutput(raw) {
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;

  const text = String(raw || "").trim();
  const parsed = parseJsonObject(text);
  if (parsed && typeof parsed === "object") return parsed;

  return { reply: text };
}

function stripArtifacts(value = "") {
  return String(value)
    .replace(/```(?:json)?/giu, "")
    .replace(/```/gu, "")
    .replace(/^\s*(?:reply|ответ)\s*[:=-]\s*/iu, "")
    .replace(/^["'«]+|["'»]+$/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function looksLikeJson(text = "") {
  const trimmed = String(text || "").trim();
  if (!trimmed) return false;
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return true;
  }
  return /"reply"\s*:|"intent"\s*:|"action"\s*:|"memory_patch"\s*:/iu.test(trimmed);
}

function normalizeIntent(value) {
  const raw = String(value || "unknown").trim();
  const mapped = legacyIntentMap[raw] || raw;
  return allowedIntents.has(mapped) ? mapped : "unknown";
}

function normalizeAction(value) {
  const raw = String(value || "none").trim();
  return allowedActions.has(raw) ? raw : "none";
}

function normalizeUrgency(value) {
  const raw = String(value || "low").trim();
  const mapped = legacyUrgencyMap[raw] || raw;
  return allowedUrgency.has(mapped) ? mapped : "low";
}

function normalizeRisk(value = {}) {
  const risk = value && typeof value === "object" ? value : {};
  const riskLevel = String(risk.risk_level || "low").trim();
  const riskType = String(risk.risk_type || "none").trim();

  return {
    risk_level: allowedRiskLevels.has(riskLevel) ? riskLevel : "low",
    risk_type: allowedRiskTypes.has(riskType) ? riskType : "none",
    should_handoff: Boolean(risk.should_handoff),
    reason: cleanPatchValue(risk.reason)
  };
}

function normalizeMemoryPatch(value = {}) {
  const patch = value && typeof value === "object" ? value : {};
  return {
    name: cleanPatchValue(patch.name ?? patch.patient_name),
    phone: cleanPatchValue(patch.phone),
    service: cleanPatchValue(patch.service ?? patch.requested_service),
    complaint: cleanPatchValue(patch.complaint),
    preferred_date: cleanPatchValue(patch.preferred_date),
    preferred_time: cleanPatchValue(patch.preferred_time),
    status: cleanPatchValue(patch.status)
  };
}

function cleanPatchValue(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function toLegacyMemoryUpdate(memoryPatch, legacy = {}) {
  const update = { ...(legacy || {}) };

  if (memoryPatch.name) update.patient_name = memoryPatch.name;
  if (memoryPatch.phone) update.phone = memoryPatch.phone;
  if (memoryPatch.service) update.requested_service = memoryPatch.service;
  if (memoryPatch.complaint) update.complaint = memoryPatch.complaint;
  if (memoryPatch.preferred_date) update.preferred_date = memoryPatch.preferred_date;
  if (memoryPatch.preferred_time) update.preferred_time = memoryPatch.preferred_time;
  if (memoryPatch.status) update.status = memoryPatch.status;

  return Object.fromEntries(
    Object.entries(update).filter(([, value]) => value !== null && value !== undefined && value !== "")
  );
}
