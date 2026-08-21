import {
  AppointmentStatus,
  MedicationReminderStatus,
  OutboxJobStatus,
  Prisma
} from "@prisma/client";
import { z } from "zod";

import type { EmailMessage, EmailProvider } from "../integrations/email/email-provider.js";
import { createEmailProvider } from "../integrations/email/provider-factory.js";
import {
  renderAppointmentReminderEmail,
  renderBookingDoctorEmail,
  renderBookingPatientEmail,
  renderCancellationDoctorEmail,
  renderCancellationPatientEmail,
  renderDoctorLeaveDoctorEmail,
  renderDoctorLeavePatientEmail,
  renderMedicationReminderEmail,
  renderRescheduleDoctorEmail,
  renderReschedulePatientEmail
} from "../integrations/email/templates.js";
import { AppError } from "../middleware/app-error.js";
import { prisma } from "../utils/prisma.js";
import { appointmentReminderJobType } from "./appointment-reminder.service.js";

export const emailOutboxJobTypes = [
  "BOOKING_CONFIRMATION_PATIENT",
  "BOOKING_CONFIRMATION_DOCTOR",
  "CANCELLATION_CONFIRMATION_PATIENT",
  "CANCELLATION_NOTIFICATION_DOCTOR",
  "RESCHEDULE_CONFIRMATION_PATIENT",
  "RESCHEDULE_NOTIFICATION_DOCTOR",
  "DOCTOR_LEAVE_CANCELLATION_PATIENT",
  "DOCTOR_LEAVE_CANCELLATION_DOCTOR",
  appointmentReminderJobType
] as const;

export type EmailOutboxJobType = (typeof emailOutboxJobTypes)[number];

export const emailRetryPolicy = {
  maxAttempts: 3,
  delaysMs: [60_000, 5 * 60_000, 15 * 60_000]
} as const;

type ProcessEmailOptions = {
  provider?: EmailProvider;
  now?: Date;
};

type ClaimedEmailJob =
  | {
      kind: "ready";
      jobId: string;
      type: EmailOutboxJobType;
      attempts: number;
      appointmentId: string;
    }
  | {
      kind: "completed";
      jobId: string;
    }
  | {
      kind: "max-attempts";
      jobId: string;
    };

const outboxPayloadSchema = z
  .object({
    appointmentId: z.string().min(1)
  })
  .passthrough();

function isEmailOutboxJobType(type: string): type is EmailOutboxJobType {
  return emailOutboxJobTypes.includes(type as EmailOutboxJobType);
}

function retryDelayForAttempt(attemptNumber: number) {
  return (
    emailRetryPolicy.delaysMs[
      Math.min(attemptNumber - 1, emailRetryPolicy.delaysMs.length - 1)
    ] ?? emailRetryPolicy.delaysMs[emailRetryPolicy.delaysMs.length - 1]
  );
}

export function nextEmailRetryAt(now: Date, attemptNumber: number) {
  return new Date(now.getTime() + retryDelayForAttempt(attemptNumber));
}

function sanitizeEmailFailure(_error: unknown) {
  return "Email provider failed while sending notification";
}

async function failEmailJob(
  jobId: string,
  attempts: number,
  now: Date,
  error: unknown
) {
  const attemptNumber = attempts + 1;
  await prisma.outboxJob.update({
    where: {
      id: jobId
    },
    data: {
      status: OutboxJobStatus.FAILED,
      attempts: {
        increment: 1
      },
      nextAttemptAt: nextEmailRetryAt(now, attemptNumber),
      lastError: sanitizeEmailFailure(error)
    }
  });
}

