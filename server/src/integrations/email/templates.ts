import type { EmailMessage } from "./email-provider.js";

type AppointmentEmailData = {
  recipientEmail: string;
  patientName: string;
  doctorName: string;
  specialization: string;
  startAt: Date;
  endAt: Date;
  status: string;
};

type MedicationReminderEmailData = {
  recipientEmail: string;
  patientName: string;
  medicineName: string;
  dosage: string;
  instructions: string | null;
  scheduledAt: Date;
};

function formatDateTime(date: Date) {
  return date.toISOString().replace(".000Z", "Z");
}

function asHtml(text: string) {
  return text
    .split("\n")
    .map((line) => `<p>${line.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</p>`)
    .join("");
}

function message(to: string, subject: string, text: string): EmailMessage {
  return {
    to,
    subject,
    text,
    html: asHtml(text)
  };
}

export function renderBookingPatientEmail(data: AppointmentEmailData) {
  return message(
    data.recipientEmail,
    "Appointment booking confirmed",
    [
      `Hello ${data.patientName},`,
      `Your appointment with ${data.doctorName} (${data.specialization}) is confirmed.`,
      `Time: ${formatDateTime(data.startAt)} to ${formatDateTime(data.endAt)}.`,
      `Status: ${data.status}.`
    ].join("\n")
  );
}

export function renderBookingDoctorEmail(data: AppointmentEmailData) {
  return message(
    data.recipientEmail,
    "New appointment booked",
    [
      `Hello ${data.doctorName},`,
      `A patient appointment has been booked.`,
      `Patient: ${data.patientName}.`,
      `Time: ${formatDateTime(data.startAt)} to ${formatDateTime(data.endAt)}.`,
      `Status: ${data.status}.`
    ].join("\n")
  );
}

export function renderCancellationPatientEmail(data: AppointmentEmailData) {
  return message(
    data.recipientEmail,
    "Appointment cancelled",
    [
      `Hello ${data.patientName},`,
      `Your appointment with ${data.doctorName} has been cancelled.`,
      `Original time: ${formatDateTime(data.startAt)}.`,
      `Status: ${data.status}.`
    ].join("\n")
  );
}

export function renderCancellationDoctorEmail(data: AppointmentEmailData) {
  return message(
    data.recipientEmail,
    "Appointment cancellation notice",
    [
      `Hello ${data.doctorName},`,
      `The appointment with ${data.patientName} has been cancelled.`,
      `Original time: ${formatDateTime(data.startAt)}.`,
      `Status: ${data.status}.`
    ].join("\n")
  );
}

export function renderReschedulePatientEmail(data: AppointmentEmailData) {
  return message(
    data.recipientEmail,
    "Appointment rescheduled",
    [
      `Hello ${data.patientName},`,
      `Your appointment is now scheduled with ${data.doctorName} (${data.specialization}).`,
      `Updated time: ${formatDateTime(data.startAt)} to ${formatDateTime(data.endAt)}.`,
      `Status: ${data.status}.`
    ].join("\n")
  );
}

export function renderRescheduleDoctorEmail(data: AppointmentEmailData) {
  return message(
    data.recipientEmail,
    "Appointment reschedule notice",
    [
      `Hello ${data.doctorName},`,
      `The appointment with ${data.patientName} has been rescheduled.`,
      `Updated time: ${formatDateTime(data.startAt)} to ${formatDateTime(data.endAt)}.`,
      `Status: ${data.status}.`
    ].join("\n")
  );
}

export function renderDoctorLeavePatientEmail(data: AppointmentEmailData) {
  return message(
    data.recipientEmail,
    "Appointment cancelled due to doctor unavailability",
    [
      `Hello ${data.patientName},`,
      `Your appointment with ${data.doctorName} was cancelled because the doctor became unavailable.`,
      `Original appointment time: ${formatDateTime(data.startAt)}.`,
      `Status: ${data.status}.`
    ].join("\n")
  );
}

export function renderDoctorLeaveDoctorEmail(data: AppointmentEmailData) {
  return message(
    data.recipientEmail,
    "Leave-related appointment cancellation",
    [
      `Hello ${data.doctorName},`,
      `An appointment with ${data.patientName} was cancelled because of your leave/unavailability.`,
      `Original appointment time: ${formatDateTime(data.startAt)}.`,
      `Status: ${data.status}.`
    ].join("\n")
  );
}

export function renderAppointmentReminderEmail(data: AppointmentEmailData) {
  return message(
    data.recipientEmail,
    "Upcoming appointment reminder",
    [
      `Hello ${data.patientName},`,
      `This is a reminder for your upcoming appointment with ${data.doctorName} (${data.specialization}).`,
      `Time: ${formatDateTime(data.startAt)} to ${formatDateTime(data.endAt)}.`,
      `Status: ${data.status}.`
    ].join("\n")
  );
}

export function renderMedicationReminderEmail(data: MedicationReminderEmailData) {
  return message(
    data.recipientEmail,
    "Medication reminder",
    [
      `Hello ${data.patientName},`,
      `Medication: ${data.medicineName}.`,
      `Dosage: ${data.dosage}.`,
      `Instructions: ${data.instructions ?? "No additional instructions provided."}`,
      `Scheduled dose time: ${formatDateTime(data.scheduledAt)}.`
    ].join("\n")
  );
}
