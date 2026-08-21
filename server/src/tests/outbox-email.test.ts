import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import {
  AiSummaryStatus,
  AppointmentStatus,
  MedicationReminderStatus,
  OutboxJobStatus,
  PrescriptionFrequency,
  ReservationStatus,
  UserRole,
  Weekday
} from "@prisma/client";

process.env.NODE_ENV = "test";

const [
  { prisma },
  { MockEmailProvider },
  templates,
  {
    emailRetryPolicy,
    emailOutboxJobTypes,
    processDueEmailJobs,
    processDueMedicationReminderEmails,
    processEmailOutboxJob,
    processMedicationReminderEmail
  },
  {
    appointmentReminderJobType,
    getAppointmentReminderNextAttemptAt
  },
  { confirmAppointment },
  { cancelPatientAppointment, reschedulePatientAppointment },
  { createMedicationRemindersForPrescriptions }
] = await Promise.all([
  import("../utils/prisma.js"),
  import("../integrations/email/mock-email-provider.js"),
  import("../integrations/email/templates.js"),
  import("../services/outbox-email.service.js"),
  import("../services/appointment-reminder.service.js"),
  import("../services/appointment-booking.service.js"),
  import("../services/patient-appointment.service.js"),
  import("../services/medication-reminder.service.js")
]);

const userIds = new Set<string>();
const doctorIds = new Set<string>();
const appointmentIds = new Set<string>();

type DoctorFixture = {
  userId: string;
  doctorProfileId: string;
};

function makeEmail(prefix: string) {
  return `${prefix}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2)}@example.com`;
}

function dateUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0
) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
}

function futureDate(offsetDays: number, hour = 9) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  date.setUTCHours(hour, 0, 0, 0);

  return date;
}

function nextUtcDateForWeekday(targetWeekday: number, offsetDays = 14) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + offsetDays);

  const currentWeekday = date.getUTCDay();
  const delta = (targetWeekday - currentWeekday + 7) % 7;
  date.setUTCDate(date.getUTCDate() + delta);

  return date.toISOString().slice(0, 10);
}

function dateAt(date: string, time: string) {
  return new Date(`${date}T${time}:00.000Z`);
}

function containsSensitiveField(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsSensitiveField);
  }

  if (typeof value !== "object" || value === null) {
    return false;
  }

  return Object.entries(value).some(
    ([key, childValue]) =>
      key === "passwordHash" ||
      key === "password" ||
      key === "JWT_SECRET" ||
      key === "LLM_API_KEY" ||
      key === "SMTP_PASS" ||
      key === "DATABASE_URL" ||
      containsSensitiveField(childValue)
  );
}

async function createPatient(name = "Email Patient") {
  const user = await prisma.user.create({
    data: {
      name,
      email: makeEmail("email.patient"),
      passwordHash: "test-password-hash",
      role: UserRole.PATIENT
    },
    select: {
      id: true,
      name: true,
      email: true
    }
  });

  userIds.add(user.id);

  return user;
}

async function createDoctor(name = "Dr. Email") {
  const user = await prisma.user.create({
    data: {
      name,
      email: makeEmail("email.doctor"),
      passwordHash: "test-password-hash",
      role: UserRole.DOCTOR,
      doctorProfile: {
        create: {
          specialization: "Emailology",
          slotDurationMinutes: 30
        }
      }
    },
    select: {
      id: true,
      email: true,
      doctorProfile: {
        select: {
          id: true
        }
      }
    }
  });

  userIds.add(user.id);
  assert.ok(user.doctorProfile);

  const doctor = {
    userId: user.id,
    doctorProfileId: user.doctorProfile.id
  };
  doctorIds.add(doctor.doctorProfileId);

  return doctor;
}

async function createAppointment(options: {
  status?: AppointmentStatus;
  startAt?: Date;
  patientId?: string;
  doctorId?: string;
} = {}) {
  const patient =
    options.patientId === undefined ? await createPatient() : { id: options.patientId };
  const doctor =
    options.doctorId === undefined
      ? await createDoctor()
      : { doctorProfileId: options.doctorId };
  const startAt = options.startAt ?? futureDate(20 + appointmentIds.size);
  const appointment = await prisma.appointment.create({
    data: {
      patientId: patient.id,
      doctorId: doctor.doctorProfileId,
      startAt,
      endAt: new Date(startAt.getTime() + 30 * 60 * 1000),
      status: options.status ?? AppointmentStatus.BOOKED,
      symptoms: "Email test symptoms.",
      preSummaryStatus: AiSummaryStatus.PENDING
    },
    select: {
      id: true,
      patientId: true,
      doctorId: true,
      startAt: true,
      endAt: true
    }
  });

  appointmentIds.add(appointment.id);

  return appointment;
}

