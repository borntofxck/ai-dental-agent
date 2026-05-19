import { prisma } from "./db.js";

const WEEKDAY_NAMES = {
  1: "понедельник",
  2: "вторник",
  3: "среда",
  4: "четверг",
  5: "пятница",
  6: "суббота",
  7: "воскресенье"
};

export async function getClinicKnowledgeContext() {
  try {
    const [settings, categories, doctors, followUpRules] = await Promise.all([
      prisma.clinicSetting.findMany({ orderBy: { key: "asc" } }),
      prisma.serviceCategory.findMany({
        where: { active: true },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        include: {
          services: {
            where: { active: true },
            orderBy: { name: "asc" }
          }
        }
      }),
      prisma.doctor.findMany({
        where: { active: true },
        orderBy: [{ sortOrder: "asc" }, { fullName: "asc" }],
        include: {
          schedules: {
            where: { active: true },
            orderBy: [{ weekday: "asc" }, { startTime: "asc" }]
          }
        }
      }),
      prisma.followUpRule.findMany({
        where: { active: true },
        orderBy: { name: "asc" },
        include: { service: true }
      })
    ]);

    const blocks = [
      renderSettings(settings),
      renderDoctors(doctors),
      renderServices(categories),
      renderFollowUpRules(followUpRules)
    ].filter(Boolean);

    return blocks.length ? blocks.join("\n\n") : "";
  } catch (error) {
    console.warn("Clinic DB knowledge was not loaded:", error.message);
    return "";
  }
}

function renderSettings(settings) {
  if (!settings.length) return "";

  return [
    "Настройки клиники из БД:",
    ...settings.map((setting) => `- ${setting.key}: ${setting.value}`)
  ].join("\n");
}

function renderDoctors(doctors) {
  if (!doctors.length) return "";

  return [
    "Врачи клиники из БД:",
    ...doctors.map((doctor) => {
      const schedule = doctor.schedules.length
        ? doctor.schedules
            .map((item) => `${WEEKDAY_NAMES[item.weekday] || item.weekday} ${item.startTime}-${item.endTime}${item.cabinet ? `, каб. ${item.cabinet}` : ""}`)
            .join("; ")
        : "график уточняется";

      return `- ${doctor.fullName}: ${doctor.position || "врач"}, специализация: ${doctor.specialization || "стоматология"}, график: ${schedule}`;
    })
  ].join("\n");
}

function renderServices(categories) {
  const lines = ["Услуги и ориентировочные цены из БД:"];

  for (const category of categories) {
    if (!category.services.length) continue;
    lines.push(`- ${category.name}:`);
    for (const service of category.services) {
      lines.push(`  - ${service.name}: ${formatPrice(service)}${service.durationMinutes ? `, ${service.durationMinutes} мин.` : ""}${service.description ? ` ${service.description}` : ""}`);
    }
  }

  return lines.length > 1 ? lines.join("\n") : "";
}

function renderFollowUpRules(rules) {
  if (!rules.length) return "";

  return [
    "Правила повторных напоминаний из БД:",
    ...rules.map((rule) => `- ${rule.name}: через ${rule.afterDays} дней после ${rule.service?.name || rule.triggerEvent}; шаблон: ${rule.messageTemplate}`)
  ].join("\n");
}

function formatPrice(service) {
  if (service.priceFrom && service.priceTo) return `от ${service.priceFrom} до ${service.priceTo} руб.`;
  if (service.priceFrom) return `от ${service.priceFrom} руб.`;
  if (service.priceTo) return `до ${service.priceTo} руб.`;
  return "стоимость уточняется после консультации";
}
