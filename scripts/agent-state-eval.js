import assert from "node:assert/strict";
import {
  avoidRepeatedBotReply,
  buildSafeScriptedReply,
  classifyConversationRisk,
  detectComplaintOrAbuse,
  detectConversationIntent,
  detectNoiseMessage,
  isConversationInHumanTakeover,
  validateRequestedTimeAgainstWorkingHours,
  validateAppointmentCreation
} from "../agent-api/src/messageService.js";
import {
  getNextReminderSendTime,
  isWithinReminderSendWindow,
  shouldSendReminderForAppointment
} from "../agent-api/src/reminderService.js";
import { isHumanizedReplyAllowed } from "../agent-api/src/agent.js";
import { sanitizeReplyForUser } from "../agent-api/src/replySanitizer.js";

const cancel = detectConversationIntent("не надо переносить, денег нет просто удалите");
assert.equal(cancel.intent, "cancel", "cancel must win over reschedule");
assert.equal(cancel.state, "cancellation_requested");

const reschedule = detectConversationIntent("можно на другое время?");
assert.equal(reschedule.intent, "reschedule", "reschedule must be detected when no cancel phrase exists");

const angry = detectConversationIntent("зачем вы меня записали, я не просил");
assert.equal(angry.intent, "cancel");
assert.equal(angry.shouldHandoff, true, "wrong booking complaint must require handoff");

const abuse = detectConversationIntent("вы чо ебланы");
assert.equal(abuse.intent, "abuse", "targeted abuse must be handled by guard, not sanitizer fallback");
assert.equal(abuse.shouldHandoff, true);

const rudeNoise = detectConversationIntent("бля");
assert.equal(rudeNoise.intent, "noise", "standalone profanity must be safe business noise reply");
assert.equal(rudeNoise.shouldHandoff, false);

assert.equal(detectComplaintOrAbuse("вы чо ебланы").detected, true);
assert.equal(detectNoiseMessage("????").detected, true);

const blocked = validateAppointmentCreation(
  { action: "create_appointment" },
  { status: "cancellation_requested", consent_to_book: true, patient_name: "Анна", complaint: "гигиена", preferred_date: "2026-06-17", preferred_time: "15:00" },
  { bookingIntent: true, messageText: "удалите", missingFields: [] }
);
assert.equal(blocked.allowed, false, "cancelled state must block create_appointment");
assert.equal(blocked.reason, "cancel_or_handoff_state_blocks_booking");

const cancelReply = buildSafeScriptedReply({
  intent: "cancel",
  action: "cancel_appointment",
  state: "cancellation_requested",
  activeAppointment: { status: "confirmed" },
  memory: { patient_name: "Карина" }
});
assert.match(cancelReply, /останов|отмен/iu);
assert.doesNotMatch(cancelReply, /жд[её]м|напоминание.*создан|готово.*запис/iu);

const greetingReply = buildSafeScriptedReply({ intent: "greeting", state: "idle" });
assert.match(greetingReply, /лечени|стоимост|запис/iu);
assert.doesNotMatch(greetingReply, /я могу помочь с записью на прием или ответить/iu);

const abuseReply = buildSafeScriptedReply({ intent: "abuse", state: "handoff_required" });
assert.match(abuseReply, /ситуация неприятная|передам администратору/iu);
assert.doesNotMatch(abuseReply, /могу помочь с услугами клиники, ценами или записью/iu);

const validAbuseReply = "Понимаю, ситуация неприятная. Автоматические действия остановлю и передам администратору.";
assert.equal(
  sanitizeReplyForUser(validAbuseReply, { userMessage: "вы чо ебланы" }),
  validAbuseReply,
  "sanitizer must not override a valid abuse/complaint reply just because user message is rude"
);

const repeatedFallback = avoidRepeatedBotReply(
  "Извините, не совсем понял сообщение. Могу подсказать по услугам, стоимости или записи.",
  [{ direction: "outgoing", role: "assistant", text: "Извините, не совсем понял сообщение. Могу подсказать по услугам, стоимости или записи." }]
);
assert.notEqual(
  repeatedFallback,
  "Извините, не совсем понял сообщение. Могу подсказать по услугам, стоимости или записи.",
  "same fallback must not be repeated twice in a row"
);

const reminderReply = buildSafeScriptedReply({ intent: "greeting", state: "appointment_booked", afterReminder: true });
assert.match(reminderReply, /напоминан|изменить время/iu);