async function createEmailJob(
  type: string,
  appointmentId: string,
  options: {
    status?: OutboxJobStatus;
    attempts?: number;
    nextAttemptAt?: Date;
  } = {}
) {
  return prisma.outboxJob.create({
    data: {
      type,
      payload: {
        appointmentId
      },
      status: options.status ?? OutboxJobStatus.PENDING,
      attempts: options.attempts ?? 0,
      nextAttemptAt: options.nextAttemptAt ?? new Date()
    },
    select: {
      id: true
    }
  });
}

async function createBookableHold(options: {
  patientId: string;
  doctor: DoctorFixture;
  startAt: Date;
}) {
  await prisma.doctorAvailability.create({
    data: {
      doctorId: options.doctor.doctorProfileId,
      weekday: Weekday.MONDAY,
      startTime: "09:00",
      endTime: "17:00"
    }
  });

  return prisma.slotReservation.create({
    data: {
      patientId: options.patientId,
      doctorId: options.doctor.doctorProfileId,
      startAt: options.startAt,
      expiresAt: new Date(options.startAt.getTime() - 60_000),
      status: ReservationStatus.HOLD
    },
    select: {
      id: true
    }
  });
}

async function outboxJobsForAppointment(appointmentId: string, type?: string) {
  return prisma.outboxJob.findMany({
    where: {
      ...(type ? { type } : {}),
      payload: {
        path: ["appointmentId"],
        equals: appointmentId
      }
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }]
  });
}

async function createMedicationReminder(options: {
  status?: MedicationReminderStatus;
  attempts?: number;
  scheduledAt?: Date;
} = {}) {
  const appointment = await createAppointment({
    status: AppointmentStatus.COMPLETED
  });
  const prescription = await prisma.prescription.create({
    data: {
      appointmentId: appointment.id,
      medicineName: "Reminder Medicine",
      dosage: "10mg",
      frequency: PrescriptionFrequency.ONCE_DAILY,
      durationDays: 2,
      instructions: "Take with water"
    }
  });
  const reminder = await prisma.medicationReminder.create({
    data: {
      prescriptionId: prescription.id,
      scheduledAt: options.scheduledAt ?? dateUtc(2035, 1, 1, 9),
      status: options.status ?? MedicationReminderStatus.PENDING,
      attempts: options.attempts ?? 0
    }
  });

  return { appointment, prescription, reminder };
}

async function clearDueEmailWorkerState(now: Date) {
  await prisma.outboxJob.updateMany({
    where: {
      type: {
        in: [...emailOutboxJobTypes]
      },
      status: {
        in: [OutboxJobStatus.PENDING, OutboxJobStatus.FAILED]
      },
      nextAttemptAt: {
        lte: now
      }
    },
    data: {
      status: OutboxJobStatus.COMPLETED,
      lastError: "Test fixture completed before worker assertion"
    }
  });
}

after(async () => {
  if (appointmentIds.size > 0) {
    await prisma.outboxJob.deleteMany({
      where: {
        OR: [...appointmentIds].map((appointmentId) => ({
          payload: {
            path: ["appointmentId"],
            equals: appointmentId
          }
        }))
      }
    });

    await prisma.slotReservation.deleteMany({
      where: {
        OR: [
          {
            appointmentId: {
              in: [...appointmentIds]
            }
          },
          {
            doctorId: {
              in: [...doctorIds]
            }
          },
          {
            patientId: {
              in: [...userIds]
            }
          }
        ]
      }
    });

    await prisma.appointment.deleteMany({
      where: {
        id: {
          in: [...appointmentIds]
        }
      }
    });
  }

  if (doctorIds.size > 0) {
    await prisma.doctorAvailability.deleteMany({
      where: {
        doctorId: {
          in: [...doctorIds]
        }
      }
    });
  }

  if (userIds.size > 0) {
    await prisma.user.deleteMany({
      where: {
        id: {
          in: [...userIds]
        }
      }
    });
  }

  await prisma.$disconnect();
});

