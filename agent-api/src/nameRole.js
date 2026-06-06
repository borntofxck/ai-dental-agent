const NAME_TOKEN = "[А-ЯЁA-Z][А-ЯЁа-яёA-Za-z-]{1,40}";
const NAME_CAPTURE = `(${NAME_TOKEN}(?:\\s+${NAME_TOKEN}){0,2})`;

export const KNOWN_CLINIC_STAFF = [
  {
    id: "chernoskutov_dmitry",
    role: "doctor",
    preferredName: "Дмитрий Алексеевич",
    fullName: "Черноскутов Дмитрий Алексеевич",
    aliases: [
      "Дмитрий Алексеевич",
      "Дмитрию Алексеевичу",
      "Черноскутов Дмитрий Алексеевич",
      "Черноскутову Дмитрию Алексеевичу",
      "Dmitriy Alekseyevich",
      "Dmitry Alekseevich"
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

const KNOWN_NAME_TO_PERSON = new Map();
for (const person of KNOWN_CLINIC_STAFF) {
  for (const alias of [person.preferredName, person.fullName, ...(person.aliases || [])]) {
    KNOWN_NAME_TO_PERSON.set(normalizeNameKey(alias), person);
  }
}

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
  return KNOWN_NAME_TO_PERSON.get(normalizeNameKey(name)) || null;
}

export function isKnownClinicPersonName(name = "") {
  return Boolean(findKnownClinicPersonByName(name));
}

export function findKnownDoctorMention(messageText = "") {
  const text = normalizeNameKey(messageText);
  if (!text) return null;

  for (const person of KNOWN_CLINIC_STAFF.filter((item) => item.role === "doctor")) {
    const aliases = [person.preferredName, person.fullName, ...(person.aliases || [])]
      .map(normalizeNameKey)
      .filter(Boolean);

    if (aliases.some((alias) => textIncludesName(text, alias))) {
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
  return isAliasInDoctorContext(nameKey, text) || (firstToken && isAliasInDoctorContext(firstToken, text));
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

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
