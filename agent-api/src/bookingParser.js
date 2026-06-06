import {
  extractExplicitPatientName,
  findKnownDoctorMention
} from "./nameRole.js";

const MONTHS = [
  ["январь", "января"],
  ["февраль", "февраля"],
  ["март", "марта"],
  ["апрель", "апреля"],
  ["май", "мая"],
  ["июнь", "июня"],
  ["июль", "июля"],
  ["август", "августа"],
  ["сентябрь", "сентября"],
  ["октябрь", "октября"],
  ["ноябрь", "ноября"],
  ["декабрь", "декабря"]
];

const WEEKDAYS = [
  ["воскресенье", "воскресенье"],
  ["понедельник", "понедельник"],
  ["вторник", "вторник"],
  ["среда", "среду"],
  ["четверг", "четверг"],
  ["пятница", "пятницу"],
  ["суббота", "субботу"]
];

const SERVICE_MARKERS = [
  { markers: ["кариес", "пломб"], service: "лечение кариеса" },
  { markers: ["пульпит"], service: "лечение пульпита" },
  { markers: ["периодонтит"], service: "лечение периодонтита" },
  { markers: ["лечение", "лечить", "терапевт"], service: "лечение зубов" },
  { markers: ["чистк", "гигиен", "air flow", "аир флоу"], service: "профессиональная гигиена" },
  { markers: ["зуб мудрости", "зуба мудрости", "зубы мудрости", "восьмерк", "восьмёрк"], service: "удаление зуба мудрости" },
  { markers: ["удален", "удалит", "удалите зуб", "удалить зуб", "вырывать", "вырвать"], service: "удаление зуба" },
  { markers: ["имплант"], service: "имплантация" },
  { markers: ["коронк", "протез"], service: "ортопедия" },
  { markers: ["брекет", "элайнер", "ортодонт"], service: "ортодонтия" },
  { markers: ["детск"], service: "детская стоматология" },
  { markers: ["консультац", "осмотр"], service: "консультация стоматолога" }
];

const BOOKING_MARKERS = [
  "запишите меня",
  "хочу записаться",
  "хочу записатся",
  "можно записаться",
  "можно записатся",
  "давайте запишемся",
  "давайте запишите",
  "подходит, запишите",
  "да, запишите",
  "запишите на",
  "запишите в",
  "запиши на",
  "запиши в",
  "записывайте",
  "записывай",
  "оформите запись",
  "подтверждаю запись",
  "забронируйте",
  "бронь",
  "book",
  "appointment"
];

const CONSENT_MARKERS = [
  "согласен на запись",
  "согласна на запись",
  "подтверждаю",
  "подтверждаю запись",
  "подходит, запишите",
  "давайте запишемся",
  "записывайте",
  "запишите",
  "оформляйте запись",
  "фиксируйте запись",
  "yes"
];

const PAIN_MARKERS = [
  "болит",
  "боль",
  "ноет",
  "зуб",
  "десна",
  "щека",
  "кровит",
  "отек",
  "опух",
  "tooth",
  "pain",
  "ache"
];

const DOCTOR_ALIASES = [
  {
    doctor: "Дмитрий Алексеевич",
    patterns: [
      /(?:^|[^\p{L}\p{N}])(?:к|ко)\s+дмитрию(?:\s+алексеевичу)?(?=$|[^\p{L}\p{N}])/iu,
      /(?:^|[^\p{L}\p{N}])дмитрию(?:\s+алексеевичу)?(?=$|[^\p{L}\p{N}])/iu,
      /(?:^|[^\p{L}\p{N}])дмитрий\s+алексеевич(?=$|[^\p{L}\p{N}])/iu
    ]
  }
];

