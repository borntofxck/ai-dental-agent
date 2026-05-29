import { prisma } from "./db.js";
import { buildClinicDateTime } from "./bookingParser.js";
import { config } from "./config.js";

export async function getDueReminders(limit = 20) {
  const reminders = await prisma.appointmentReminder.findMany({
    where: {
      status: "pending",
      remindAt: { lte: new Date() }
    },
    orderBy: { remindAt: "asc" },
    take: limit * 3,
    include: {
      contact: true,
      appointmentRequest: true
    }
  });

  const freshReminders = [];
  const now = new Date();

  for (const reminder of reminders) {
    if (!shouldSendReminderForAppointment(reminder.appointmentRequest)) {
      await blockReminderForAppointmentState(reminder);
      continue;
    }

    if (!isWithinReminderSendWindow(now)) {
      await delayReminderUntilDaytime(reminder, now);
      continue;
    }

    const appointmentAt = buildClinicDateTime(
      reminder.appointmentRequest.preferredDate,
      reminder.appointmentRequest.preferredTime
    );

    if (appointmentAt && now >= appointmentAt) {
      await markReminderExpired(reminder.id, "appointment_time_already_passed");
      continue;
    }

    freshReminders.push(reminder);
    if (freshReminders.length >= limit) break;
  }

  return freshReminders.map((reminder) => ({
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

export function shouldSendReminderForAppointment(appointment = {}) {
  return ["confirmed", "booked"].includes(String(appointment?.status || "").toLowerCase());
}

export function isWithinReminderSendWindow(date = new Date(), {
  start = config.reminderSendWindowStart,
  end = config.reminderSendWindowEnd,
  timezone = config.reminderTimezone
} = {}) {
  const minutes = getMinutesInTimezone(date, timezone);
  return minutes >= parseClockMinutes(start) && minutes < parseClockMinutes(end);
}

export function getNextReminderSendTime(date = new Date(), {
  start = config.reminderSendWindowStart,
  end = config.reminderSendWindowEnd,
  timezone = config.reminderTimezone
} = {}) {
  if (isWithinReminderSendWindow(date, { start, end, timezone })) return date;

  const parts = getDatePartsInTimezone(date, timezone);
  const nowMinutes = getMinutesInTimezone(date, timezone);
  const startMinutes = parseClockMinutes(start);
  const endMinutes = parseClockMinutes(end);
  const target = nowMinutes < startMinutes
    ? parts
    : addDaysToParts(parts, nowMinutes >= endMinutes ? 1 : 0);

  const [hour, minute] = start.split(":").map(Number);
  return dateFromTimezoneParts({
    ...target,
    hour,
    minute: minute || 0,
    second: 0
  }, timezone);
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

export async function markReminderExpired(id, reason = "reminder_expired") {
  return prisma.appointmentReminder.update({
    where: { id: Number(id) },
    data: {
      status: "expired",
      error: reason,
      updatedAt: new Date()
    }
  });
}

async function blockReminderForAppointmentState(reminder) {
  const status = String(reminder.appointmentRequest?.status || "unknown");
  await prisma.appointmentReminder.update({
    where: { id: reminder.id },
    data: {
      status: "cancelled",
      error: `reminder_blocked_${status}_appointment`,
      updatedAt: new Date()
    }
  });

  await logReminderEvent({
    reminder,
    type: "reminder_blocked_cancelled_appointment",
    reason: status
  });
}

async function delayReminderUntilDaytime(reminder, now) {
  const delayedUntil = getNextReminderSendTime(now);
  await prisma.appointmentReminder.update({
    where: { id: reminder.id },
    data: {
      remindAt: delayedUntil,
      error: "reminder_delayed_until_daytime",
      updatedAt: new Date()
    }
  });

  await logReminderEvent({
    reminder,
    type: "reminder_delayed_until_daytime",
    reason: delayedUntil.toISOString(),
    payload: {
      delayed_until: delayedUntil.toISOString(),
      timezone: config.reminderTimezone,
      window_start: config.reminderSendWindowStart,
      window_end: config.reminderSendWindowEnd
    }
  });
}

async function logReminderEvent({ reminder, type, reason = null, payload = {} }) {
  const conversationId = reminder.appointmentRequest?.conversationId;
  if (!conversationId) return;

  await prisma.agentAction.create({
    data: {
      conversationId,
      actionType: type,
      reason,
      payload: {
        reminder_id: reminder.id,
        appointment_request_id: reminder.appointmentRequestId,
        ...payload
      }
    }
  }).catch(() => {});
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

function parseClockMinutes(value = "09:00") {
  const [hours, minutes] = String(value || "09:00").split(":").map(Number);
  return (Number.isFinite(hours) ? hours : 9) * 60 + (Number.isFinite(minutes) ? minutes : 0);
}

function getMinutesInTimezone(date, timezone) {
  const parts = getDatePartsInTimezone(date, timezone);
  return parts.hour * 60 + parts.minute;
}

function getDatePartsInTimezone(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const value = (type) => Number(parts.find((part) => part.type === type)?.value || 0);

  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second")
  };
}

function addDaysToParts(parts, days) {
  if (!days) return parts;
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0));
  const next = getDatePartsInTimezone(date, "UTC");
  return {
    ...parts,
    year: next.year,
    month: next.month,
    day: next.day
  };
}

function dateFromTimezoneParts(parts, timezone) {
  const utcGuess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0);
  const actualParts = getDatePartsInTimezone(new Date(utcGuess), timezone);
  const actualAsUtc = Date.UTC(
    actualParts.year,
    actualParts.month - 1,
    actualParts.day,
    actualParts.hour,
    actualParts.minute,
    actualParts.second || 0
  );
  const wantedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0);
  return new Date(utcGuess - (actualAsUtc - wantedAsUtc));
}
