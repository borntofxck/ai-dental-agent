import { prisma } from "./db.js";

const NAME_TOKEN = "[А-ЯЁA-Z][А-ЯЁа-яёA-Za-z-]{1,40}";
const NAME_CAPTURE = `(${NAME_TOKEN}(?:\\s+${NAME_TOKEN}){0,2})`;

// Резервный список на случай пустой/недоступной БД. Источник правды — таблица doctors.
export const FALLBACK_CLINIC_STAFF = [
  {
    id: "chernoskutov_dmitry",
    role: "doctor",
    preferredName: "Дмитрий Алексеевич",
    fullName: "Черноскутов Дмитрий Алексеевич",
    aliases: [
      "Дмитрий Алексеевич",
      "Дмитрию Алексеевичу",
      "Черноскутов Дмитрий Алексеевич",
      "Черноскутову Дмитрию Алексеевичу"
    ],
    contextAliases: ["Дмитрий", "Дмитрию"]
  },
  {
    id: "kychakova_ekaterina",
    role: "doctor",
    preferredName: "Екатерина Алексеевна",
    fullName: "Кычакова Екатерина Алексеевна",
    aliases: [
      "Екатерина Алексеевна",
      "Екатерине Алексеевне",
      "Кычакова Екатерина Алексеевна",
      "Кычаковой Екатерине Алексеевне"
    ],
    contextAliases: ["Екатерина", "Екатерине"]
  },
  {
    id: "kuzmin_vladislav",
    role: "doctor",
    preferredName: "Владислав Палыч",
    fullName: "Кузьмин Владислав Палыч",
    aliases: [
      "Владислав Палыч",
      "Владиславу Палычу",
      "Кузьмин Владислав Палыч",
      "Кузьмину Владиславу Палычу"
    ],
    contextAliases: ["Владислав", "Владиславу"]
  }
];

// Обратная совместимость (используется только внутри модуля исторически).
export const KNOWN_CLINIC_STAFF = FALLBACK_CLINIC_STAFF;

const STAFF_REFRESH_TTL_MS = Number(process.env.CLINIC_STAFF_TTL_MS || 5 * 60 * 1000);
const DECLENSION_TAIL = new Set(["а", "я", "у", "ю", "ы", "и", "е", "о", "ь", "й", "ё"]);
const MIN_STEM_LENGTH = 4;

let staffCache = [];
let nameMap = new Map();
let lastLoadedAt = 0;
let refreshing = false;

