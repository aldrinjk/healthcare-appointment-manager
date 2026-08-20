import {
  AiSummaryStatus,
  AppointmentStatus,
  OutboxJobStatus,
  PrescriptionFrequency,
  Prisma
} from "@prisma/client";

import { getPreVisitSummaryFallback } from "./pre-visit-summary.service.js";
import { createMedicationRemindersForPrescriptions } from "./medication-reminder.service.js";
import {
  getPostVisitSummaryFallback,
  postVisitSummaryJobType
} from "./post-visit-summary.service.js";
import { AppError } from "../middleware/app-error.js";
import { prisma } from "../utils/prisma.js";

export { postVisitSummaryJobType };
export const maxClinicalNotesLength = 10_000;
export const maxFollowUpInstructionsLength = 5_000;
export const maxPrescriptionItems = 20;

type PrescriptionInput = {
  medicine: string;
  dosage: string;
  frequency: PrescriptionFrequency;
  durationDays: number;
  instructions?: string | null;
};

type CompleteDoctorVisitInput = {
  doctorUserId: string;
  appointmentId: string;
  clinicalNotes: string;
  followUpInstructions?: string | null;
  prescriptions: PrescriptionInput[];
};

type CompleteDoctorVisitOptions = {
  now?: Date;
  simulateFailureAfterAppointmentUpdate?: boolean;
  simulateReminderSchedulingFailure?: boolean;
};

const doctorAppointmentSelect = {
  id: true,
  patientId: true,
  doctorId: true,
  startAt: true,
  endAt: true,
  status: true,
  symptoms: true,
  urgency: true,
  preVisitSummary: true,
  preSummaryStatus: true,
  clinicalNotes: true,
  followUpInstructions: true,
  postSummaryStatus: true,
  postVisitSummary: true,
  patient: {
    select: {
      id: true,
      name: true
    }
  },
  prescriptions: {
    orderBy: { createdAt: "asc" as const },
    select: {
      id: true,
      medicineName: true,
      dosage: true,
      frequency: true,
      durationDays: true,
      instructions: true,
      createdAt: true,
      updatedAt: true
    }
  }
};

type DoctorAppointmentRecord = Prisma.AppointmentGetPayload<{
  select: typeof doctorAppointmentSelect;
}>;

function toDoctorAppointmentResponse(appointment: DoctorAppointmentRecord) {
  return {
    id: appointment.id,
    patient: {
      id: appointment.patient.id,
      name: appointment.patient.name
    },
    startAt: appointment.startAt.toISOString(),
    endAt: appointment.endAt.toISOString(),
    status: appointment.status,
    symptoms: appointment.symptoms,
    urgency: appointment.urgency,
    preVisitSummary: appointment.preVisitSummary,
    preSummaryStatus: appointment.preSummaryStatus,
    preVisitSummaryFallback: getPreVisitSummaryFallback(
      appointment.preSummaryStatus
    ),
    clinicalNotes: appointment.clinicalNotes,
    followUpInstructions: appointment.followUpInstructions,
    postSummaryStatus: appointment.postSummaryStatus,
    postVisitSummary: appointment.postVisitSummary,
    postVisitSummaryFallback: getPostVisitSummaryFallback(
      appointment.postSummaryStatus
    ),
    prescriptions: appointment.prescriptions.map((prescription) => ({
      id: prescription.id,
      medicine: prescription.medicineName,
      dosage: prescription.dosage,
      frequency: prescription.frequency,
      durationDays: prescription.durationDays,
      instructions: prescription.instructions,
      createdAt: prescription.createdAt.toISOString(),
      updatedAt: prescription.updatedAt.toISOString()
    }))
  };
}

async function getDoctorProfileIdForUser(
  doctorUserId: string,
  tx: Prisma.TransactionClient | typeof prisma = prisma
) {
  const doctorProfile = await tx.doctorProfile.findUnique({
    where: {
      userId: doctorUserId
    },
    select: {
      id: true
    }
  });

  if (!doctorProfile) {
    throw new AppError("Doctor profile not found", 404, "DOCTOR_PROFILE_NOT_FOUND");
  }

  return doctorProfile.id;
}

function isConflictError(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    ["P2002", "P2025", "P2028", "P2034"].includes(error.code)
  );
}

export async function listDoctorAppointments(doctorUserId: string) {
  const doctorId = await getDoctorProfileIdForUser(doctorUserId);
  const appointments = await prisma.appointment.findMany({
    where: {
      doctorId
    },
    orderBy: [{ startAt: "asc" }, { createdAt: "asc" }],
    select: doctorAppointmentSelect
  });

  return appointments.map(toDoctorAppointmentResponse);
}