assert.equal(shouldSendReminderForAppointment({ status: "confirmed" }), true);
assert.equal(shouldSendReminderForAppointment({ status: "cancelled" }), false);
assert.equal(shouldSendReminderForAppointment({ status: "needs_admin_review" }), false);

const night = new Date("2026-05-27T01:30:00+03:00");
assert.equal(isWithinReminderSendWindow(night, { start: "09:00", end: "21:00", timezone: "Europe/Moscow" }), false);
const delayed = getNextReminderSendTime(night, { start: "09:00", end: "21:00", timezone: "Europe/Moscow" });
assert.equal(delayed.toISOString(), "2026-05-27T06:00:00.000Z", "night reminder must move to 09:00 Moscow time");

const daytime = new Date("2026-05-27T12:30:00+03:00");
assert.equal(isWithinReminderSendWindow(daytime, { start: "09:00", end: "21:00", timezone: "Europe/Moscow" }), true);

assert.equal(isHumanizedReplyAllowed({
  safeReply: "Поняла, запись создавать не буду. Передам администратору.",
  candidate: "Поняла вас. Запись создавать не буду, передам администратору.",
  action: "cancel_appointment",
  state: "cancellation_requested"
}), true);

assert.equal(isHumanizedReplyAllowed({
  safeReply: "Поняла, запись создавать не буду. Передам администратору.",
  candidate: "Готово, записала вас на завтра, ждем.",
  action: "cancel_appointment",
  state: "cancellation_requested"
}), false, "humanizer must not turn cancel into booking");

const simplePriceQuestion = classifyConversationRisk({ userMessage: "сколько стоит консультация?" });
assert.equal(simplePriceQuestion.should_handoff, false, "simple price question must not handoff");
assert.equal(simplePriceQuestion.risk_type, "none");

const priceObjection = classifyConversationRisk({ userMessage: "почему так дорого, у других дешевле" });
assert.equal(priceObjection.risk_type, "price_objection", "price objection must be classified");
assert.equal(priceObjection.should_handoff, false, "first price objection should be handled softly");

const repeatedPriceObjection = classifyConversationRisk({
  userMessage: "ну дорого же",
  context: {
    recentMessages: [
      { direction: "incoming", text: "почему так дорого" }
    ]
  }
});
assert.equal(repeatedPriceObjection.should_handoff, true, "repeated price objection must reach handoff threshold");

const reviewThreat = classifyConversationRisk({ userMessage: "напишу плохой отзыв в 2гис" });
assert.equal(reviewThreat.risk_type, "bad_review_threat");
assert.equal(reviewThreat.should_handoff, true);

const legalThreat = classifyConversationRisk({ userMessage: "я пойду в суд и напишу жалобу" });
assert.equal(legalThreat.risk_type, "legal_threat");
assert.equal(legalThreat.should_handoff, true);

const angryComplaint = classifyConversationRisk({ userMessage: "вы что ебанулись почему записали меня" });
assert.equal(angryComplaint.should_handoff, true);

const fiveAm = validateRequestedTimeAgainstWorkingHours({
  date: "2026-05-25",
  time: "05:00"
});
assert.equal(fiveAm.valid, false, "5am appointment must be blocked");
assert.equal(fiveAm.reason, "outside_working_hours");

const sunday = validateRequestedTimeAgainstWorkingHours({
  date: "2026-05-31",
  time: "12:00"
});
assert.equal(sunday.valid, false, "Sunday appointment must be blocked by default");
assert.equal(sunday.reason, "clinic_closed");

const validHours = validateRequestedTimeAgainstWorkingHours({
  date: "2026-05-25",
  time: "12:00"
});
assert.equal(validHours.valid, true, "working hours appointment must pass");

const blockedByHours = validateAppointmentCreation(
  { action: "create_appointment" },
  { consent_to_book: true, patient_name: "Анна", complaint: "гигиена", preferred_date: "2026-05-25", preferred_time: "05:00" },
  {
    bookingIntent: true,
    messageText: "да запишите на 5 утра",
    missingFields: [],
    workingHoursValidation: fiveAm
  }
);
assert.equal(blockedByHours.allowed, false);
assert.equal(blockedByHours.reason, "outside_working_hours");

assert.equal(isConversationInHumanTakeover({ status: "human_takeover" }), true);
assert.equal(isConversationInHumanTakeover({ status: "handoff_required" }), true);
assert.equal(isConversationInHumanTakeover({ status: "active" }), false);

console.log("agent state eval passed");
