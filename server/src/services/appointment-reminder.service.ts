import { OutboxJobStatus, Prisma } from "@prisma/client";

import { prisma } from "../utils/prisma.js";

type PrismaExecutor = Prisma.TransactionClient | typeof prisma;

export const appointmentReminderJobType = "APPOINTMENT_REMINDER_PATIENT";
export const appointmentReminderLeadTimeMs = 24 * 60 * 60 * 1000;

export function getAppointmentReminderNextAttemptAt(
  appointmentStartAt: Date,
  now: Date
) {
  const reminderAt = new Date(
    appointmentStartAt.getTime() - appointmentReminderLeadTimeMs
  );

  return reminderAt.getTime() <= now.getTime() ? now : reminderAt;
}

export async function createAppointmentReminderJob(
  tx: PrismaExecutor,
  input: {
    appointmentId: string;
    patientId: string;
    startAt: Date;
    now: Date;
  }
) {
  return tx.outboxJob.create({
    data: {
      type: appointmentReminderJobType,
      payload: {
        appointmentId: input.appointmentId,
        patientId: input.patientId
      },
      status: OutboxJobStatus.PENDING,
      attempts: 0,
      nextAttemptAt: getAppointmentReminderNextAttemptAt(input.startAt, input.now)
    }
  });
}

export async function deactivateAppointmentReminderJobs(
  tx: PrismaExecutor,
  appointmentId: string,
  reason: string
) {
  return tx.$executeRaw`
    UPDATE "OutboxJob"
    SET status = 'COMPLETED'::"OutboxJobStatus",
        "lastError" = ${reason},
        "updatedAt" = NOW()
    WHERE type = ${appointmentReminderJobType}
      AND payload->>'appointmentId' = ${appointmentId}
      AND status IN ('PENDING'::"OutboxJobStatus", 'FAILED'::"OutboxJobStatus", 'PROCESSING'::"OutboxJobStatus")
  `;
}