async function claimEmailOutboxJob(
  jobId: string,
  now: Date
): Promise<ClaimedEmailJob> {
  return prisma.$transaction(async (tx) => {
    const job = await tx.outboxJob.findUnique({
      where: {
        id: jobId
      },
      select: {
        id: true,
        type: true,
        payload: true,
        status: true,
        attempts: true,
        nextAttemptAt: true
      }
    });

    if (!job) {
      throw new AppError("Outbox job not found", 404, "OUTBOX_JOB_NOT_FOUND");
    }

    if (!isEmailOutboxJobType(job.type)) {
      throw new AppError(
        "Outbox job type is not supported by email processing",
        400,
        "OUTBOX_JOB_NOT_EMAIL"
      );
    }

    if (job.status === OutboxJobStatus.COMPLETED) {
      return {
        kind: "completed",
        jobId: job.id
      };
    }

    if (job.attempts >= emailRetryPolicy.maxAttempts) {
      return {
        kind: "max-attempts",
        jobId: job.id
      };
    }

    if (job.status === OutboxJobStatus.PROCESSING) {
      throw new AppError("Email job is already processing", 409, "EMAIL_JOB_PROCESSING");
    }

    if (job.nextAttemptAt.getTime() > now.getTime()) {
      throw new AppError("Email job is not due yet", 409, "EMAIL_JOB_NOT_DUE");
    }

    const payload = outboxPayloadSchema.parse(job.payload);
    const claim = await tx.outboxJob.updateMany({
      where: {
        id: job.id,
        status: {
          in: [OutboxJobStatus.PENDING, OutboxJobStatus.FAILED]
        },
        attempts: {
          lt: emailRetryPolicy.maxAttempts
        },
        nextAttemptAt: {
          lte: now
        }
      },
      data: {
        status: OutboxJobStatus.PROCESSING,
        lastError: null
      }
    });

    if (claim.count !== 1) {
      throw new AppError("Email job is already processing", 409, "EMAIL_JOB_PROCESSING");
    }

    return {
      kind: "ready",
      jobId: job.id,
      type: job.type,
      attempts: job.attempts,
      appointmentId: payload.appointmentId
    };
  });
}

const appointmentEmailSelect = {
  id: true,
  startAt: true,
  endAt: true,
  status: true,
  patient: {
    select: {
      id: true,
      name: true,
      email: true
    }
  },
  doctor: {
    select: {
      id: true,
      specialization: true,
      user: {
        select: {
          id: true,
          name: true,
          email: true
        }
      }
    }
  }
};

type AppointmentEmailRecord = Prisma.AppointmentGetPayload<{
  select: typeof appointmentEmailSelect;
}>;

function appointmentDataForPatient(appointment: AppointmentEmailRecord) {
  return {
    recipientEmail: appointment.patient.email,
    patientName: appointment.patient.name,
    doctorName: appointment.doctor.user.name,
    specialization: appointment.doctor.specialization,
    startAt: appointment.startAt,
    endAt: appointment.endAt,
    status: appointment.status
  };
}

function appointmentDataForDoctor(appointment: AppointmentEmailRecord) {
  return {
    recipientEmail: appointment.doctor.user.email,
    patientName: appointment.patient.name,
    doctorName: appointment.doctor.user.name,
    specialization: appointment.doctor.specialization,
    startAt: appointment.startAt,
    endAt: appointment.endAt,
    status: appointment.status
  };
}

async function renderEmailForJob(job: ClaimedEmailJob & { kind: "ready" }) {
  const appointment = await prisma.appointment.findUnique({
    where: {
      id: job.appointmentId
    },
    select: appointmentEmailSelect
  });

  if (!appointment) {
    throw new AppError("Appointment not found for email job", 404, "APPOINTMENT_NOT_FOUND");
  }

  if (
    job.type === appointmentReminderJobType &&
    appointment.status !== AppointmentStatus.BOOKED
  ) {
    await prisma.outboxJob.update({
      where: {
        id: job.jobId
      },
      data: {
        status: OutboxJobStatus.COMPLETED,
        lastError: "Appointment reminder skipped because appointment is not booked"
      }
    });

    return null;
  }

  switch (job.type) {
    case "BOOKING_CONFIRMATION_PATIENT":
      return renderBookingPatientEmail(appointmentDataForPatient(appointment));
    case "BOOKING_CONFIRMATION_DOCTOR":
      return renderBookingDoctorEmail(appointmentDataForDoctor(appointment));
    case "CANCELLATION_CONFIRMATION_PATIENT":
      return renderCancellationPatientEmail(appointmentDataForPatient(appointment));
    case "CANCELLATION_NOTIFICATION_DOCTOR":
      return renderCancellationDoctorEmail(appointmentDataForDoctor(appointment));
    case "RESCHEDULE_CONFIRMATION_PATIENT":
      return renderReschedulePatientEmail(appointmentDataForPatient(appointment));
    case "RESCHEDULE_NOTIFICATION_DOCTOR":
      return renderRescheduleDoctorEmail(appointmentDataForDoctor(appointment));
    case "DOCTOR_LEAVE_CANCELLATION_PATIENT":
      return renderDoctorLeavePatientEmail(appointmentDataForPatient(appointment));
    case "DOCTOR_LEAVE_CANCELLATION_DOCTOR":
      return renderDoctorLeaveDoctorEmail(appointmentDataForDoctor(appointment));
    case appointmentReminderJobType:
      return renderAppointmentReminderEmail(appointmentDataForPatient(appointment));
  }
}