describe("email templates and provider", () => {
  const appointmentData = {
    recipientEmail: "recipient@example.com",
    patientName: "Patient Example",
    doctorName: "Dr. Example",
    specialization: "Cardiology",
    startAt: dateUtc(2035, 1, 1, 9),
    endAt: dateUtc(2035, 1, 1, 9, 30),
    status: "BOOKED"
  };

  test("booking patient email template renders", () => {
    const email = templates.renderBookingPatientEmail(appointmentData);

    assert.equal(email.to, "recipient@example.com");
    assert.match(email.subject, /booking confirmed/i);
    assert.match(email.text, /Dr\. Example/);
  });

  test("booking doctor email template renders", () => {
    const email = templates.renderBookingDoctorEmail(appointmentData);

    assert.match(email.subject, /new appointment/i);
    assert.match(email.text, /Patient Example/);
  });

  test("cancellation template renders", () => {
    const email = templates.renderCancellationPatientEmail({
      ...appointmentData,
      status: "CANCELLED"
    });

    assert.match(email.subject, /cancelled/i);
    assert.match(email.text, /Original time/);
  });

  test("reschedule template renders", () => {
    const email = templates.renderReschedulePatientEmail(appointmentData);

    assert.match(email.subject, /rescheduled/i);
    assert.match(email.text, /Updated time/);
  });

  test("doctor-leave cancellation template renders", () => {
    const email = templates.renderDoctorLeavePatientEmail({
      ...appointmentData,
      status: "CANCELLED"
    });

    assert.match(email.subject, /doctor unavailability/i);
    assert.match(email.text, /doctor became unavailable/i);
  });

  test("medication reminder template renders", () => {
    const email = templates.renderMedicationReminderEmail({
      recipientEmail: "patient@example.com",
      patientName: "Patient Example",
      medicineName: "Amoxicillin",
      dosage: "500mg",
      instructions: "Take after food",
      scheduledAt: dateUtc(2035, 1, 1, 9)
    });

    assert.match(email.subject, /medication reminder/i);
    assert.match(email.text, /Amoxicillin/);
    assert.match(email.text, /500mg/);
  });

  test("no passwordHash or secrets appear in email payloads", () => {
    const email = templates.renderBookingPatientEmail(appointmentData);

    assert.equal(containsSensitiveField(email), false);
    assert.equal(JSON.stringify(email).includes("test-password-hash"), false);
  });
});

