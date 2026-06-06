import assert from "node:assert/strict";
import {
  extractBookingFacts,
  getAmbiguousAppointmentTimeClarification,
  getMissingAppointmentFields,
  isBookingConfirmationText,
  normalizeAppointmentDate,
  normalizeAppointmentTime,
  normalizeAppointmentTimeDetailed,
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
assert.equal(normalizeAppointmentTime("5 дня"), "17:00");
assert.equal(normalizeAppointmentTime("в 5 вечера"), "17:00");
assert.equal(normalizeAppointmentTime("17 00"), "17:00");
assert.equal(normalizeAppointmentTime("17:00"), "17:00");
assert.equal(normalizeAppointmentTime("завтра в 5"), null);
assert.equal(normalizeAppointmentTimeDetailed("завтра в 5").ambiguous, true);
assert.equal(getAmbiguousAppointmentTimeClarification("завтра в 5").suggested_time, "17:00");

const bookingStateBaseDate = new Date("2026-06-05T10:00:00+05:00");
const conversationalBooking = extractBookingFacts("хочу начать лечить зубы, к Дмитрию Алексеевичу, завтра после пяти", bookingStateBaseDate);
assert.equal(conversationalBooking.requested_service, "лечение зубов");
assert.equal(conversationalBooking.preferred_doctor, "Дмитрий Алексеевич");
assert.equal(conversationalBooking.preferred_date, "2026-06-06");
assert.equal(conversationalBooking.time_constraint, "after_17:00");
assert.equal(conversationalBooking.preferred_time, "17:00");
assert.equal(isBookingConfirmationText("подтверждаю да"), true);

const doctorCorrection = extractBookingFacts("нет, не к Дмитрию, к другому врачу", bookingStateBaseDate);
assert.deepEqual(doctorCorrection.clear_fields, ["preferred_doctor"]);
assert.deepEqual(doctorCorrection.booking_state.clear_fields, ["doctor"]);

const doctorOnly = extractBookingFacts("хочу на консультацию к Дмитрию Алексеевичу", bookingStateBaseDate);
assert.equal(doctorOnly.preferred_doctor, "Дмитрий Алексеевич");
assert.equal(doctorOnly.patient_name, undefined);
assert.equal(doctorOnly.requested_service, "консультация стоматолога");

const explicitNameAndDoctor = extractBookingFacts("меня зовут Ярослав, хочу к Дмитрию Алексеевичу", bookingStateBaseDate);
assert.equal(explicitNameAndDoctor.patient_name, "Ярослав");
assert.equal(explicitNameAndDoctor.patient_name_source, "explicit_user_name");
assert.equal(explicitNameAndDoctor.preferred_doctor, "Дмитрий Алексеевич");

const doctorRecommendation = extractBookingFacts("слышал у вас врач Дмитрий Алексеевич хороший", bookingStateBaseDate);
assert.equal(doctorRecommendation.preferred_doctor, "Дмитрий Алексеевич");
assert.equal(doctorRecommendation.patient_name, undefined);

const explicitShortDoctorName = extractBookingFacts("запишите на имя Дмитрий", bookingStateBaseDate);
assert.equal(explicitShortDoctorName.patient_name, "Дмитрий");
assert.equal(explicitShortDoctorName.patient_name_source, "explicit_user_name");
assert.equal(explicitShortDoctorName.preferred_doctor, undefined);

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
