import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const settings = [
  ["clinic.name", "DentalCare", "Название клиники"],
  ["clinic.phone", "+7 900 000-00-00", "Телефон для связи"],
  ["clinic.address", "г. Екатеринбург, ул. Учебная, 10", "Мок-адрес клиники"],
  ["clinic.timezone", "Asia/Yekaterinburg", "Часовой пояс клиники"],
  ["clinic.working_hours", "Пн-Сб 09:00-20:00, Вс 10:00-16:00", "Общий режим работы"],
  ["booking.slot_minutes", "30", "Шаг записи в минутах"],
  ["booking.default_status", "confirmed", "Статус после подтверждения пациентом"]
];

const categories = [
  ["Диагностика", 10],
  ["Терапия", 20],
  ["Профессиональная гигиена", 30],
  ["Хирургия", 40],
  ["Ортопедия", 50],
  ["Ортодонтия", 60],
  ["Детская стоматология", 70]
];

const services = [
  {
    category: "Диагностика",
    slug: "primary_consultation",
    name: "Первичная консультация стоматолога",
    priceFrom: 1000,
    durationMinutes: 30,
    description: "Осмотр, сбор жалоб и предварительный план лечения."
  },
  {
    category: "Диагностика",
    slug: "xray_target",
    name: "Прицельный снимок",
    priceFrom: 500,
    durationMinutes: 10,
    description: "Назначается врачом при необходимости."
  },
  {
    category: "Терапия",
    slug: "caries_treatment",
    name: "Лечение кариеса",
    priceFrom: 4500,
    priceTo: 8500,
    durationMinutes: 60,
    description: "Стоимость зависит от глубины кариеса и объема восстановления."
  },
  {
    category: "Терапия",
    slug: "pulpitis_treatment",
    name: "Лечение пульпита",
    priceFrom: 9000,
    priceTo: 18000,
    durationMinutes: 90,
    description: "Точная цена после осмотра и снимка."
  },
  {
    category: "Профессиональная гигиена",
    slug: "professional_hygiene",
    name: "Профессиональная гигиена полости рта",
    priceFrom: 4500,
    priceTo: 7000,
    durationMinutes: 60,
    description: "Комплексная чистка, рекомендации по домашнему уходу."
  },
  {
    category: "Хирургия",
    slug: "simple_extraction",
    name: "Простое удаление зуба",
    priceFrom: 3500,
    priceTo: 6500,
    durationMinutes: 45,
    description: "Сложность определяется врачом после осмотра."
  },
  {
    category: "Хирургия",
    slug: "complex_extraction",
    name: "Сложное удаление зуба",
    priceFrom: 7000,
    priceTo: 15000,
    durationMinutes: 90,
    description: "Возможна необходимость снимка или КТ."
  },
  {
    category: "Ортопедия",
    slug: "ceramic_crown",
    name: "Керамическая коронка",
    priceFrom: 25000,
    priceTo: 45000,
    durationMinutes: 60,
    description: "Окончательная стоимость зависит от материала и плана лечения."
  },
  {
    category: "Ортодонтия",
    slug: "orthodontist_consultation",
    name: "Консультация ортодонта",
    priceFrom: 1500,
    durationMinutes: 40,
    description: "Оценка прикуса и вариантов коррекции."
  },
  {
    category: "Детская стоматология",
    slug: "pediatric_consultation",
    name: "Консультация детского стоматолога",
    priceFrom: 1000,
    durationMinutes: 30,
    description: "Первичный осмотр ребенка и рекомендации родителям."
  }
];

const doctors = [
  {
    fullName: "Черноскутов Дмитрий Алексеевич",
    position: "главный врач, стоматолог-терапевт",
    specialization: "терапия, ортопедия, консультации сложных случаев",
    phone: "+7 900 111-11-11",
    sortOrder: 1,
    schedules: [
      [1, "09:00", "15:00", "1"],
      [3, "14:00", "20:00", "1"],
      [5, "09:00", "15:00", "1"]
    ]
  },
  {
    fullName: "Кычакова Екатерина Алексеевна",
    position: "стоматолог-терапевт",
    specialization: "лечение кариеса, профессиональная гигиена, детский прием",
    phone: "+7 900 222-22-22",
    sortOrder: 2,
    schedules: [
      [2, "09:00", "15:00", "2"],
      [4, "14:00", "20:00", "2"],
      [6, "10:00", "16:00", "2"]
    ]
  },
  {
    fullName: "Кузьмин Владислав Палыч",
    position: "стоматолог-хирург",
    specialization: "удаление зубов, хирургические консультации",
    phone: "+7 900 333-33-33",
    sortOrder: 3,
    schedules: [
      [1, "15:00", "20:00", "3"],
      [4, "09:00", "14:00", "3"],
      [6, "10:00", "16:00", "3"]
    ]
  }
];

const followUpRules = [
  {
    name: "Гигиена через год",
    serviceSlug: "professional_hygiene",
    afterDays: 365,
    messageTemplate: "Здравствуйте! Прошел примерно год после профессиональной гигиены. Можно запланировать повторный профилактический визит."
  },
  {
    name: "Контроль после лечения кариеса",
    serviceSlug: "caries_treatment",
    afterDays: 180,
    messageTemplate: "Здравствуйте! Напоминаем о профилактическом осмотре после лечения. Можно подобрать удобное время для контроля."
  },
  {
    name: "Контроль после удаления",
    serviceSlug: "simple_extraction",
    afterDays: 7,
    messageTemplate: "Здравствуйте! Уточняем самочувствие после удаления зуба. Если есть боль, отек или температура, напишите нам."
  }
];