describe("email outbox job success and retry", () => {
  test("booking patient job sends and becomes COMPLETED", async () => {
    const appointment = await createAppointment();
    const job = await createEmailJob("BOOKING_CONFIRMATION_PATIENT", appointment.id);
    const provider = new MockEmailProvider();

    const result = await processEmailOutboxJob(job.id, { provider });
    const storedJob = await prisma.outboxJob.findUniqueOrThrow({ where: { id: job.id } });

    assert.equal(result.sent, true);
    assert.equal(provider.deliveries.length, 1);
    assert.equal(storedJob.status, OutboxJobStatus.COMPLETED);
  });

  test("booking doctor job sends and becomes COMPLETED", async () => {
    const appointment = await createAppointment();
    const job = await createEmailJob("BOOKING_CONFIRMATION_DOCTOR", appointment.id);
    const provider = new MockEmailProvider();

    await processEmailOutboxJob(job.id, { provider });
    const storedJob = await prisma.outboxJob.findUniqueOrThrow({ where: { id: job.id } });

    assert.equal(provider.deliveries.length, 1);
    assert.equal(storedJob.status, OutboxJobStatus.COMPLETED);
  });

  test("cancellation email job succeeds", async () => {
    const appointment = await createAppointment({ status: AppointmentStatus.CANCELLED });
    const job = await createEmailJob("CANCELLATION_CONFIRMATION_PATIENT", appointment.id);
    const provider = new MockEmailProvider();

    await processEmailOutboxJob(job.id, { provider });

    assert.equal(provider.deliveries.length, 1);
    assert.match(provider.deliveries[0]?.subject ?? "", /cancelled/i);
  });

  test("cancellation doctor notification job succeeds", async () => {
    const appointment = await createAppointment({ status: AppointmentStatus.CANCELLED });
    const job = await createEmailJob("CANCELLATION_NOTIFICATION_DOCTOR", appointment.id);
    const provider = new MockEmailProvider();

    await processEmailOutboxJob(job.id, { provider });

    assert.equal(provider.deliveries.length, 1);
    assert.match(provider.deliveries[0]?.subject ?? "", /cancellation notice/i);
  });

  test("reschedule email job succeeds", async () => {
    const appointment = await createAppointment();
    const job = await createEmailJob("RESCHEDULE_CONFIRMATION_PATIENT", appointment.id);
    const provider = new MockEmailProvider();

    await processEmailOutboxJob(job.id, { provider });

    assert.equal(provider.deliveries.length, 1);
    assert.match(provider.deliveries[0]?.subject ?? "", /rescheduled/i);
  });

  test("doctor-leave email job succeeds", async () => {
    const appointment = await createAppointment({ status: AppointmentStatus.CANCELLED });
    const job = await createEmailJob(
      "DOCTOR_LEAVE_CANCELLATION_PATIENT",
      appointment.id
    );
    const provider = new MockEmailProvider();

    await processEmailOutboxJob(job.id, { provider });

    assert.equal(provider.deliveries.length, 1);
    assert.match(provider.deliveries[0]?.text ?? "", /doctor became unavailable/i);
  });

  test("doctor-leave doctor notification job succeeds", async () => {
    const appointment = await createAppointment({ status: AppointmentStatus.CANCELLED });
    const job = await createEmailJob(
      "DOCTOR_LEAVE_CANCELLATION_DOCTOR",
      appointment.id
    );
    const provider = new MockEmailProvider();

    await processEmailOutboxJob(job.id, { provider });

    assert.equal(provider.deliveries.length, 1);
    assert.match(provider.deliveries[0]?.text ?? "", /your leave/i);
  });

  test("provider failure increments attempts and records safe lastError", async () => {
    const appointment = await createAppointment();
    const job = await createEmailJob("BOOKING_CONFIRMATION_PATIENT", appointment.id);
    const provider = new MockEmailProvider({ failAllDeliveries: true });

    await processEmailOutboxJob(job.id, {
      provider,
      now: dateUtc(2035, 1, 1, 9)
    });
    const storedJob = await prisma.outboxJob.findUniqueOrThrow({ where: { id: job.id } });

    assert.equal(storedJob.status, OutboxJobStatus.FAILED);
    assert.equal(storedJob.attempts, 1);
    assert.equal(storedJob.lastError, "Email provider failed while sending notification");
    assert.equal(storedJob.lastError.includes("smtp://secret"), false);
  });

  test("provider failure schedules nextAttemptAt", async () => {
    const appointment = await createAppointment();
    const job = await createEmailJob("BOOKING_CONFIRMATION_PATIENT", appointment.id);
    const now = dateUtc(2035, 1, 1, 9);

    await processEmailOutboxJob(job.id, {
      provider: new MockEmailProvider({ failAllDeliveries: true }),
      now
    });
    const storedJob = await prisma.outboxJob.findUniqueOrThrow({ where: { id: job.id } });

    assert.equal(storedJob.nextAttemptAt.toISOString(), "2035-01-01T09:01:00.000Z");
  });

  test("retry can later succeed", async () => {
    const appointment = await createAppointment();
    const job = await createEmailJob("BOOKING_CONFIRMATION_PATIENT", appointment.id);
    const failingProvider = new MockEmailProvider({ failAllDeliveries: true });

    await processEmailOutboxJob(job.id, {
      provider: failingProvider,
      now: dateUtc(2035, 1, 1, 9)
    });

    const successProvider = new MockEmailProvider();
    const result = await processEmailOutboxJob(job.id, {
      provider: successProvider,
      now: dateUtc(2035, 1, 1, 9, 2)
    });
    const storedJob = await prisma.outboxJob.findUniqueOrThrow({ where: { id: job.id } });

    assert.equal(result.sent, true);
    assert.equal(successProvider.deliveries.length, 1);
    assert.equal(storedJob.status, OutboxJobStatus.COMPLETED);
    assert.equal(storedJob.attempts, 1);
  });

  test("max-attempt behavior stops infinite retry", async () => {
    const appointment = await createAppointment();
    const job = await createEmailJob("BOOKING_CONFIRMATION_PATIENT", appointment.id, {
      status: OutboxJobStatus.FAILED,
      attempts: emailRetryPolicy.maxAttempts,
      nextAttemptAt: dateUtc(2035, 1, 1, 9)
    });
    const provider = new MockEmailProvider();

    const result = await processEmailOutboxJob(job.id, {
      provider,
      now: dateUtc(2035, 1, 1, 9)
    });

    assert.equal(result.sent, false);
    assert.equal(provider.deliveries.length, 0);
  });

  test("raw SMTP/provider error is not exposed", async () => {
    const appointment = await createAppointment();
    const job = await createEmailJob("BOOKING_CONFIRMATION_PATIENT", appointment.id);

    await processEmailOutboxJob(job.id, {
      provider: new MockEmailProvider({ failAllDeliveries: true })
    });
    const storedJob = await prisma.outboxJob.findUniqueOrThrow({ where: { id: job.id } });

    assert.equal(JSON.stringify(storedJob).includes("smtp://secret"), false);
  });
});