export function normalizeName(value = "") {
  const words = String(value || "")
    .replace(/\s+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

  return words.map((word) => word
    .split("-")
    .map((part) => part ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : part)
    .join("-"))
    .join(" ");
}

export function normalizeNameKey(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/ё/gu, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

// Грубый стем для устойчивости к русским склонениям: отрезаем хвостовые
// гласные/мягкие знаки до минимальной длины. "Дмитрию"/"Дмитрий" -> "дмитр".
function nameStem(word = "") {
  let stem = normalizeNameKey(word).replace(/\s+/gu, "");
  while (stem.length > MIN_STEM_LENGTH && DECLENSION_TAIL.has(stem[stem.length - 1])) {
    stem = stem.slice(0, -1);
  }
  return stem;
}

function deriveNameParts(fullName = "") {
  const tokens = normalizeName(fullName).split(" ").filter(Boolean);
  return {
    surname: tokens[0] || "",
    firstName: tokens[1] || "",
    patronymic: tokens[2] || ""
  };
}

function withMatchData(person) {
  const { surname, firstName, patronymic } = deriveNameParts(person.fullName);
  const stems = [firstName, surname, patronymic]
    .filter(Boolean)
    .map(nameStem)
    .filter((stem) => stem.length >= MIN_STEM_LENGTH);
  const pairStem = firstName && patronymic
    ? { first: nameStem(firstName), patronymic: nameStem(patronymic) }
    : null;
  return { ...person, stems, pairStem };
}

function buildPersonFromDoctor(doctor) {
  const fullName = normalizeName(doctor.fullName);
  const { surname, firstName, patronymic } = deriveNameParts(fullName);
  const preferredName = firstName && patronymic ? `${firstName} ${patronymic}` : fullName;
  return withMatchData({
    id: `db_doctor_${doctor.id}`,
    role: "doctor",
    preferredName,
    fullName,
    // В точную карту "это сотрудник" попадают только полные формы и Имя+Отчество,
    // чтобы пациент с именем врача (просто "Дмитрий") не считался сотрудником.
    aliases: [fullName, preferredName].filter(Boolean),
    // Эти срабатывают только в контексте "к врачу X".
    contextAliases: [firstName, surname, preferredName].filter(Boolean)
  });
}

function setStaff(list) {
  const source = list && list.length ? list : FALLBACK_CLINIC_STAFF;
  const staff = source.map((person) => (person.stems ? person : withMatchData(person)));
  staffCache = staff;

  const map = new Map();
  for (const person of staff) {
    for (const alias of [person.preferredName, person.fullName, ...(person.aliases || [])]) {
      if (alias) map.set(normalizeNameKey(alias), person);
    }
  }
  nameMap = map;
}

// Инициализация резервным списком синхронно, чтобы матчинг работал до первой загрузки из БД.
setStaff(FALLBACK_CLINIC_STAFF);

export async function refreshClinicStaffFromDb() {
  if (refreshing) return staffCache;
  refreshing = true;
  try {
    const doctors = await prisma.doctor.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: "asc" }, { fullName: "asc" }]
    });
    setStaff(doctors.length ? doctors.map(buildPersonFromDoctor) : FALLBACK_CLINIC_STAFF);
    lastLoadedAt = Date.now();
  } catch (error) {
    console.warn("[nameRole] doctor registry refresh failed:", error.message);
    lastLoadedAt = Date.now(); // не долбим БД при постоянной ошибке
  } finally {
    refreshing = false;
  }
  return staffCache;
}

function maybeBackgroundRefresh() {
  if (!refreshing && Date.now() - lastLoadedAt > STAFF_REFRESH_TTL_MS) {
    refreshClinicStaffFromDb().catch(() => {});
  }
}

function getClinicStaff() {
  maybeBackgroundRefresh();
  return staffCache;
}

export function extractExplicitPatientName(messageText = "") {
  const text = String(messageText || "").trim();
  if (!text) return null;

  const patterns = [
    new RegExp(`(?:меня зовут|мо[её] имя|имя)\\s+${NAME_CAPTURE}`, "u"),
    new RegExp(`меня\\s+${NAME_CAPTURE}\\s+зовут`, "u"),
    new RegExp(`зовут\\s+меня\\s+${NAME_CAPTURE}`, "u"),
    new RegExp(`запишите\\s+(?:на\\s+имя|меня\\s+как)\\s+${NAME_CAPTURE}`, "u"),
    new RegExp(`^я\\s+${NAME_CAPTURE}$`, "u")
  ];

  const match = patterns.map((pattern) => text.match(pattern)).find(Boolean);
  if (!match) return null;

  return {
    name: normalizeName(match[1]),
    source: "explicit_user_name"
  };
}

export function findKnownClinicPersonByName(name = "") {
  getClinicStaff();
  return nameMap.get(normalizeNameKey(name)) || null;
}

export function isKnownClinicPersonName(name = "") {
  return Boolean(findKnownClinicPersonByName(name));
}

