import { prisma } from "./db.js";

export async function getDueReminders(limit = 20) {
  const reminders = await prisma.appointmentReminder.findMany({
    where: {
      status: "pending",
      remindAt: { lte: new Date() }
    },
    orderBy: { remindAt: "asc" },
    take: limit,
    include: {
      contact: true,
      appointmentRequest: true
    }
  });

  return reminders.map((reminder) => ({
    id: reminder.id,
    type: reminder.type,
    remind_at: reminder.remindAt,
    contact_id: reminder.contactId,
    max_user_id: reminder.contact.maxUserId,
    display_name: reminder.contact.displayName,
    appointment_request_id: reminder.appointmentRequestId,
    appointment: {
      patient_name: reminder.appointmentRequest.patientName,
      preferred_date: toIsoDate(reminder.appointmentRequest.preferredDate),
      preferred_time: reminder.appointmentRequest.preferredTime,
      requested_service: reminder.appointmentRequest.requestedService,
      complaint: reminder.appointmentRequest.complaint
    },
    text: buildReminderText(reminder)
  }));
}

export async function markReminderSent(id) {
  return prisma.appointmentReminder.update({
    where: { id: Number(id) },
    data: {
      status: "sent",
      sentAt: new Date(),
      error: null,
      updatedAt: new Date()
    }
  });
}

export async function markReminderFailed(id, error) {
  return prisma.appointmentReminder.update({
    where: { id: Number(id) },
    data: {
      status: "failed",
      error: String(error || "unknown reminder delivery error").slice(0, 2000),
      updatedAt: new Date()
    }
  });
}

function buildReminderText(reminder) {
  const appointment = reminder.appointmentRequest;
  const name = appointment.patientName ? `${appointment.patientName}, ` : "";
  const date = formatDate(appointment.preferredDate);
  const time = appointment.preferredTime || "указанное время";
  const service = appointment.requestedService || appointment.complaint || "прием";

  return `${name}напоминаем: вы записаны в DentalCare на ${service} ${date} в ${time}. Если планы изменились, пожалуйста, напишите нам.`;
}

function formatDate(date) {
  const iso = toIsoDate(date);
  if (!iso) return "выбранную дату";
  const [year, month, day] = iso.split("-");
  return `${day}.${month}.${year}`;
}

function toIsoDate(date) {
  return date?.toISOString().slice(0, 10) || null;
}
