// Разовый backfill: заполняет Contact.patientName и Contact.phone из уже
// известных данных (память диалога, заявки, визиты). Ничего не перетирает —
// пишет только в пустые поля. Врачей в patientName не пускает.
//
// Предпросмотр:  node scripts/backfill-contact-identity.js --dry
// Применить:     node scripts/backfill-contact-identity.js --apply

import { prisma } from "../agent-api/src/db.js";
import { normalizeName, isKnownClinicPersonName, refreshClinicStaffFromDb } from "../agent-api/src/nameRole.js";

const apply = process.argv.includes("--apply");
const TRUSTED_NAME_SOURCES = new Set(["explicit_user_name"]);
const JUNK_NAMES = new Set([
  "не указано", "не указан", "не указана", "без имени", "нет", "неизвестно",
  "unknown", "max user", "клиент", "пациент", "тест", "test", "имя", "n a", "na"
]);

function cleanStr(value) {
  return String(value ?? "").trim();
}

function isUsableName(name) {
  if (!name) return false;
  const key = name.toLowerCase().replace(/ё/gu, "е").replace(/\s+/gu, " ").trim();
  if (JUNK_NAMES.has(key)) return false;
  if (!/[a-zа-я]/iu.test(name)) return false; // должна быть хоть одна буква
  if (isKnownClinicPersonName(name)) return false; // не врач
  return true;
}

function pickName(contact) {
  for (const conversation of contact.conversations) {
    const memory = conversation.memory?.memory || {};
    const source = memory.patient_name_source || memory.booking_state?.patient_name_source || null;
    const name = normalizeName(memory.patient_name || memory.booking_state?.patient_name || "");
    if (TRUSTED_NAME_SOURCES.has(source) && isUsableName(name)) {
      return { name, source: "memory_explicit" };
    }
  }
  for (const appointment of contact.appointments) {
    const name = normalizeName(appointment.patientName || "");
    if (isUsableName(name)) return { name, source: "appointment" };
  }
  for (const visit of contact.completedVisits) {
    const name = normalizeName(visit.patientName || "");
    if (isUsableName(name)) return { name, source: "completed_visit" };
  }
  return null;
}

function pickPhone(contact) {
  for (const appointment of contact.appointments) {
    if (cleanStr(appointment.phone)) return cleanStr(appointment.phone);
  }
  for (const conversation of contact.conversations) {
    const phone = cleanStr(conversation.memory?.memory?.phone);
    if (phone) return phone;
  }
  for (const visit of contact.completedVisits) {
    if (cleanStr(visit.phone)) return cleanStr(visit.phone);
  }
  return null;
}

async function main() {
  await refreshClinicStaffFromDb();

  const contacts = await prisma.contact.findMany({
    include: {
      conversations: { orderBy: { lastMessageAt: "desc" }, include: { memory: true } },
      appointments: { orderBy: { updatedAt: "desc" } },
      completedVisits: { orderBy: { visitDate: "desc" } }
    }
  });

  let nameUpdates = 0;
  let phoneUpdates = 0;
  const samples = [];

  for (const contact of contacts) {
    const data = {};

    if (!cleanStr(contact.patientName)) {
      const picked = pickName(contact);
      if (picked) {
        data.patientName = picked.name;
        nameUpdates += 1;
      }
    }

    if (!cleanStr(contact.phone)) {
      const phone = pickPhone(contact);
      if (phone) {
        data.phone = phone;
        phoneUpdates += 1;
      }
    }

    if (!Object.keys(data).length) continue;

    if (samples.length < 12) {
      samples.push(`#${contact.id} ${contact.displayName || contact.maxUserId} -> name: ${data.patientName || "(—)"}, phone: ${data.phone || "(—)"}`);
    }

    if (apply) {
      await prisma.contact.update({
        where: { id: contact.id },
        data: { ...data, updatedAt: new Date() }
      });
    }
  }

  console.log(`Контактов всего: ${contacts.length}`);
  console.log(`${apply ? "Заполнено" : "Будет заполнено"} имён: ${nameUpdates}, телефонов: ${phoneUpdates}`);
  console.log("Примеры:");
  samples.forEach((line) => console.log("  " + line));
  if (!apply) console.log("\n(режим предпросмотра — запусти с --apply, чтобы записать)");
}

main()
  .catch((error) => {
    console.error("backfill failed:", error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