export async function getDoctorAppointment(
  doctorUserId: string,
  appointmentId: string
) {
  const doctorId = await getDoctorProfileIdForUser(doctorUserId);
  const appointment = await prisma.appointment.findFirst({
    where: {
      id: appointmentId,
      doctorId
    },
    select: doctorAppointmentSelect
  });

  if (!appointment) {
    throw new AppError("Appointment not found", 404, "APPOINTMENT_NOT_FOUND");
  }

  return toDoctorAppointmentResponse(appointment);
}

export async function completeDoctorVisit(
  input: CompleteDoctorVisitInput,
  options: CompleteDoctorVisitOptions = {}
) {
  const now = options.now ?? new Date();
  const clinicalNotes = input.clinicalNotes.trim();
  const followUpInstructions = input.followUpInstructions?.trim() || null;
  const prescriptions = input.prescriptions.map((prescription) => ({
    medicine: prescription.medicine.trim(),
    dosage: prescription.dosage.trim(),
    frequency: prescription.frequency,
    durationDays: prescription.durationDays,
    instructions: prescription.instructions?.trim() || null
  }));

  try {
    const appointment = await prisma.$transaction(
      async (tx) => {
        const doctorId = await getDoctorProfileIdForUser(input.doctorUserId, tx);
        const existingAppointment = await tx.appointment.findFirst({
          where: {
            id: input.appointmentId,
            doctorId
          },
          select: {
            id: true,
            status: true
          }
        });

        if (!existingAppointment) {
          throw new AppError("Appointment not found", 404, "APPOINTMENT_NOT_FOUND");
        }

        if (existingAppointment.status === AppointmentStatus.CANCELLED) {
          throw new AppError(
            "Cancelled appointment cannot be completed",
            409,
            "APPOINTMENT_CANCELLED"
          );
        }

        if (existingAppointment.status === AppointmentStatus.COMPLETED) {
          throw new AppError(
            "Appointment has already been completed",
            409,
            "APPOINTMENT_ALREADY_COMPLETED"
          );
        }

        const updatedAppointment = await tx.appointment.updateMany({
          where: {
            id: existingAppointment.id,
            doctorId,
            status: AppointmentStatus.BOOKED
          },
          data: {
            clinicalNotes,
            followUpInstructions,
            status: AppointmentStatus.COMPLETED,
            postSummaryStatus: AiSummaryStatus.PENDING
          }
        });

        if (updatedAppointment.count !== 1) {
          throw new AppError(
            "Appointment could not be completed due to a concurrent change",
            409,
            "APPOINTMENT_COMPLETE_CONFLICT"
          );
        }

        if (options.simulateFailureAfterAppointmentUpdate) {
          throw new Error("Simulated visit completion transaction failure");
        }

        const createdPrescriptions: Array<{
          id: string;
          frequency: PrescriptionFrequency;
          durationDays: number;
        }> = [];

        for (const prescription of prescriptions) {
          const createdPrescription = await tx.prescription.create({
            data: {
              appointmentId: existingAppointment.id,
              medicineName: prescription.medicine,
              dosage: prescription.dosage,
              frequency: prescription.frequency,
              durationDays: prescription.durationDays,
              instructions: prescription.instructions
            },
            select: {
              id: true,
              frequency: true,
              durationDays: true
            }
          });

          createdPrescriptions.push(createdPrescription);
        }

        await createMedicationRemindersForPrescriptions(
          tx,
          createdPrescriptions,
          now,
          {
            simulateFailureAfterReminderCreation:
              options.simulateReminderSchedulingFailure
          }
        );

        await tx.outboxJob.create({
          data: {
            type: postVisitSummaryJobType,
            payload: {
              appointmentId: existingAppointment.id
            },
            status: OutboxJobStatus.PENDING,
            attempts: 0,
            nextAttemptAt: now
          }
        });

        return tx.appointment.findUniqueOrThrow({
          where: {
            id: existingAppointment.id
          },
          select: doctorAppointmentSelect
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable
      }
    );

    return toDoctorAppointmentResponse(appointment);
  } catch (error) {
    if (isConflictError(error)) {
      throw new AppError(
        "Appointment could not be completed due to a concurrent change",
        409,
        "APPOINTMENT_COMPLETE_CONFLICT"
      );
    }

    throw error;
  }
}