export function extractBookingFacts(messageText, baseDate = new Date()) {
  const text = String(messageText || "").trim();
  const lower = text.toLowerCase();
  const facts = {};

  const phone = extractPhone(text);
  if (phone) facts.phone = phone;

  const patientName = extractExplicitPatientName(text);
  if (patientName) {
    facts.patient_name = patientName.name;
    facts.patient_name_source = patientName.source;
  }

  const appointmentDate = normalizeAppointmentDate(text, baseDate);
  if (appointmentDate) facts.preferred_date = toIsoDate(appointmentDate);

  const timeConstraint = extractTimeConstraint(text);
  if (timeConstraint.time_constraint) {
    facts.time_constraint = timeConstraint.time_constraint;
    facts.preferred_time = timeConstraint.preferred_time;
  }

  const appointmentTime = normalizeAppointmentTimeDetailed(text);
  logAppointmentTimeNormalization(text, appointmentTime);
  if (appointmentTime.time) facts.preferred_time = appointmentTime.time;

  const doctor = extractPreferredDoctor(text);
  if (doctor) facts.preferred_doctor = doctor;

  const service = extractService(lower);
  if (service) {
    facts.requested_service = service;
    facts.complaint = service;
  } else if (PAIN_MARKERS.some((marker) => lower.includes(marker))) {
    facts.complaint = text;
  }

  const clearFields = extractBookingFieldClearSignals(text);
  if (clearFields.length) {
    facts.clear_fields = clearFields;
    facts.booking_state = {
      clear_fields: clearFields.map(mapMemoryFieldToBookingStateField).filter(Boolean)
    };
  }

  if (isBookingText(lower)) {
    facts.intent = "book_appointment";
  }

  if (hasConsent(lower)) {
    facts.consent_to_book = true;
  }

  if (isBookingConfirmationText(lower)) {
    facts.confirmation = true;
  }

  return facts;
}

export function extractPreferredDoctor(messageText = "") {
  const text = String(messageText || "");
  const knownDoctor = findKnownDoctorMention(text);
  if (knownDoctor) return knownDoctor.preferredName;
  return DOCTOR_ALIASES.find((item) => item.patterns.some((pattern) => pattern.test(text)))?.doctor || null;
}

export function extractTimeConstraint(messageText = "") {
  const text = String(messageText || "").toLowerCase();
  if (!text) return {};

  const afterMatch = text.match(/(?:^|[^\p{L}\p{N}])после\s+(пяти|5|17)(?=$|[^\p{L}\p{N}])/iu);
  if (afterMatch || /(?:^|[^\p{L}\p{N}])вечером(?=$|[^\p{L}\p{N}])/iu.test(text)) {
    return {
      time_constraint: "after_17:00",
      preferred_time: "17:00"
    };
  }

  return {};
}

export function isBookingConfirmationText(messageText = "") {
  const text = String(messageText || "").trim().toLowerCase();
  if (!text || isInformationQuestion(text)) return false;
  return /^(?:да|ага|угу|ок|окей|подтверждаю|подтверждаю\s+да|да\s+подтверждаю|записывайте|запишите|подходит|подходит\s+да)[!.?\s]*$/iu.test(text) ||
    /(?:^|[^\p{L}\p{N}])(?:подтверждаю|записывайте|подходит)(?:\s+да)?(?=$|[^\p{L}\p{N}])/iu.test(text);
}

export function extractBookingFieldClearSignals(messageText = "") {
  const text = String(messageText || "").toLowerCase();
  const fields = new Set();

  if (/(?:^|[^\p{L}\p{N}])(?:не\s+(?:к|ко)\s+дмитри|не\s+дмитри|к\s+другому\s+врачу|другой\s+врач|без\s+врача|врача\s+не\s+надо)(?=$|[^\p{L}\p{N}])/iu.test(text)) {
    fields.add("preferred_doctor");
  }

  if (/(?:^|[^\p{L}\p{N}])(?:не\s+завтра|другой\s+день|другая\s+дата)(?=$|[^\p{L}\p{N}])/iu.test(text)) {
    fields.add("preferred_date");
  }

  if (/(?:^|[^\p{L}\p{N}])(?:другое\s+время|не\s+это\s+время|не\s+(?:в|к|ко|на|после)\s*\d{1,2})(?=$|[^\p{L}\p{N}])/iu.test(text)) {
    fields.add("preferred_time");
    fields.add("time_constraint");
  }

  return [...fields];
}

function mapMemoryFieldToBookingStateField(field) {
  return {
    preferred_doctor: "doctor",
    preferred_date: "date",
    preferred_time: "time",
    time_constraint: "time_constraint",
    requested_service: "service",
    complaint: "complaint",
    patient_name: "patient_name",
    phone: "phone"
  }[field] || null;
}

export function isBookingIntent({ text = "", memory = {}, modelIntent = "" } = {}) {
  if (modelIntent === "book_appointment") return true;
  if (memory?.intent === "book_appointment") return true;
  if (isDentalServiceBookingText(String(text).toLowerCase(), memory)) return true;
  return isBookingText(String(text).toLowerCase());
}

