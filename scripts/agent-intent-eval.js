import assert from "node:assert/strict";
import {
  applyHardSafetyOverrides,
  buildSafeScriptedReply,
  detectAmbiguousDeleteIntent,
  detectConversationIntent,
  detectDentalServiceIntent,
  detectExplicitAppointmentCancel,
  validateAppointmentCreation
} from "../agent-api/src/messageService.js";
import {
  extractBookingFacts,
  getMissingAppointmentFields,
  isBookingIntent,
  normalizeBookingMemory
} from "../agent-api/src/bookingParser.js";
import { classifyUserIntentWithLLM } from "../agent-api/src/agent.js";
import { config } from "../agent-api/src/config.js";

const baseDate = new Date("2026-05-27T10:00:00+05:00");
const payload = { max_user_id: "max_test", display_name: "Ярослав" };

const wisdom = detectConversationIntent("нужно удалить зуб мудрости");
assert.equal(wisdom.intent, "booking_request", "wisdom tooth extraction must not be cancel");
assert.equal(wisdom.service_category, "wisdom_tooth_extraction");
assert.notEqual(wisdom.action, "cancel_appointment");

const wisdomTomorrow = detectConversationIntent("нужно удалить зуб мудрости и завтра думаю удобно бы");
assert.equal(wisdomTomorrow.intent, "booking_request");
assert.equal(wisdomTomorrow.extracted.relative_date, "tomorrow");
assert.ok(["collect_time", "check_slot", "collect_datetime"].includes(wisdomTomorrow.safe_next_action));
assert.notEqual(wisdomTomorrow.state, "cancellation_requested");

const correctedMistakenCancel = applyHardSafetyOverrides({
  agentResult: {
    intent: "cancel",
    action: "cancel_appointment",
    should_handoff: true,
    handoff_reason: "model_confused_delete_tooth",
    memory_update: { status: "cancellation_requested" },
    memory_patch: { status: "cancellation_requested" }
  },
  guard: wisdomTomorrow,
  appointmentValidation: { downgraded_action: "collect_datetime" }
});
assert.equal(correctedMistakenCancel.agentResult.intent, "booking", "code must correct LLM cancel mistake for tooth extraction");
assert.equal(correctedMistakenCancel.agentResult.action, "collect_datetime");
assert.equal(correctedMistakenCancel.agentResult.should_handoff, false);
assert.equal(correctedMistakenCancel.agentResult.memory_update.status, "collecting_booking_data");
assert.ok(correctedMistakenCancel.events.some((event) => event.reason === "dental_service_not_cancel"));

const deleteAppointment = detectConversationIntent("удалите запись");
assert.equal(deleteAppointment.intent, "cancel");
assert.equal(deleteAppointment.action, "cancel_appointment");

const blockedWrongCreate = applyHardSafetyOverrides({
  agentResult: {
    intent: "booking",
    action: "create_appointment",
    should_create_appointment_request: true,
    memory_update: { status: "waiting_booking_confirmation" },
    memory_patch: { status: "waiting_booking_confirmation" }
  },
  guard: deleteAppointment
});
assert.equal(blockedWrongCreate.agentResult.action, "cancel_appointment", "cancel hard guard must block model create_appointment");
assert.equal(blockedWrongCreate.agentResult.should_create_appointment_request, false);

const deleteTooth = detectConversationIntent("удалите зуб");
assert.equal(deleteTooth.intent, "booking_request");
assert.equal(deleteTooth.service_category, "tooth_extraction");
assert.notEqual(deleteTooth.intent, "cancel");

const priceWisdom = detectConversationIntent("скок стоит удалить зуб мудрости");
assert.equal(priceWisdom.intent, "pricing_question");
assert.equal(priceWisdom.service_category, "wisdom_tooth_extraction");
assert.notEqual(priceWisdom.action, "create_appointment");
assert.notEqual(priceWisdom.action, "cancel_appointment");

const wisdomTeethPriceSlang = detectConversationIntent("у меня чот зубы мудрости режутся чо делать и как по бабкам у вас это выйдет");
assert.equal(wisdomTeethPriceSlang.intent, "pricing_question", "wisdom_teeth_price_slang");
assert.equal(wisdomTeethPriceSlang.sub_intent, "medical_context_price");
assert.equal(wisdomTeethPriceSlang.service_category, "wisdom_tooth_extraction");
assert.equal(wisdomTeethPriceSlang.complaint, "режутся зубы мудрости");
assert.deepEqual(wisdomTeethPriceSlang.secondary_intents, ["medical_question", "service_question"]);
assert.equal(wisdomTeethPriceSlang.shouldHandoff, false);
assert.notEqual(wisdomTeethPriceSlang.intent, "cancel");