describe("email failure isolation and idempotency", () => {
  test("booking email failure leaves appointment BOOKED and reservation BOOKED", async () => {
    const patient = await createPatient();
    const doctor = await createDoctor();
    const appointment = await createAppointment({
      patientId: patient.id,
      doctorId: doctor.doctorProfileId,
      status: AppointmentStatus.BOOKED
    });
    const reservation = await prisma.slotReservation.create({
      data: {
        patientId: patient.id,
        doctorId: doctor.doctorProfileId,
        appointmentId: appointment.id,
        startAt: appointment.startAt,
        status: ReservationStatus.BOOKED
      }
    });
    const job = await createEmailJob("BOOKING_CONFIRMATION_PATIENT", appointment.id);

    await processEmailOutboxJob(job.id, {
      provider: new MockEmailProvider({ failAllDeliveries: true })
    });
    const [storedAppointment, storedReservation] = await Promise.all([
      prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } }),
      prisma.slotReservation.findUniqueOrThrow({ where: { id: reservation.id } })
    ]);

    assert.equal(storedAppointment.status, AppointmentStatus.BOOKED);
    assert.equal(storedReservation.status, ReservationStatus.BOOKED);
  });

  test("cancellation email failure leaves appointment CANCELLED", async () => {
    const appointment = await createAppointment({ status: AppointmentStatus.CANCELLED });
    const job = await createEmailJob("CANCELLATION_CONFIRMATION_PATIENT", appointment.id);

    await processEmailOutboxJob(job.id, {
      provider: new MockEmailProvider({ failAllDeliveries: true })
    });
    const storedAppointment = await prisma.appointment.findUniqueOrThrow({
      where: { id: appointment.id }
    });

    assert.equal(storedAppointment.status, AppointmentStatus.CANCELLED);
  });

  test("doctor-leave email failure leaves cancellation committed", async () => {
    const appointment = await createAppointment({ status: AppointmentStatus.CANCELLED });
    const job = await createEmailJob(
      "DOCTOR_LEAVE_CANCELLATION_PATIENT",
      appointment.id
    );

    await processEmailOutboxJob(job.id, {
      provider: new MockEmailProvider({ failAllDeliveries: true })
    });
    const storedAppointment = await prisma.appointment.findUniqueOrThrow({
      where: { id: appointment.id }
    });

    assert.equal(storedAppointment.status, AppointmentStatus.CANCELLED);
  });

  test("COMPLETED job is not sent again", async () => {
    const appointment = await createAppointment();
    const job = await createEmailJob("BOOKING_CONFIRMATION_PATIENT", appointment.id, {
      status: OutboxJobStatus.COMPLETED
    });
    const provider = new MockEmailProvider();

    const result = await processEmailOutboxJob(job.id, { provider });

    assert.equal(result.sent, false);
    assert.equal(provider.deliveries.length, 0);
  });

  test("two workers racing for the same job result in one delivery", async () => {
    const appointment = await createAppointment();
    const job = await createEmailJob("BOOKING_CONFIRMATION_PATIENT", appointment.id);
    const provider = new MockEmailProvider();

    await Promise.allSettled([
      processEmailOutboxJob(job.id, { provider }),
      processEmailOutboxJob(job.id, { provider })
    ]);
    const storedJob = await prisma.outboxJob.findUniqueOrThrow({ where: { id: job.id } });

    assert.equal(provider.deliveries.length, 1);
    assert.equal(storedJob.status, OutboxJobStatus.COMPLETED);
  });

  test("job claim state remains consistent if provider fails", async () => {
    const appointment = await createAppointment();
    const job = await createEmailJob("BOOKING_CONFIRMATION_PATIENT", appointment.id);

    await processEmailOutboxJob(job.id, {
      provider: new MockEmailProvider({ failAllDeliveries: true })
    });
    const storedJob = await prisma.outboxJob.findUniqueOrThrow({ where: { id: job.id } });

    assert.equal(storedJob.status, OutboxJobStatus.FAILED);
    assert.equal(storedJob.attempts, 1);
  });
});

