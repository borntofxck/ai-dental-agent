import assert from "node:assert/strict";
import {
  extractBookingFacts,
  getMissingAppointmentFields,
  isBookingIntent,
  normalizeBookingMemory
} from "../agent-api/src/bookingParser.js";
import { shouldUseWorkflowProgressReply, validateAppointmentCreation } from "../agent-api/src/messageService.js";
import { normalizeStructuredAgentOutput } from "../agent-api/src/replySanitizer.js";

const baseDate = new Date("2026-05-26T10:00:00+05:00");

const questionCases = [
  "Какие у вас врачи?",
  "Когда можно приехать?",
  "Сколько стоит консультация?",
  "Какие у вас врачи и сколько консультация?",
  "Хочу удалить зуб мудрости, сколько стоит?"
];

for (const messageText of questionCases) {
  const facts = extractBookingFacts(messageText, baseDate);
  const memory = normalizeBookingMemory(facts, baseDate);
  const missingFields = getMissingAppointmentFields({
    memory,
    payload: { max_user_id: "max_test" },
    baseDate
  });
  const validation = validateAppointmentCreation(
    { action: "create_appointment" },
    memory,
    {
      payload: { max_user_id: "max_test" },
      messageText,
      bookingIntent: isBookingIntent({ text: messageText, memory: facts }),
      missingFields
    }
  );

  assert.equal(validation.allowed, false, `${messageText}: question must not create appointment`);
  assert.notEqual(validation.downgraded_action, "create_appointment", `${messageText}: action must be downgraded`);
}

const explicitMissingName = buildValidation({
  messageText: "Да, запишите меня на четверг в 15:00 на гигиену",
  payload: { max_user_id: "max_test" }
});
assert.equal(explicitMissingName.allowed, false, "explicit booking without name must not create appointment");
assert.ok(explicitMissingName.missing_fields.includes("patient_name"), "missing name must be reported");
assert.equal(explicitMissingName.downgraded_action, "collect_name");

const explicitComplete = buildValidation({
  messageText: "Да, запишите меня на четверг в 15:00 на гигиену, меня зовут Анна",
  payload: { max_user_id: "max_test" }
});
assert.equal(explicitComplete.allowed, true, "complete explicit booking must be allowed");

assert.equal(
  shouldUseWorkflowProgressReply({
    agentReply: "Хорошо, записываю вас на четверг в 15:00. Ждем вас в клинике.",
    missingFields: ["patient_name"],
    messageText: "Да, запишите меня на четверг в 15:00 на гигиену"
  }),
  true,
  "blocked booking confirmation text must be replaced with a progress question"
);

assert.equal(
  shouldUseWorkflowProgressReply({
    agentReply: "Подскажите, как вас зовут?",
    missingFields: ["patient_name"],
    messageText: "Да, запишите меня на четверг в 15:00 на гигиену"
  }),
  false,
  "valid missing-name question can be sent as is"
);

const leak = normalizeStructuredAgentOutput({
  reply: "Проверяю данные: action=create_appointment memory_patch={}",
  intent: "booking",
  action: "create_appointment",
  urgency: "low",
  should_handoff: false,
  memory_patch: {}
}, "Привет");
assert.ok(!/action|memory|intent|json|проверяю/iu.test(leak.reply), "unsafe reply must be sanitized");

console.log("agent pipeline eval passed");

function buildValidation({ messageText, payload }) {
  const facts = extractBookingFacts(messageText, baseDate);
  const memory = normalizeBookingMemory(facts, baseDate);
  const missingFields = getMissingAppointmentFields({ memory, payload, baseDate });

  return validateAppointmentCreation(
    { action: "create_appointment" },
    memory,
    {
      payload,
      messageText,
      bookingIntent: isBookingIntent({ text: messageText, memory: facts }),
      missingFields
    }
  );
}