const completedVisits = [
  {
    patientName: "Мария Сергеева",
    phone: "+79001234567",
    serviceSlug: "professional_hygiene",
    doctorName: "Кычакова Екатерина Алексеевна",
    visitDate: "2025-05-20",
    notes: "Мок-данные: пациент подходит под годовое напоминание о гигиене."
  },
  {
    patientName: "Илья Носков",
    phone: "+79007654321",
    serviceSlug: "caries_treatment",
    doctorName: "Черноскутов Дмитрий Алексеевич",
    visitDate: "2025-11-10",
    notes: "Мок-данные: контроль после лечения кариеса."
  }
];

async function main() {
  for (const [key, value, description] of settings) {
    await prisma.clinicSetting.upsert({
      where: { key },
      update: { value, description, updatedAt: new Date() },
      create: { key, value, description }
    });
  }

  const categoryByName = new Map();
  for (const [name, sortOrder] of categories) {
    const category = await prisma.serviceCategory.upsert({
      where: { name },
      update: { sortOrder, active: true },
      create: { name, sortOrder, active: true }
    });
    categoryByName.set(name, category);
  }

  const serviceBySlug = new Map();
  for (const service of services) {
    const category = categoryByName.get(service.category);
    const saved = await prisma.clinicService.upsert({
      where: { slug: service.slug },
      update: {
        categoryId: category?.id,
        name: service.name,
        description: service.description,
        priceFrom: service.priceFrom ?? null,
        priceTo: service.priceTo ?? null,
        durationMinutes: service.durationMinutes ?? null,
        active: true,
        updatedAt: new Date()
      },
      create: {
        categoryId: category?.id,
        slug: service.slug,
        name: service.name,
        description: service.description,
        priceFrom: service.priceFrom ?? null,
        priceTo: service.priceTo ?? null,
        durationMinutes: service.durationMinutes ?? null,
        active: true
      }
    });
    serviceBySlug.set(service.slug, saved);
  }

  const doctorByName = new Map();
  for (const doctor of doctors) {
    const savedDoctor = await prisma.doctor.upsert({
      where: { fullName: doctor.fullName },
      update: {
        position: doctor.position,
        specialization: doctor.specialization,
        phone: doctor.phone,
        sortOrder: doctor.sortOrder,
        active: true,
        updatedAt: new Date()
      },
      create: {
        fullName: doctor.fullName,
        position: doctor.position,
        specialization: doctor.specialization,
        phone: doctor.phone,
        sortOrder: doctor.sortOrder,
        active: true
      }
    });

    doctorByName.set(doctor.fullName, savedDoctor);

    for (const [weekday, startTime, endTime, cabinet] of doctor.schedules) {
      await prisma.doctorSchedule.upsert({
        where: {
          doctorId_weekday_startTime_endTime: {
            doctorId: savedDoctor.id,
            weekday,
            startTime,
            endTime
          }
        },
        update: {
          cabinet,
          active: true,
          updatedAt: new Date()
        },
        create: {
          doctorId: savedDoctor.id,
          weekday,
          startTime,
          endTime,
          cabinet,
          active: true
        }
      });
    }
  }

  for (const rule of followUpRules) {
    const service = serviceBySlug.get(rule.serviceSlug);
    await prisma.followUpRule.upsert({
      where: { name: rule.name },
      update: {
        serviceId: service?.id,
        afterDays: rule.afterDays,
        messageTemplate: rule.messageTemplate,
        active: true,
        updatedAt: new Date()
      },
      create: {
        name: rule.name,
        serviceId: service?.id,
        afterDays: rule.afterDays,
        messageTemplate: rule.messageTemplate,
        active: true
      }
    });
  }

  for (const visit of completedVisits) {
    const service = serviceBySlug.get(visit.serviceSlug);
    const doctor = doctorByName.get(visit.doctorName);
    const existing = await prisma.completedVisit.findFirst({
      where: {
        patientName: visit.patientName,
        visitDate: new Date(`${visit.visitDate}T00:00:00.000Z`)
      }
    });

    const data = {
      patientName: visit.patientName,
      phone: visit.phone,
      serviceId: service?.id,
      serviceName: service?.name,
      doctorId: doctor?.id,
      visitDate: new Date(`${visit.visitDate}T00:00:00.000Z`),
      notes: visit.notes
    };

    if (existing) {
      await prisma.completedVisit.update({ where: { id: existing.id }, data });
    } else {
      await prisma.completedVisit.create({ data });
    }
  }

  const counts = {
    settings: await prisma.clinicSetting.count(),
    categories: await prisma.serviceCategory.count(),
    services: await prisma.clinicService.count(),
    doctors: await prisma.doctor.count(),
    schedules: await prisma.doctorSchedule.count(),
    followUpRules: await prisma.followUpRule.count(),
    completedVisits: await prisma.completedVisit.count()
  };

  console.log(JSON.stringify({ ok: true, counts }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
