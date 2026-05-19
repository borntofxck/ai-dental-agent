import assert from "node:assert/strict";
import {
  extractBookingFacts,
  getMissingAppointmentFields,
  normalizeAppointmentDate,
  normalizeAppointmentTime,
  normalizeBookingMemory,
  toIsoDate
} from "../agent-api/src/bookingParser.js";

const baseDate = new Date("2026-05-17T10:00:00+05:00");

const monday = extractBookingFacts("меня зовут Ярослав, болит зуб, запишите в понедельник в 12, да", baseDate);
assert.equal(monday.patient_name, "Ярослав");
assert.equal(monday.preferred_date, "2026-05-18");
assert.equal(monday.preferred_time, "12:00");
assert.equal(monday.intent, "book_appointment");
assert.equal(monday.consent_to_book, true);

const numericDate = extractBookingFacts("хочу записаться на 20.05 после 18:30 на лечение кариеса", baseDate);
assert.equal(numericDate.preferred_date, "2026-05-20");
assert.equal(numericDate.preferred_time, "18:30");
assert.equal(numericDate.requested_service, "лечение кариеса");
assert.equal(numericDate.phone, undefined);

const phone = extractBookingFacts("мой телефон +7 999 123-45-67, хочу записаться завтра в 10", baseDate);
assert.equal(phone.phone, "+79991234567");

const saturday = extractBookingFacts("можно на субботу к 15 на чистку", baseDate);
assert.equal(saturday.preferred_date, "2026-05-23");
assert.equal(saturday.preferred_time, "15:00");
assert.equal(saturday.requested_service, "профессиональная гигиена");

assert.equal(toIsoDate(normalizeAppointmentDate("25 мая", baseDate)), "2026-05-25");
assert.equal(normalizeAppointmentTime("в 18.30"), "18:30");
assert.equal(normalizeAppointmentTime("20.05"), null);

const memory = normalizeBookingMemory({
  patient_name: "Анна",
  complaint: "болит зуб",
  preferred_date: "понедельник",
  preferred_time: "12",
  consent_to_book: true
}, baseDate);

assert.deepEqual(getMissingAppointmentFields({
  memory,
  payload: { max_user_id: "max_chat_1" },
  baseDate
}), []);

console.log("booking parser ok");