export function getMissingAppointmentFields({ memory = {}, payload = {}, baseDate = new Date() } = {}) {
  const normalizedDate = normalizeAppointmentDate(memory.preferred_date, baseDate);
  const normalizedTime = normalizeAppointmentTime(memory.preferred_time);

  return [
    [Boolean(memory.patient_name || payload.display_name), "patient_name"],
    [Boolean(memory.phone || payload.phone || payload.max_user_id), "contact"],
    [Boolean(memory.complaint || memory.requested_service), "reason"],
    [Boolean(normalizedDate), "preferred_date"],
    [Boolean(normalizedTime), "preferred_time"],
    [memory.consent_to_book === true, "consent_to_book"]
  ].filter(([present]) => !present).map(([, field]) => field);
}

export function normalizeBookingMemory(memory = {}, baseDate = new Date()) {
  const normalized = { ...memory };
  const date = normalizeAppointmentDate(normalized.preferred_date, baseDate);
  const time = normalizeAppointmentTime(normalized.preferred_time);

  if (date) normalized.preferred_date = toIsoDate(date);
  if (time) normalized.preferred_time = time;

  return normalized;
}

export function normalizeAppointmentDate(value, baseDate = new Date()) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : makeUtcDate(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
  }

  const text = String(value).trim().toLowerCase();
  if (!text) return null;

  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    return makeUtcDate(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  }

  if (text.includes("послезавтра")) return addDays(baseDate, 2);
  if (text.includes("завтра")) return addDays(baseDate, 1);
  if (text.includes("сегодня")) return addDays(baseDate, 0);

  const numericDate = text.match(/(?:^|[^\d])(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?=$|[^\d])/);
  if (numericDate) {
    const day = Number(numericDate[1]);
    const monthIndex = Number(numericDate[2]) - 1;
    const year = normalizeYear(numericDate[3], baseDate);
    return chooseFutureDate(makeUtcDate(year, monthIndex, day), baseDate);
  }

  const monthNameDate = matchMonthNameDate(text, baseDate);
  if (monthNameDate) return monthNameDate;

  const weekday = matchWeekday(text);
  if (weekday !== null) return nextWeekday(baseDate, weekday);

  const daysLater = text.match(/через\s+(\d{1,2})\s+(?:день|дня|дней)/);
  if (daysLater) return addDays(baseDate, Number(daysLater[1]));

  return null;
}

export function normalizeAppointmentTime(value) {
  return normalizeAppointmentTimeDetailed(value).time;
}

export function normalizeAppointmentTimeDetailed(value) {
  if (!value) return timeNormalizationResult({ reason: "empty" });
  const text = String(value).trim().toLowerCase();
  if (!text) return timeNormalizationResult({ reason: "empty" });

  if (/^\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?$/.test(text)) {
    return timeNormalizationResult({ reason: "date_only" });
  }

  const direct = text.match(/(?:^|[^\d])(\d{1,2}):(\d{2})(?!\d)/);
  if (direct) {
    return timeNormalizationResult({
      time: normalizeTimeParts(direct[1], direct[2]),
      confidence: 0.99,
      reason: "explicit_colon_time"
    });
  }

  const directSpace = text.match(/(?:^|[^\d])(\d{1,2})\s+(\d{2})(?!\d)/);
  if (directSpace) {
    return timeNormalizationResult({
      time: normalizeTimeParts(directSpace[1], directSpace[2]),
      confidence: 0.96,
      reason: "explicit_spaced_time"
    });
  }

  const contextDot = text.match(/(?:^|[\s,.;])(?:в|к|ко|после|до)\s*(\d{1,2})[.-](\d{2})(?!\d)/);
  if (contextDot) {
    return timeNormalizationResult({
      time: normalizeTimeParts(contextDot[1], contextDot[2]),
      confidence: 0.95,
      reason: "context_dot_time"
    });
  }

  const dayPartTime = matchDayPartTime(text);
  if (dayPartTime.time || dayPartTime.ambiguous) return dayPartTime;

  const hourOnly = text.match(/(?:^|[\s,.;])(?:в|к|ко|на|после|до)\s*(\d{1,2})(?:\s*(?:час(?:ов|а)?|ч))?(?!\s*[./-]\s*\d{1,2})/);
  if (hourOnly) return normalizeHourOnlyTime(hourOnly[1], "context_hour_only");

  const plainHour = text.match(/^(\d{1,2})(?:\s*(?:час(?:ов|а)?|ч))?$/);
  if (plainHour) return normalizeHourOnlyTime(plainHour[1], "plain_hour");

  return timeNormalizationResult({ reason: "no_time" });
}