describe("appointment reminder jobs", () => {
  test("booking creates one appointment reminder job", async () => {
    const patient = await createPatient();
    const doctor = await createDoctor();
    const monday = nextUtcDateForWeekday(1);
    const hold = await createBookableHold({
      patientId: patient.id,
      doctor,
      startAt: dateAt(monday, "09:00")
    });

    const result = await confirmAppointment(
      {
        patientId: patient.id,
        reservationId: hold.id,
        symptoms: "Reminder booking symptoms."
      },
      {
        now: dateAt(monday, "08:00")
      }
    );
    appointmentIds.add(result.appointment.id);
    const reminderJobs = await outboxJobsForAppointment(
      result.appointment.id,
      appointmentReminderJobType
    );

    assert.equal(reminderJobs.length, 1);
  });

  test("reminder scheduling time follows the 24-hour rule", () => {
    const startAt = dateUtc(2035, 1, 2, 9);
    const now = dateUtc(2035, 1, 1, 8);

    assert.equal(
      getAppointmentReminderNextAttemptAt(startAt, now).toISOString(),
      "2035-01-01T09:00:00.000Z"
    );
  });

  test("booking less than 24h ahead schedules reminder immediately", () => {
    const startAt = dateUtc(2035, 1, 1, 10);
    const now = dateUtc(2035, 1, 1, 9);

    assert.equal(getAppointmentReminderNextAttemptAt(startAt, now), now);
  });

  test("cancelled appointment reminder is not sent", async () => {
    const patient = await createPatient();
    const doctor = await createDoctor();
    const appointment = await createAppointment({
      patientId: patient.id,
      doctorId: doctor.doctorProfileId
    });
    await prisma.slotReservation.create({
      data: {
        patientId: patient.id,
        doctorId: doctor.doctorProfileId,
        appointmentId: appointment.id,
        startAt: appointment.startAt,
        status: ReservationStatus.BOOKED
      }
    });
    const job = await createEmailJob(appointmentReminderJobType, appointment.id);

    await cancelPatientAppointment(patient.id, appointment.id);
    const provider = new MockEmailProvider();
    const result = await processEmailOutboxJob(job.id, { provider });

    assert.equal(result.sent, false);
    assert.equal(provider.deliveries.length, 0);
  });

  test("reschedule updates reminder timing", async () => {
    const patient = await createPatient();
    const doctor = await createDoctor();
    const start = futureDate(30, 9);
    const newStart = futureDate(31, 9);
    const appointment = await createAppointment({
      patientId: patient.id,
      doctorId: doctor.doctorProfileId,
      startAt: start
    });
    await prisma.doctorAvailability.create({
      data: {
        doctorId: doctor.doctorProfileId,
        weekday: [
          Weekday.SUNDAY,
          Weekday.MONDAY,
          Weekday.TUESDAY,
          Weekday.WEDNESDAY,
          Weekday.THURSDAY,
          Weekday.FRIDAY,
          Weekday.SATURDAY
        ][newStart.getUTCDay()],
        startTime: "09:00",
        endTime: "17:00"
      }
    });
    await prisma.slotReservation.create({
      data: {
        patientId: patient.id,
        doctorId: doctor.doctorProfileId,
        appointmentId: appointment.id,
        startAt: start,
        status: ReservationStatus.BOOKED
      }
    });
    await createEmailJob(appointmentReminderJobType, appointment.id, {
      nextAttemptAt: getAppointmentReminderNextAttemptAt(start, new Date())
    });
    const newHold = await prisma.slotReservation.create({
      data: {
        patientId: patient.id,
        doctorId: doctor.doctorProfileId,
        startAt: newStart,
        expiresAt: new Date(newStart.getTime() - 60_000),
        status: ReservationStatus.HOLD
      }
    });

    await reschedulePatientAppointment(
      {
        patientId: patient.id,
        appointmentId: appointment.id,
        newReservationId: newHold.id
      },
      {
        now: new Date()
      }
    );
    const reminderJobs = await outboxJobsForAppointment(
      appointment.id,
      appointmentReminderJobType
    );
    const pendingReminderJobs = reminderJobs.filter(
      (reminderJob) => reminderJob.status === OutboxJobStatus.PENDING
    );

    assert.equal(pendingReminderJobs.length, 1);
    assert.equal(
      pendingReminderJobs[0]?.nextAttemptAt.toISOString(),
      getAppointmentReminderNextAttemptAt(newStart, new Date()).toISOString()
    );
  });

  test("repeated booking does not duplicate appointment reminder jobs", async () => {
    const patient = await createPatient();
    const doctor = await createDoctor();
    const monday = nextUtcDateForWeekday(1, 21);
    const hold = await createBookableHold({
      patientId: patient.id,
      doctor,
      startAt: dateAt(monday, "09:00")
    });

    const first = await confirmAppointment({
      patientId: patient.id,
      reservationId: hold.id,
      symptoms: "Repeat reminder booking."
    });
    appointmentIds.add(first.appointment.id);
    const second = await confirmAppointment({
      patientId: patient.id,
      reservationId: hold.id,
      symptoms: "Repeat reminder booking."
    });
    const reminderJobs = await outboxJobsForAppointment(
      first.appointment.id,
      appointmentReminderJobType
    );

    assert.equal(second.reused, true);
    assert.equal(reminderJobs.length, 1);
  });
});