export async function processEmailOutboxJob(
  jobId: string,
  options: ProcessEmailOptions = {}
) {
  const now = options.now ?? new Date();
  const provider = options.provider ?? createEmailProvider();
  const claimedJob = await claimEmailOutboxJob(jobId, now);

  if (claimedJob.kind === "completed") {
    return { jobId: claimedJob.jobId, status: OutboxJobStatus.COMPLETED, sent: false };
  }

  if (claimedJob.kind === "max-attempts") {
    return { jobId: claimedJob.jobId, status: OutboxJobStatus.FAILED, sent: false };
  }

  try {
    const email = await renderEmailForJob(claimedJob);

    if (!email) {
      return {
        jobId: claimedJob.jobId,
        status: OutboxJobStatus.COMPLETED,
        sent: false
      };
    }

    await provider.send(email);
    await prisma.outboxJob.update({
      where: {
        id: claimedJob.jobId
      },
      data: {
        status: OutboxJobStatus.COMPLETED,
        nextAttemptAt: now,
        lastError: null
      }
    });

    return {
      jobId: claimedJob.jobId,
      status: OutboxJobStatus.COMPLETED,
      sent: true
    };
  } catch (error) {
    await failEmailJob(claimedJob.jobId, claimedJob.attempts, now, error);

    return {
      jobId: claimedJob.jobId,
      status: OutboxJobStatus.FAILED,
      sent: false,
      error: sanitizeEmailFailure(error)
    };
  }
}

export async function processDueEmailJobs(
  limit = 10,
  options: ProcessEmailOptions = {}
) {
  const now = options.now ?? new Date();
  const jobs = await prisma.outboxJob.findMany({
    where: {
      type: {
        in: [...emailOutboxJobTypes]
      },
      status: {
        in: [OutboxJobStatus.PENDING, OutboxJobStatus.FAILED]
      },
      attempts: {
        lt: emailRetryPolicy.maxAttempts
      },
      nextAttemptAt: {
        lte: now
      }
    },
    orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    take: limit,
    select: {
      id: true
    }
  });

  const results = [];

  for (const job of jobs) {
    results.push(
      await processEmailOutboxJob(job.id, {
        ...options,
        now
      })
    );
  }

  return results;
}

const medicationReminderEmailSelect = {
  id: true,
  scheduledAt: true,
  status: true,
  attempts: true,
  prescription: {
    select: {
      id: true,
      medicineName: true,
      dosage: true,
      instructions: true,
      appointment: {
        select: {
          id: true,
          patient: {
            select: {
              id: true,
              name: true,
              email: true
            }
          }
        }
      }
    }
  }
};

type MedicationReminderEmailRecord = Prisma.MedicationReminderGetPayload<{
  select: typeof medicationReminderEmailSelect;
}>;

