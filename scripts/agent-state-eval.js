import assert from "node:assert/strict";
import {
  avoidRepeatedBotReply,
  buildRescheduleCandidateMemory,
  buildRescheduleConfirmationReply,
  buildRescheduleConfirmedReply,
  buildSafeScriptedReply,
  canResumeAiFromHumanTakeover,
  classifyConversationRisk,
  detectComplaintOrAbuse,
  detectConversationIntent,
  detectNoiseMessage,
  isActionableBookingCorrection,
  isConversationInHumanTakeover,
  buildBookingConfirmedReply,
  buildBookingProgressReply,
  mergeMemory,
  mergeBookingState,
  postValidateMemoryNameRoles,
  validateRequestedTimeAgainstWorkingHours,
  validateAppointmentCreation
} from "../agent-api/src/messageService.js";
import {
  getNextReminderSendTime,
  isWithinReminderSendWindow,
  shouldSendReminderForAppointment
} from "../agent-api/src/reminderService.js";
import { isHumanizedReplyAllowed } from "../agent-api/src/agent.js";
import { normalizeStructuredAgentOutput, sanitizeReplyForUser } from "../agent-api/src/replySanitizer.js";

const cancel = detectConversationIntent("не надо переносить, денег нет просто удалите");
assert.equal(cancel.intent, "cancel", "cancel must win over reschedule");
assert.equal(cancel.state, "cancellation_requested");

const reschedule = detectConversationIntent("можно на другое время?");
assert.equal(reschedule.intent, "reschedule", "reschedule must be detected when no cancel phrase exists");

const activeConfirmedAppointment = {
  id: 77,
  status: "confirmed",
  patientName: "Анна",
  phone: "+79000000000",
  requestedService: "гигиена",
  preferredDate: "2026-06-10",
  preferredTime: "11:00",
  preferredDoctor: "Дмитрий Алексеевич"
};
const rescheduleDateDraft = buildRescheduleCandidateMemory({
  baseMemory: {
    status: "appointment_booked",
    preferred_date: "2026-06-10",
    preferred_time: "11:00",
    requested_service: "гигиена",
    preferred_doctor: "Дмитрий Алексеевич"
  },
  activeAppointment: activeConfirmedAppointment,
  deterministicFacts: { preferred_date: "2026-06-17" },
  payload: { display_name: "Анна" }
});
assert.equal(rescheduleDateDraft.preferred_date, "2026-06-17");
assert.equal(rescheduleDateDraft.preferred_time, undefined, "reschedule draft must not reuse old appointment time as a new candidate");
assert.equal(rescheduleDateDraft.pending_reschedule.status, "collecting_datetime");

const rescheduleReadyDraft = buildRescheduleCandidateMemory({
  baseMemory: rescheduleDateDraft,
  activeAppointment: activeConfirmedAppointment,
  deterministicFacts: { preferred_time: "15:00" },
  payload: { display_name: "Анна" }
});
assert.equal(rescheduleReadyDraft.preferred_date, "2026-06-17");
assert.equal(rescheduleReadyDraft.preferred_time, "15:00");
assert.equal(rescheduleReadyDraft.pending_reschedule.status, "awaiting_confirmation");
assert.match(
  buildRescheduleConfirmationReply({ memory: rescheduleReadyDraft, payload: { display_name: "Анна" }, messageText: "на 15:00" }),
  /17\.06\.2026.*15:00.*Подтверждаете/iu
);
assert.match(
  buildRescheduleConfirmedReply({
    appointmentRequest: { ...activeConfirmedAppointment, preferredDate: "2026-06-17", preferredTime: "15:00" },
    memory: rescheduleReadyDraft,
    payload: { display_name: "Анна" },
    messageText: "да"
  }),
  /перенес/iu
);

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

const humanRequest = classifyConversationRisk({ userMessage: "позовите администратора, хочу с человеком" });
assert.equal(humanRequest.should_handoff, true, "explicit human/admin request must handoff");

const angryComplaint = classifyConversationRisk({ userMessage: "вы что ебанулись почему записали меня" });
assert.equal(angryComplaint.should_handoff, true);