describe("medication reminder email delivery", () => {
  test("due medication reminder is delivered and becomes SENT", async () => {
    const { reminder } = await createMedicationReminder({
      scheduledAt: dateUtc(2035, 1, 1, 9)
    });
    const provider = new MockEmailProvider();

    await processMedicationReminderEmail(reminder.id, {
      provider,
      now: dateUtc(2035, 1, 1, 9)
    });
    const storedReminder = await prisma.medicationReminder.findUniqueOrThrow({
      where: { id: reminder.id }
    });

    assert.equal(provider.deliveries.length, 1);
    assert.equal(storedReminder.status, MedicationReminderStatus.SENT);
  });

  test("future medication reminder is excluded", async () => {
    await createMedicationReminder({
      scheduledAt: dateUtc(2035, 1, 1, 10)
    });
    const provider = new MockEmailProvider();

    const results = await processDueMedicationReminderEmails(10, {
      provider,
      now: dateUtc(2035, 1, 1, 9)
    });

    assert.equal(results.length, 0);
    assert.equal(provider.deliveries.length, 0);
  });

  test("already SENT medication reminder is excluded", async () => {
    await createMedicationReminder({
      status: MedicationReminderStatus.SENT,
      scheduledAt: dateUtc(2035, 1, 1, 8)
    });
    const provider = new MockEmailProvider();

    const results = await processDueMedicationReminderEmails(10, {
      provider,
      now: dateUtc(2035, 1, 1, 9)
    });

    assert.equal(results.length, 0);
    assert.equal(provider.deliveries.length, 0);
  });

  test("failed medication reminder increments retry metadata", async () => {
    const { reminder } = await createMedicationReminder({
      scheduledAt: dateUtc(2035, 1, 1, 9)
    });

    await processMedicationReminderEmail(reminder.id, {
      provider: new MockEmailProvider({ failAllDeliveries: true }),
      now: dateUtc(2035, 1, 1, 9)
    });
    const storedReminder = await prisma.medicationReminder.findUniqueOrThrow({
      where: { id: reminder.id }
    });

    assert.equal(storedReminder.status, MedicationReminderStatus.FAILED);
    assert.equal(storedReminder.attempts, 1);
    assert.equal(
      storedReminder.lastError,
      "Email provider failed while sending notification"
    );
  });

  test("failed medication reminder can later succeed", async () => {
    const { reminder } = await createMedicationReminder({
      scheduledAt: dateUtc(2035, 1, 1, 9)
    });

    await processMedicationReminderEmail(reminder.id, {
      provider: new MockEmailProvider({ failAllDeliveries: true }),
      now: dateUtc(2035, 1, 1, 9)
    });
    const provider = new MockEmailProvider();

    await processMedicationReminderEmail(reminder.id, {
      provider,
      now: dateUtc(2035, 1, 1, 9, 1)
    });
    const storedReminder = await prisma.medicationReminder.findUniqueOrThrow({
      where: { id: reminder.id }
    });

    assert.equal(provider.deliveries.length, 1);
    assert.equal(storedReminder.status, MedicationReminderStatus.SENT);
  });

  test("prescription data remains unchanged after delivery failure", async () => {
    const { prescription, reminder } = await createMedicationReminder({
      scheduledAt: dateUtc(2035, 1, 1, 9)
    });

    await processMedicationReminderEmail(reminder.id, {
      provider: new MockEmailProvider({ failAllDeliveries: true }),
      now: dateUtc(2035, 1, 1, 9)
    });
    const storedPrescription = await prisma.prescription.findUniqueOrThrow({
      where: { id: prescription.id }
    });

    assert.equal(storedPrescription.medicineName, "Reminder Medicine");
    assert.equal(storedPrescription.dosage, "10mg");
    assert.equal(storedPrescription.instructions, "Take with water");
  });

  test("AS_NEEDED creates and sends no scheduled reminder", async () => {
    const appointment = await createAppointment({ status: AppointmentStatus.COMPLETED });
    const prescription = await prisma.prescription.create({
      data: {
        appointmentId: appointment.id,
        medicineName: "As Needed Medicine",
        dosage: "1 tablet",
        frequency: PrescriptionFrequency.AS_NEEDED,
        durationDays: 3,
        instructions: "Only if needed"
      },
      select: {
        id: true,
        frequency: true,
        durationDays: true
      }
    });

    await createMedicationRemindersForPrescriptions(
      prisma,
      [prescription],
      dateUtc(2035, 1, 1, 9)
    );
    const provider = new MockEmailProvider();
    const results = await processDueMedicationReminderEmails(10, {
      provider,
      now: dateUtc(2030, 1, 1, 10)
    });
    const reminderCount = await prisma.medicationReminder.count({
      where: { prescriptionId: prescription.id }
    });

    assert.equal(reminderCount, 0);
    assert.equal(results.length, 0);
    assert.equal(provider.deliveries.length, 0);
  });
});