export function getAmbiguousAppointmentTimeClarification(value) {
  const result = normalizeAppointmentTimeDetailed(value);
  if (!result.ambiguous) return null;

  return {
    suggested_time: result.suggested_time,
    question: result.suggested_time
      ? `Вы имеете в виду ${result.suggested_time}?`
      : "Уточните, пожалуйста: это утро или день/вечер?"
  };
}

export function toIsoDate(date) {
  if (!date) return null;
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("-");
}

export function formatDateForReply(value) {
  const date = normalizeAppointmentDate(value);
  const iso = date ? toIsoDate(date) : String(value || "");
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "выбранную дату";
  return `${match[3]}.${match[2]}.${match[1]}`;
}

export function buildClinicDateTime(preferredDate, preferredTime) {
  const date = normalizeAppointmentDate(preferredDate);
  const time = normalizeAppointmentTime(preferredTime);
  if (!date || !time) return null;

  return new Date(`${toIsoDate(date)}T${time}:00+05:00`);
}

function isBookingText(lower) {
  const text = String(lower || "");
  if (isInformationQuestion(text)) return false;
  return BOOKING_MARKERS.some((marker) => text.includes(marker));
}

function isDentalServiceBookingText(lower, memory = {}) {
  const text = String(lower || "");
  if (isInformationQuestion(text)) return false;
  if (!memory?.requested_service && !extractService(text)) return false;

  return /(нужно|надо|хочу|можно|удобно|завтра|послезавтра|сегодня|понедельник|вторник|сред[ау]|четверг|пятниц[ау]|суббот[ау]|воскресенье|\b\d{1,2}:\d{2}\b|\bв\s*\d{1,2}\b)/iu.test(text);
}

function hasConsent(lower) {
  const text = String(lower || "");
  if (isInformationQuestion(text)) return false;
  return CONSENT_MARKERS.some((marker) => text.includes(marker)) ||
    /(?:^|\s)да[,!\s]+(?:запишите|записывайте|давайте\s+запиш)/u.test(text);
}

function isInformationQuestion(lower = "") {
  const text = String(lower || "");
  return /(сколько|скок|скока|цена|стоимост|прайс|какие\s+врачи|какой\s+врач|кто\s+врач|когда\s+можно|есть\s+ли\s+врач|консультаци|прием\s+сколько|приём\s+сколько)/u.test(text) &&
    !/(запишите|хочу\s+запис|давайте\s+запиш|подходит,\s*запиш|оформите\s+запись)/u.test(text);
}

function extractPhone(text) {
  const candidates = text.match(/(?:\+?\d[\d\s().-]{8,}\d)/g) || [];

  for (const candidate of candidates) {
    const digits = candidate.replace(/\D/g, "");

    if (candidate.trim().startsWith("+7") && digits.length === 11) {
      return `+${digits}`;
    }

    if (digits.length === 11 && ["7", "8"].includes(digits[0])) {
      return `+7${digits.slice(1)}`;
    }

    if (digits.length === 10 && digits[0] === "9") {
      return `+7${digits}`;
    }
  }

  return null;
}

function extractPatientName(text) {
  return extractExplicitPatientName(text)?.name || null;
}

function extractService(lower) {
  return SERVICE_MARKERS.find((item) => item.markers.some((marker) => lower.includes(marker)))?.service || null;
}

function matchDayPartTime(text = "") {
  const digitMatch = text.match(/(?:^|[\s,.;])(?:в|к|ко|на|после|до)?\s*(\d{1,2})(?:\s*(?::|[.-])\s*(\d{2}))?\s*(утра|дня|дн[её]м|вечера|вечер|ночи|ночью)(?=$|[^\p{L}\p{N}])/iu);
  if (digitMatch) {
    return normalizeHourWithDayPart(digitMatch[1], digitMatch[2] || "00", digitMatch[3]);
  }

  const wordMatch = text.match(/(?:^|[^\p{L}\p{N}])(один|два|три|четыре|пять|шесть|семь|восемь|девять|десять|одиннадцать|двенадцать)\s+(утра|дня|дн[её]м|вечера|вечер|ночи|ночью)(?=$|[^\p{L}\p{N}])/iu);
  if (wordMatch) {
    return normalizeHourWithDayPart(wordHourToNumber(wordMatch[1]), "00", wordMatch[2]);
  }

  return timeNormalizationResult({ reason: "no_day_part_time" });
}

