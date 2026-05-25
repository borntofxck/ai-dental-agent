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
  { markers: ["удален", "удалит", "вырывать", "вырвать"], service: "удаление зуба" },
  { markers: ["имплант"], service: "имплантация" },
  { markers: ["коронк", "протез"], service: "ортопедия" },
  { markers: ["брекет", "элайнер", "ортодонт"], service: "ортодонтия" },
  { markers: ["детск"], service: "детская стоматология" },
  { markers: ["консультац", "осмотр"], service: "консультация стоматолога" }
];

const BOOKING_MARKERS = [
  "запис",
  "запиш",
  "прием",
  "приём",
  "талон",
  "окно",
  "визит",
  "попасть",
  "к врачу",
  "свободное время",
  "заброниру",
  "book",
  "appointment"
];

const CONSENT_MARKERS = [
  "согласен",
  "согласна",
  "подтверждаю",
  "подходит",
  "давайте",
  "записывайте",
  "запишите",
  "оформляйте",
  "фиксируйте",
  "можно",
  "ок",
  "окей",
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

export function extractBookingFacts(messageText, baseDate = new Date()) {
  const text = String(messageText || "").trim();
  const lower = text.toLowerCase();
  const facts = {};

  const phone = extractPhone(text);
  if (phone) facts.phone = phone;

  const patientName = extractPatientName(text);
  if (patientName) facts.patient_name = patientName;

  const appointmentDate = normalizeAppointmentDate(text, baseDate);
  if (appointmentDate) facts.preferred_date = toIsoDate(appointmentDate);

  const appointmentTime = normalizeAppointmentTime(text);
  if (appointmentTime) facts.preferred_time = appointmentTime;

  const service = extractService(lower);
  if (service) {
    facts.requested_service = service;
    facts.complaint = service;
  } else if (PAIN_MARKERS.some((marker) => lower.includes(marker))) {
    facts.complaint = text;
  }

  if (isBookingText(lower)) {
    facts.intent = "book_appointment";
  }

  if (hasConsent(lower)) {
    facts.consent_to_book = true;
  }

  return facts;
}

export function isBookingIntent({ text = "", memory = {}, modelIntent = "" } = {}) {
  if (modelIntent === "book_appointment") return true;
  if (memory?.intent === "book_appointment") return true;
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
  if (!value) return null;
  const text = String(value).trim().toLowerCase();
  if (!text) return null;

  if (/^\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?$/.test(text)) {
    return null;
  }

  const direct = text.match(/(?:^|[^\d])(\d{1,2}):(\d{2})(?!\d)/);
  if (direct) return normalizeTimeParts(direct[1], direct[2]);

  const contextDot = text.match(/(?:^|[\s,.;])(?:в|к|ко|после|до)\s*(\d{1,2})[.-](\d{2})(?!\d)/);
  if (contextDot) return normalizeTimeParts(contextDot[1], contextDot[2]);

  const hourOnly = text.match(/(?:^|[\s,.;])(?:в|к|ко|на|после|до)\s*(\d{1,2})(?:\s*(?:час(?:ов|а)?|ч))?(?!\s*[./-]\s*\d{1,2})/);
  if (hourOnly) return normalizeTimeParts(hourOnly[1], "00");

  const plainHour = text.match(/^(\d{1,2})(?:\s*(?:час(?:ов|а)?|ч))?$/);
  if (plainHour) return normalizeTimeParts(plainHour[1], "00");

  return null;
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
  return BOOKING_MARKERS.some((marker) => lower.includes(marker));
}

function hasConsent(lower) {
  return CONSENT_MARKERS.some((marker) => lower.includes(marker)) || /(^|\s)да($|[\s,!.])/u.test(lower);
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
  const patterns = [
    /(?:меня зовут|мое имя|моё имя|имя)\s+([А-ЯЁA-Z][А-ЯЁа-яёA-Za-z-]{1,40})/u,
    /меня\s+([А-ЯЁA-Z][А-ЯЁа-яёA-Za-z-]{1,40})\s+зовут/u,
    /зовут\s+меня\s+([А-ЯЁA-Z][А-ЯЁа-яёA-Za-z-]{1,40})/u,
    /^я\s+([А-ЯЁA-Z][А-ЯЁа-яёA-Za-z-]{1,40})$/u
  ];

  const match = patterns.map((pattern) => text.match(pattern)).find(Boolean);
  return match ? normalizeName(match[1]) : null;
}

function extractService(lower) {
  return SERVICE_MARKERS.find((item) => item.markers.some((marker) => lower.includes(marker)))?.service || null;
}

function normalizeName(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
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