describe("due email worker", () => {
  test("due email worker processes eligible jobs", async () => {
    await clearDueEmailWorkerState(dateUtc(2035, 1, 1, 9));
    const appointment = await createAppointment();
    await createEmailJob("BOOKING_CONFIRMATION_PATIENT", appointment.id, {
      nextAttemptAt: dateUtc(2035, 1, 1, 8)
    });
    const provider = new MockEmailProvider();

    const results = await processDueEmailJobs(10, {
      provider,
      now: dateUtc(2035, 1, 1, 9)
    });

    assert.equal(results.length, 1);
    assert.equal(provider.deliveries.length, 1);
  });

  test("future email jobs are skipped", async () => {
    await clearDueEmailWorkerState(dateUtc(2035, 1, 1, 9));
    const appointment = await createAppointment();
    await createEmailJob("BOOKING_CONFIRMATION_PATIENT", appointment.id, {
      nextAttemptAt: dateUtc(2035, 1, 1, 10)
    });
    const provider = new MockEmailProvider();

    const results = await processDueEmailJobs(10, {
      provider,
      now: dateUtc(2035, 1, 1, 9)
    });

    assert.equal(results.length, 0);
    assert.equal(provider.deliveries.length, 0);
  });

  test("completed email jobs are skipped", async () => {
    const appointment = await createAppointment();
    await createEmailJob("BOOKING_CONFIRMATION_PATIENT", appointment.id, {
      status: OutboxJobStatus.COMPLETED,
      nextAttemptAt: dateUtc(2035, 1, 1, 8)
    });
    const provider = new MockEmailProvider();

    const results = await processDueEmailJobs(10, {
      provider,
      now: dateUtc(2035, 1, 1, 9)
    });

    assert.equal(results.length, 0);
    assert.equal(provider.deliveries.length, 0);
  });

  test("batch ordering is deterministic", async () => {
    const firstAppointment = await createAppointment();
    const secondAppointment = await createAppointment();
    await createEmailJob("BOOKING_CONFIRMATION_PATIENT", secondAppointment.id, {
      nextAttemptAt: dateUtc(2035, 1, 1, 9)
    });
    await createEmailJob("BOOKING_CONFIRMATION_PATIENT", firstAppointment.id, {
      nextAttemptAt: dateUtc(2035, 1, 1, 8)
    });
    const provider = new MockEmailProvider();

    await processDueEmailJobs(2, {
      provider,
      now: dateUtc(2035, 1, 1, 9)
    });

    assert.equal(provider.deliveries.length, 2);
    assert.match(provider.deliveries[0]?.text ?? "", /Email Patient/);
  });
});