function normalizeHourWithDayPart(hoursValue, minutesValue, dayPart) {
  let hours = Number(hoursValue);
  const minutes = Number(minutesValue || 0);
  const marker = String(dayPart || "").toLowerCase();
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return timeNormalizationResult({ reason: "invalid_day_part_time" });

  if (/(дня|дн[её]м|вечера|вечер)/iu.test(marker) && hours >= 1 && hours <= 11) {
    hours += 12;
  } else if (/(ночи|ночью)/iu.test(marker) && hours === 12) {
    hours = 0;
  }

  return timeNormalizationResult({
    time: normalizeTimeParts(hours, minutes),
    confidence: 0.97,
    reason: "day_part_time"
  });
}

function normalizeHourOnlyTime(hoursValue, reason) {
  const hours = Number(hoursValue);
  if (!Number.isInteger(hours) || hours < 0 || hours > 23) {
    return timeNormalizationResult({ reason: "invalid_hour_only" });
  }

  if (hours >= 1 && hours <= 7) {
    return timeNormalizationResult({
      time: null,
      confidence: 0.42,
      reason: `${reason}_ambiguous_low_hour`,
      ambiguous: true,
      suggested_time: normalizeTimeParts(hours + 12, "00")
    });
  }

  return timeNormalizationResult({
    time: normalizeTimeParts(hours, "00"),
    confidence: 0.82,
    reason
  });
}

function wordHourToNumber(value = "") {
  return {
    один: 1,
    два: 2,
    три: 3,
    четыре: 4,
    пять: 5,
    шесть: 6,
    семь: 7,
    восемь: 8,
    девять: 9,
    десять: 10,
    одиннадцать: 11,
    двенадцать: 12
  }[String(value || "").toLowerCase()] || null;
}

function timeNormalizationResult({ time = null, confidence = 0, reason = "none", ambiguous = false, suggested_time = null } = {}) {
  return {
    time: time || null,
    confidence,
    reason,
    ambiguous: Boolean(ambiguous),
    suggested_time: suggested_time || null
  };
}

function logAppointmentTimeNormalization(sourceText, result = {}) {
  if (!result.time && !result.ambiguous) return;
  console.log("[booking-time]", {
    source_text: String(sourceText || "").slice(0, 160),
    recognized_time: result.time || null,
    suggested_time: result.suggested_time || null,
    ambiguous: Boolean(result.ambiguous),
    confidence: result.confidence || 0,
    reason: result.reason || null
  });
}

function normalizeTimeParts(hoursValue, minutesValue) {
  const hours = Number(hoursValue);
  const minutes = Number(minutesValue || 0);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function matchMonthNameDate(text, baseDate) {
  for (let monthIndex = 0; monthIndex < MONTHS.length; monthIndex += 1) {
    const variants = [...MONTHS[monthIndex]].sort((a, b) => b.length - a.length).join("|");
    const pattern = new RegExp(`(?:^|\\D)(\\d{1,2})\\s+(${variants})(?:\\s+(\\d{2,4}))?(?=$|\\D)`, "u");
    const match = text.match(pattern);
    if (match) {
      const year = normalizeYear(match[3], baseDate);
      return chooseFutureDate(makeUtcDate(year, monthIndex, Number(match[1])), baseDate);
    }
  }

  return null;
}

function matchWeekday(text) {
  for (let index = 0; index < WEEKDAYS.length; index += 1) {
    if (WEEKDAYS[index].some((variant) => text.includes(variant))) {
      return index;
    }
  }

  return null;
}

function normalizeYear(value, baseDate) {
  if (!value) return baseDate.getFullYear();
  const year = Number(value);
  if (year < 100) return 2000 + year;
  return year;
}

function chooseFutureDate(date, baseDate) {
  if (!date) return null;
  const today = addDays(baseDate, 0);
  if (date >= today) return date;
  return makeUtcDate(date.getUTCFullYear() + 1, date.getUTCMonth(), date.getUTCDate());
}

function nextWeekday(baseDate, targetWeekday) {
  const todayWeekday = baseDate.getDay();
  let daysAhead = (targetWeekday - todayWeekday + 7) % 7;
  if (daysAhead === 0) daysAhead = 7;
  return addDays(baseDate, daysAhead);
}

function addDays(baseDate, days) {
  const date = makeUtcDate(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

function makeUtcDate(year, monthIndex, day) {
  const date = new Date(Date.UTC(year, monthIndex, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== monthIndex ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
}