const actionableCorrection = "5 дня я имею ввиду 17 00 вы чо тупите то ебать";
assert.equal(isActionableBookingCorrection(actionableCorrection, {
  memory: { requested_service: "профессиональная гигиена", preferred_date: "2026-06-05", preferred_doctor: "Дмитрий Алексеевич" }
}), true);
const mildCorrectionRisk = classifyConversationRisk({
  userMessage: actionableCorrection,
  context: {
    memory: { requested_service: "профессиональная гигиена", preferred_date: "2026-06-05", preferred_doctor: "Дмитрий Алексеевич" }
  }
});
assert.equal(mildCorrectionRisk.should_handoff, false, "mild aggression with useful booking correction must not handoff");
assert.equal(canResumeAiFromHumanTakeover("Хочу завтра на чистку", {
  memory: { status: "handoff_required", patient_name: "Ярослав" },
  latestHandoff: { reason: "aggression_with_complaint" }
}), true, "safe fresh booking request must resume AI after auto handoff");
assert.equal(canResumeAiFromHumanTakeover("позовите администратора", {
  memory: { status: "handoff_required" },
  latestHandoff: { reason: "aggression_with_complaint" }
}), false, "explicit admin request must stay in handoff");
assert.equal(canResumeAiFromHumanTakeover("Хочу завтра на чистку", {
  memory: { status: "handoff_required" },
  latestHandoff: { reason: "legal_threat" }
}), false, "legal handoff must not auto-resume");

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

const bookingScenarioMemory = {
  requested_service: "лечение зубов",
  preferred_doctor: "Дмитрий Алексеевич",
  preferred_date: "2026-06-06",
  preferred_time: "17:00",
  booking_state: {
    intent: "book_appointment",
    service: "лечение зубов",
    doctor: "Дмитрий Алексеевич",
    date: "2026-06-06",
    time: "17:00",
    time_constraint: "after_17:00",
    status: "awaiting_confirmation",
    missing_fields: ["confirmation"],
    asked_fields: []
  }
};
const roleBugCorrection = postValidateMemoryNameRoles({
  patient_name: "Дмитрий Алексеевич",
  preferred_doctor: "Дмитрий Алексеевич",
  requested_service: "консультация стоматолога"
}, {
  messageText: "хочу на консультацию к Дмитрию Алексеевичу",
  payload: { display_name: "Ярослав" }
});
assert.equal(roleBugCorrection.patient_name, undefined);
assert.equal(roleBugCorrection.patient_name_source, undefined);
assert.equal(roleBugCorrection.preferred_doctor, "Дмитрий Алексеевич");
assert.equal(roleBugCorrection.requested_service, "консультация стоматолога");

const explicitPatientAndDoctor = postValidateMemoryNameRoles({
  patient_name: "Ярослав",
  preferred_doctor: "Дмитрий Алексеевич"
}, {
  messageText: "меня зовут Ярослав, хочу к Дмитрию Алексеевичу"
});
assert.equal(explicitPatientAndDoctor.patient_name, "Ярослав");
assert.equal(explicitPatientAndDoctor.patient_name_source, "explicit_user_name");
assert.equal(explicitPatientAndDoctor.preferred_doctor, "Дмитрий Алексеевич");

const doctorMentionOnly = postValidateMemoryNameRoles({
  patient_name: "Дмитрий Алексеевич"
}, {
  messageText: "слышал у вас врач Дмитрий Алексеевич хороший"
});
assert.equal(doctorMentionOnly.patient_name, undefined);
assert.equal(doctorMentionOnly.preferred_doctor, "Дмитрий Алексеевич");

const explicitPatientNamedDmitry = postValidateMemoryNameRoles({
  patient_name: "Дмитрий"
}, {
  messageText: "запишите на имя Дмитрий"
});
assert.equal(explicitPatientNamedDmitry.patient_name, "Дмитрий");
assert.equal(explicitPatientNamedDmitry.patient_name_source, "explicit_user_name");
assert.equal(explicitPatientNamedDmitry.preferred_doctor, undefined);

const doctorPrefixedReply = buildBookingProgressReply({
  memory: {
    requested_service: "консультация стоматолога",
    preferred_doctor: "Дмитрий Алексеевич",
    patient_name: "Дмитрий Алексеевич"
  },
  payload: {},
  missingFields: ["preferred_date", "preferred_time"],
  messageText: "хочу на консультацию к Дмитрию Алексеевичу"
});
assert.doesNotMatch(doctorPrefixedReply, /^Дмитрий,/u);

const slotOffer = buildBookingProgressReply({
  memory: bookingScenarioMemory,
  payload: { display_name: "Ярослав", max_user_id: "max_chat_445055049" },
  missingFields: ["consent_to_book"],
  messageText: "хочу начать лечить зубы, к Дмитрию Алексеевичу, завтра после пяти",
  baseDate: new Date("2026-06-05T10:00:00+05:00")
});
assert.match(slotOffer, /Могу предложить завтра в 17:00 к Дмитрию Алексеевичу\. Подтверждаете\?/u);
assert.doesNotMatch(slotOffer, /Что беспокоит|На какое время удобно|К какому врачу/iu);