const wisdomTeethSkok = detectConversationIntent("скок выйдет если восьмёрка лезет");
assert.equal(wisdomTeethSkok.intent, "pricing_question", "wisdom_teeth_skok");
assert.equal(wisdomTeethSkok.service_category, "wisdom_tooth_extraction");
assert.equal(wisdomTeethSkok.complaint, "режутся зубы мудрости");

const wisdomTeethWhatToDo = detectConversationIntent("зубы мудрости режутся чо делать");
assert.equal(wisdomTeethWhatToDo.intent, "service_question", "wisdom_teeth_what_to_do");
assert.equal(wisdomTeethWhatToDo.service_category, "wisdom_tooth_extraction");
assert.deepEqual(wisdomTeethWhatToDo.secondary_intents, ["medical_question"]);
assert.equal(wisdomTeethWhatToDo.shouldHandoff, false);

const understoodEntityReply = buildSafeScriptedReply({
  intent: "unknown",
  messageText: "зубы мудрости режутся чо делать"
});
assert.doesNotMatch(understoodEntityReply, /что хотите уточнить по (лечению|услугам),? стоимости или записи/iu, "understood_entity_prevents_generic_fallback");
assert.match(understoodEntityReply, /зубы мудрости|осмотр|стоматолог/iu);

const oldGroqApiKey = config.groqApiKey;
config.groqApiKey = "";
try {
  const localPriceSlang = await classifyUserIntentWithLLM({
    userMessage: "как по бабкам у вас зубы мудрости",
    history: [],
    memory: {}
  });
  assert.equal(localPriceSlang.classifier_intent, "pricing_question", "price_slang_babki");
  assert.equal(localPriceSlang.extracted.service_category, "wisdom_tooth_extraction");
  assert.equal(localPriceSlang.flags.is_dental_service, true);
  assert.notEqual(localPriceSlang.classifier_intent, "unknown");
} finally {
  config.groqApiKey = oldGroqApiKey;
}

const ambiguous = detectConversationIntent("удалите зуб мудрости запись не нужна");
assert.equal(ambiguous.reason, "ambiguous_delete_intent");
assert.equal(ambiguous.shouldHandoff, true);
assert.equal(detectAmbiguousDeleteIntent("удалите зуб мудрости запись не нужна").detected, true);

assert.equal(detectDentalServiceIntent("вырвать зуб завтра").service_category, "tooth_extraction");
assert.equal(detectExplicitAppointmentCancel("удалите бронь").detected, true);
assert.equal(detectExplicitAppointmentCancel("удалите зуб").detected, false);

const noiseState = detectConversationIntent("pe,s velhjcnd,s elfknm b");
assert.equal(noiseState.intent, "message", "latin gibberish should not cancel state");
assert.notEqual(noiseState.state, "cancellation_requested");

const noiseReply = buildSafeScriptedReply({ intent: "noise", state: "collecting_booking_data", messageText: "????" });
assert.match(noiseReply, /не\s+совсем|не\s+разобрала|подробнее/iu);

const recovery = buildValidation("нужно удалить зуб мудрости завтра");
assert.equal(recovery.bookingIntent, true, "normal message after noise must recover as booking request");
assert.equal(recovery.validation.allowed, false, "no appointment without explicit confirmation");
assert.ok(recovery.validation.missing_fields.includes("preferred_time"), "missing time must be collected");
assert.ok(!recovery.validation.missing_fields.includes("consent_to_book"), "confirmation must wait until concrete slot is selected");
assert.notEqual(recovery.validation.downgraded_action, "cancel_appointment");

const serviceAndDate = buildValidation("нужно удалить зуб мудрости и завтра думаю удобно бы");
assert.equal(serviceAndDate.facts.requested_service, "удаление зуба мудрости");
assert.equal(serviceAndDate.memory.preferred_date, "2026-05-28");
assert.equal(serviceAndDate.validation.allowed, false);
assert.ok(serviceAndDate.validation.missing_fields.includes("preferred_time"));

console.log("agent intent eval passed");

function buildValidation(messageText) {
  const facts = extractBookingFacts(messageText, baseDate);
  const memory = normalizeBookingMemory(facts, baseDate);
  const missingFields = getMissingAppointmentFields({ memory, payload, baseDate });
  const bookingIntent = isBookingIntent({ text: messageText, memory: facts });
  const validation = validateAppointmentCreation(
    { action: "create_appointment" },
    memory,
    {
      payload,
      messageText,
      bookingIntent,
      missingFields,
      conversationState: bookingIntent ? "collecting_booking_data" : "idle"
    }
  );

  return { facts, memory, missingFields, bookingIntent, validation };
}
