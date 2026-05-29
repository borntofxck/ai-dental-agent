import dotenv from "dotenv";

dotenv.config({ path: new URL("../../.env", import.meta.url) });

export const config = {
  port: Number(process.env.AGENT_API_PORT || 3002),
  groqApiKey: process.env.GROQ_API_KEY,
  groqModel: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
  groqMaxTokens: Number(process.env.GROQ_MAX_TOKENS || 650),
  clinicName: process.env.CLINIC_NAME || "DentalCare",
  clinicPhone: process.env.CLINIC_PHONE || "",
  clinicAddress: process.env.CLINIC_ADDRESS || "",
  reminderSendWindowStart: process.env.REMINDER_SEND_WINDOW_START || "09:00",
  reminderSendWindowEnd: process.env.REMINDER_SEND_WINDOW_END || "21:00",
  reminderTimezone: process.env.REMINDER_TIMEZONE || "Europe/Moscow"
};