const confirmedAfterYes = validateAppointmentCreation(
  { action: "create_appointment" },
  { ...bookingScenarioMemory, consent_to_book: true, patient_name: "Ярослав" },
  {
    bookingIntent: true,
    messageText: "подтверждаю да",
    missingFields: [],
    conversationState: "waiting_booking_confirmation"
  }
);
assert.equal(confirmedAfterYes.allowed, true, "awaiting confirmation + yes must create/confirm booking");

const confirmationReply = buildBookingConfirmedReply({
  appointmentRequest: {
    patientName: "Ярослав",
    requestedService: "лечение зубов",
    preferredDate: "2026-06-06",
    preferredTime: "17:00",
    preferredDoctor: "Дмитрий Алексеевич"
  },
  memory: { ...bookingScenarioMemory, consent_to_book: true, patient_name: "Ярослав" },
  messageText: "подтверждаю да"
});
assert.match(confirmationReply, /06\.06\.2026 в 17:00 к Дмитрию Алексеевичу/u);
assert.match(confirmationReply, /подтверждена/u);
assert.doesNotMatch(confirmationReply, /Что беспокоит|На какое время удобно|К какому врачу/iu);

const preservedBookingState = mergeBookingState(
  { service: "лечение зубов", doctor: "Дмитрий Алексеевич", date: "2026-06-06", time: "17:00", status: "awaiting_confirmation" },
  { service: null, doctor: "", date: undefined, missing_fields: ["confirmation"] }
);
assert.equal(preservedBookingState.service, "лечение зубов");
assert.equal(preservedBookingState.doctor, "Дмитрий Алексеевич");
assert.equal(preservedBookingState.date, "2026-06-06");
assert.equal(preservedBookingState.time, "17:00");
assert.deepEqual(preservedBookingState.missing_fields, ["confirmation"]);

const clearedDoctorState = mergeBookingState(
  {
    doctor: "Дмитрий Алексеевич",
    date: "2026-06-06",
    time: "17:00",
    status: "awaiting_confirmation",
    missing_fields: ["confirmation"]
  },
  { clear_fields: ["doctor"] }
);
assert.equal(clearedDoctorState.doctor, undefined, "explicit clear_fields must remove doctor from booking_state");
assert.equal(clearedDoctorState.date, "2026-06-06");
assert.equal(clearedDoctorState.status, "collecting_info");
assert.ok(clearedDoctorState.missing_fields.includes("doctor"));

const clearedDoctorMemory = mergeMemory(
  {
    preferred_doctor: "Дмитрий Алексеевич",
    preferred_date: "2026-06-06",
    preferred_time: "17:00",
    consent_to_book: true,
    status: "waiting_booking_confirmation",
    booking_state: {
      doctor: "Дмитрий Алексеевич",
      date: "2026-06-06",
      time: "17:00",
      status: "awaiting_confirmation",
      missing_fields: ["confirmation"]
    }
  },
  { clear_fields: ["preferred_doctor"] }
);
assert.equal(clearedDoctorMemory.preferred_doctor, undefined, "explicit clear_fields must remove flat doctor");
assert.equal(clearedDoctorMemory.booking_state.doctor, undefined, "explicit clear_fields must remove nested doctor");
assert.equal(clearedDoctorMemory.consent_to_book, undefined, "changing core slot must invalidate old confirmation");
assert.equal(clearedDoctorMemory.status, "collecting_booking_data");
assert.equal(clearedDoctorMemory.booking_state.status, "collecting_info");
assert.equal(clearedDoctorMemory.preferred_date, "2026-06-06");
assert.equal(clearedDoctorMemory.preferred_time, "17:00");

const normalizedClearPatch = normalizeStructuredAgentOutput(JSON.stringify({
  reply: "Поняла, к Дмитрию не записываю. Подскажите, к какому врачу удобно?",
  intent: "booking",
  action: "collect_more_info",
  memory_patch: {
    clear_fields: ["preferred_doctor"],
    status: "collecting_booking_data"
  }
}), "нет, не к Дмитрию, к другому врачу");
assert.deepEqual(normalizedClearPatch.memory_update.clear_fields, ["preferred_doctor"]);

assert.equal(isConversationInHumanTakeover({ status: "human_takeover" }), true);
assert.equal(isConversationInHumanTakeover({ status: "handoff_required" }), true);
assert.equal(isConversationInHumanTakeover({ status: "active" }), false);

console.log("agent state eval passed");
