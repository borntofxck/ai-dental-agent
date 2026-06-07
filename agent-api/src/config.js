import dotenv from "dotenv";

dotenv.config({ path: new URL("../../.env", import.meta.url) });

function parseJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch (error) {
    console.warn(`Invalid ${name}, using defaults:`, error.message);
    return fallback;
  }
}

const defaultHandoffRules = {
  price_objection_rounds_before_handoff: 2,
  handoff_on_bad_review_threat: true,
  handoff_on_aggression: true,
  handoff_on_discount_request: true,
  handoff_on_medical_risk: true,
  handoff_on_reputation_risk: true,
  handoff_on_legal_threat: true,
  handoff_on_wrong_booking_complaint: true
};

const defaultWorkingHours = {
  timezone: "Europe/Moscow",
  days: {
    monday: { open: "09:00", close: "20:00" },
    tuesday: { open: "09:00", close: "20:00" },
    wednesday: { open: "09:00", close: "20:00" },
    thursday: { open: "09:00", close: "20:00" },
    friday: { open: "09:00", close: "20:00" },
    saturday: { open: "09:00", close: "20:00" },
    sunday: null
  }
};

const envHandoffRules = parseJsonEnv("HANDOFF_RULES_JSON", {});
const envWorkingHours = parseJsonEnv("WORKING_HOURS_JSON", defaultWorkingHours);

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

export const config = {
  port: Number(process.env.AGENT_API_PORT || 3002),
  groqApiKey: process.env.GROQ_API_KEY,
  groqModel: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
  classifierModel: process.env.CLASSIFIER_MODEL || process.env.GROQ_CLASSIFIER_MODEL || "llama-3.1-8b-instant",
  humanizerModel: process.env.HUMANIZER_MODEL || process.env.GROQ_HUMANIZER_MODEL || "llama-3.1-8b-instant",
  complexModel: process.env.COMPLEX_MODEL || process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
  complexModelEnabled: boolEnv("COMPLEX_MODEL_ENABLED", true),
  groqMaxTokens: Number(process.env.GROQ_MAX_TOKENS || 650),
  classifierMaxTokens: Number(process.env.CLASSIFIER_MAX_TOKENS || 450),
  humanizerMaxTokens: Number(process.env.HUMANIZER_MAX_TOKENS || 140),
  humanizerTemperature: Number(process.env.HUMANIZER_TEMPERATURE || 0.35),
  humanizerEnabled: boolEnv("HUMANIZER_ENABLED", true),
  humanizerOnlyForComplex: boolEnv("HUMANIZER_ONLY_FOR_COMPLEX", true),
  humanizerSkipSimple: boolEnv("HUMANIZER_SKIP_SIMPLE", true),
  maxClassifierInputTokens: Number(process.env.MAX_CLASSIFIER_INPUT_TOKENS || 2000),
  maxHumanizerInputTokens: Number(process.env.MAX_HUMANIZER_INPUT_TOKENS || 800),
  maxLastMessages: Number(process.env.MAX_LAST_MESSAGES || 6),
  maxMemoryChars: Number(process.env.MAX_MEMORY_CHARS || 1000),
  maxContextChars: Number(process.env.MAX_CONTEXT_CHARS || 4000),
  clinicName: process.env.CLINIC_NAME || "DentalCare",
  clinicPhone: process.env.CLINIC_PHONE || "",
  clinicAddress: process.env.CLINIC_ADDRESS || "",
  adminUsername: process.env.ADMIN_USERNAME || "admin",
  adminPassword: process.env.ADMIN_PASSWORD || "",
  adminSessionSecret: process.env.ADMIN_SESSION_SECRET || "",
  adminSessionTtlHours: Number(process.env.ADMIN_SESSION_TTL_HOURS || 12),
  adminCookieSecure: boolEnv("ADMIN_COOKIE_SECURE", false),
  agentApiKey: process.env.AGENT_API_KEY || "",
  reminderSendWindowStart: process.env.REMINDER_SEND_WINDOW_START || "09:00",
  reminderSendWindowEnd: process.env.REMINDER_SEND_WINDOW_END || "21:00",
  reminderTimezone: process.env.REMINDER_TIMEZONE || "Europe/Moscow",
  handoffRules: {
    ...defaultHandoffRules,
    ...envHandoffRules
  },
  workingHours: {
    ...defaultWorkingHours,
    ...envWorkingHours,
    days: {
      ...defaultWorkingHours.days,
      ...(envWorkingHours.days || {})
    }
  }
};