async function claimMedicationReminder(
  reminderId: string,
  now: Date
): Promise<MedicationReminderEmailRecord | null> {
  return prisma.$transaction(async (tx) => {
    const reminder = await tx.medicationReminder.findUnique({
      where: {
        id: reminderId
      },
      select: medicationReminderEmailSelect
    });

    if (!reminder) {
      throw new AppError(
        "Medication reminder not found",
        404,
        "MEDICATION_REMINDER_NOT_FOUND"
      );
    }

    if (reminder.status === MedicationReminderStatus.SENT) {
      return null;
    }

    if (reminder.status === MedicationReminderStatus.PROCESSING) {
      throw new AppError(
        "Medication reminder is already processing",
        409,
        "MEDICATION_REMINDER_PROCESSING"
      );
    }

    if (reminder.scheduledAt.getTime() > now.getTime()) {
      throw new AppError(
        "Medication reminder is not due yet",
        409,
        "MEDICATION_REMINDER_NOT_DUE"
      );
    }

    if (reminder.attempts >= emailRetryPolicy.maxAttempts) {
      return null;
    }

    const claim = await tx.medicationReminder.updateMany({
      where: {
        id: reminder.id,
        status: {
          in: [MedicationReminderStatus.PENDING, MedicationReminderStatus.FAILED]
        },
        scheduledAt: {
          lte: now
        },
        attempts: {
          lt: emailRetryPolicy.maxAttempts
        }
      },
      data: {
        status: MedicationReminderStatus.PROCESSING,
        lastError: null
      }
    });

    if (claim.count !== 1) {
      throw new AppError(
        "Medication reminder is already processing",
        409,
        "MEDICATION_REMINDER_PROCESSING"
      );
    }

    return reminder;
  });
}

function renderMedicationReminder(reminder: MedicationReminderEmailRecord): EmailMessage {
  return renderMedicationReminderEmail({
    recipientEmail: reminder.prescription.appointment.patient.email,
    patientName: reminder.prescription.appointment.patient.name,
    medicineName: reminder.prescription.medicineName,
    dosage: reminder.prescription.dosage,
    instructions: reminder.prescription.instructions,
    scheduledAt: reminder.scheduledAt
  });
}

export async function processMedicationReminderEmail(
  reminderId: string,
  options: ProcessEmailOptions = {}
) {
  const now = options.now ?? new Date();
  const provider = options.provider ?? createEmailProvider();
  const reminder = await claimMedicationReminder(reminderId, now);

  if (!reminder) {
    return {
      reminderId,
      status: MedicationReminderStatus.SENT,
      sent: false
    };
  }

  try {
    await provider.send(renderMedicationReminder(reminder));
    await prisma.medicationReminder.update({
      where: {
        id: reminder.id
      },
      data: {
        status: MedicationReminderStatus.SENT,
        sentAt: now,
        lastError: null
      }
    });

    return {
      reminderId: reminder.id,
      status: MedicationReminderStatus.SENT,
      sent: true
    };
  } catch (error) {
    const attemptNumber = reminder.attempts + 1;
    await prisma.medicationReminder.update({
      where: {
        id: reminder.id
      },
      data: {
        status: MedicationReminderStatus.FAILED,
        attempts: {
          increment: 1
        },
        lastError: sanitizeEmailFailure(error)
      }
    });

    return {
      reminderId: reminder.id,
      status: MedicationReminderStatus.FAILED,
      sent: false,
      retryable: attemptNumber < emailRetryPolicy.maxAttempts,
      error: sanitizeEmailFailure(error)
    };
  }
}

export async function processDueMedicationReminderEmails(
  limit = 10,
  options: ProcessEmailOptions = {}
) {
  const now = options.now ?? new Date();
  const reminders = await prisma.medicationReminder.findMany({
    where: {
      status: {
        in: [MedicationReminderStatus.PENDING, MedicationReminderStatus.FAILED]
      },
      attempts: {
        lt: emailRetryPolicy.maxAttempts
      },
      scheduledAt: {
        lte: now
      }
    },
    orderBy: [{ scheduledAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    take: limit,
    select: {
      id: true
    }
  });

  const results = [];

  for (const reminder of reminders) {
    results.push(
      await processMedicationReminderEmail(reminder.id, {
        ...options,
        now
      })
    );
  }

  return results;
}