export function findKnownDoctorMention(messageText = "") {
  const text = normalizeNameKey(messageText);
  if (!text) return null;
  const words = text.split(" ").filter(Boolean);

  for (const person of getClinicStaff().filter((item) => item.role === "doctor")) {
    const aliases = [person.preferredName, person.fullName, ...(person.aliases || [])]
      .map(normalizeNameKey)
      .filter(Boolean);

    if (aliases.some((alias) => textIncludesName(text, alias))) {
      return person;
    }

    // Имя+Отчество рядом — сильный сигнал даже без слова "врач" ("к Дмитрию Алексеевичу").
    if (hasAdjacentStemPair(words, person.pairStem)) {
      return person;
    }

    // Одиночное имя/фамилия (в т.ч. в склонении) только в контексте "к врачу X".
    if ((person.stems || []).some((stem) => isStemInDoctorContext(stem, text))) {
      return person;
    }

    for (const alias of (person.contextAliases || []).map(normalizeNameKey).filter(Boolean)) {
      if (isAliasInDoctorContext(alias, text)) return person;
    }
  }

  return null;
}

export function namesReferToSameKnownPerson(first = "", second = "") {
  const firstKey = normalizeNameKey(first);
  const secondKey = normalizeNameKey(second);
  if (!firstKey || !secondKey) return false;
  if (firstKey === secondKey) return true;

  const firstPerson = findKnownClinicPersonByName(first);
  const secondPerson = findKnownClinicPersonByName(second);
  return Boolean(firstPerson && secondPerson && firstPerson.id === secondPerson.id);
}

export function isNameInDoctorContext(name = "", messageText = "") {
  const nameKey = normalizeNameKey(name);
  const text = normalizeNameKey(messageText);
  if (!nameKey || !text) return false;

  const knownPerson = findKnownClinicPersonByName(name);
  if (knownPerson && knownPerson.role === "doctor" && findKnownDoctorMention(messageText)?.id === knownPerson.id) {
    return true;
  }

  const firstToken = nameKey.split(" ")[0];
  return isAliasInDoctorContext(nameKey, text) ||
    (firstToken && isAliasInDoctorContext(firstToken, text)) ||
    (firstToken && isStemInDoctorContext(nameStem(firstToken), text));
}

function hasAdjacentStemPair(words, pairStem) {
  if (!pairStem?.first || !pairStem?.patronymic) return false;
  for (let i = 0; i < words.length - 1; i += 1) {
    if (words[i].startsWith(pairStem.first) && words[i + 1].startsWith(pairStem.patronymic)) {
      return true;
    }
  }
  return false;
}

function textIncludesName(text, alias) {
  if (!alias) return false;
  return new RegExp(`(?:^|\\s)${escapeRegExp(alias)}(?:\\s|$)`, "u").test(text);
}

function isAliasInDoctorContext(alias, normalizedText) {
  const escaped = escapeRegExp(alias);
  return new RegExp(`(?:^|\\s)(?:к|ко)\\s+(?:врачу\\s+|доктору\\s+|специалисту\\s+)?${escaped}(?:\\s|$)`, "u").test(normalizedText) ||
    new RegExp(`(?:врач|доктор|специалист)(?:\\s+\\S+){0,5}\\s+${escaped}(?:\\s|$)`, "u").test(normalizedText) ||
    new RegExp(`(?:^|\\s)${escaped}(?:\\s+\\S+){0,5}\\s+(?:врач|доктор|специалист)(?:\\s|$)`, "u").test(normalizedText);
}

// То же, что isAliasInDoctorContext, но матчит слово, начинающееся со стема (склонения).
function isStemInDoctorContext(stem, normalizedText) {
  if (!stem || stem.length < MIN_STEM_LENGTH) return false;
  const s = escapeRegExp(stem);
  return new RegExp(`(?:^|\\s)(?:к|ко)\\s+(?:врачу\\s+|доктору\\s+|специалисту\\s+)?${s}\\S*(?:\\s|$)`, "u").test(normalizedText) ||
    new RegExp(`(?:врач|доктор|специалист)(?:\\s+\\S+){0,5}\\s+${s}\\S*(?:\\s|$)`, "u").test(normalizedText) ||
    new RegExp(`(?:^|\\s)${s}\\S*(?:\\s+\\S+){0,5}\\s+(?:врач|доктор|специалист)(?:\\s|$)`, "u").test(normalizedText);
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
