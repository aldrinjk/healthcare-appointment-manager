import {
  MedicationReminderStatus,
  PrescriptionFrequency,
  Prisma
} from "@prisma/client";

import { AppError } from "../middleware/app-error.js";
import { prisma } from "../utils/prisma.js";

type PrismaExecutor = Prisma.TransactionClient | typeof prisma;

type PrescriptionReminderInput = {
  id: string;
  frequency: PrescriptionFrequency;
  durationDays: number;
};

type ReminderCreationOptions = {
  simulateFailureAfterReminderCreation?: boolean;
};

export const medicationReminderScheduleUtcByFrequency: Record<
  PrescriptionFrequency,
  readonly string[]
> = {
  [PrescriptionFrequency.ONCE_DAILY]: ["09:00"],
  [PrescriptionFrequency.TWICE_DAILY]: ["09:00", "21:00"],
  [PrescriptionFrequency.THREE_TIMES_DAILY]: ["09:00", "15:00", "21:00"],
  [PrescriptionFrequency.AS_NEEDED]: []
};

function parseUtcTime(time: string) {
  const [hourPart, minutePart] = time.split(":");
  const hour = Number(hourPart);
  const minute = Number(minutePart);

  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    throw new Error(`Invalid medication reminder schedule time: ${time}`);
  }

  return { hour, minute };
}

function utcStartOfDate(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
}

function addUtcDays(date: Date, days: number) {
  const nextDate = new Date(date);
  nextDate.setUTCDate(nextDate.getUTCDate() + days);

  return nextDate;
}

export function getMedicationReminderTimesForFrequency(
  frequency: PrescriptionFrequency
) {
  return [...medicationReminderScheduleUtcByFrequency[frequency]];
}

export function buildMedicationReminderSchedule(
  prescription: PrescriptionReminderInput,
  completedAt: Date
) {
  if (
    !Number.isInteger(prescription.durationDays) ||
    prescription.durationDays <= 0
  ) {
    throw new AppError(
      "Prescription duration must be positive",
      400,
      "INVALID_PRESCRIPTION_DURATION"
    );
  }

  const times = medicationReminderScheduleUtcByFrequency[prescription.frequency];
  const startDate = utcStartOfDate(completedAt);
  const scheduledAt: Date[] = [];

  for (let dayOffset = 0; dayOffset < prescription.durationDays; dayOffset += 1) {
    const scheduledDate = addUtcDays(startDate, dayOffset);

    for (const time of times) {
      const { hour, minute } = parseUtcTime(time);
      const reminderTime = new Date(
        Date.UTC(
          scheduledDate.getUTCFullYear(),
          scheduledDate.getUTCMonth(),
          scheduledDate.getUTCDate(),
          hour,
          minute,
          0,
          0
        )
      );

      if (reminderTime.getTime() >= completedAt.getTime()) {
        scheduledAt.push(reminderTime);
      }
    }
  }

  return scheduledAt.map((reminderTime) => ({
    prescriptionId: prescription.id,
    scheduledAt: reminderTime
  }));
}

export async function createMedicationRemindersForPrescriptions(
  db: PrismaExecutor,
  prescriptions: PrescriptionReminderInput[],
  completedAt: Date,
  options: ReminderCreationOptions = {}
) {
  const reminderData = prescriptions.flatMap((prescription) =>
    buildMedicationReminderSchedule(prescription, completedAt).map((reminder) => ({
      ...reminder,
      status: MedicationReminderStatus.PENDING,
      attempts: 0
    }))
  );

  if (reminderData.length > 0) {
    await db.medicationReminder.createMany({
      data: reminderData,
      skipDuplicates: true
    });
  }

  if (options.simulateFailureAfterReminderCreation) {
    throw new Error("Simulated medication reminder scheduling failure");
  }

  const prescriptionIds = prescriptions.map((prescription) => prescription.id);

  if (prescriptionIds.length === 0) {
    return [];
  }

  return db.medicationReminder.findMany({
    where: {
      prescriptionId: {
        in: prescriptionIds
      }
    },
    orderBy: [{ scheduledAt: "asc" }, { prescriptionId: "asc" }],
    select: {
      id: true,
      prescriptionId: true,
      scheduledAt: true,
      status: true,
      attempts: true
    }
  });
}

export async function findDueMedicationReminders(
  now = new Date(),
  limit = 100,
  db: PrismaExecutor = prisma
) {
  return db.medicationReminder.findMany({
    where: {
      status: MedicationReminderStatus.PENDING,
      scheduledAt: {
        lte: now
      }
    },
    orderBy: [{ scheduledAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    take: limit,
    select: {
      id: true,
      prescriptionId: true,
      scheduledAt: true,
      status: true,
      attempts: true,
      prescription: {
        select: {
          id: true,
          appointmentId: true,
          medicineName: true,
          dosage: true,
          frequency: true,
          durationDays: true,
          instructions: true,
          appointment: {
            select: {
              id: true,
              patientId: true
            }
          }
        }
      }
    }
  });
}
