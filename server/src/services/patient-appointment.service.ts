import {
  AppointmentStatus,
  OutboxJobStatus,
  Prisma,
  ReservationStatus
} from "@prisma/client";

import { AppError } from "../middleware/app-error.js";
import {
  createAppointmentReminderJob,
  deactivateAppointmentReminderJobs
} from "./appointment-reminder.service.js";
import { getBaseSlotsForDoctorDate } from "./doctor.service.js";
import { getPostVisitSummaryFallback } from "./post-visit-summary.service.js";
import { prisma } from "../utils/prisma.js";

export const cancellationOutboxJobTypes = [
  "CANCELLATION_CONFIRMATION_PATIENT",
  "CANCELLATION_NOTIFICATION_DOCTOR",
  "CALENDAR_DELETE"
] as const;

export const rescheduleOutboxJobTypes = [
  "RESCHEDULE_CONFIRMATION_PATIENT",
  "RESCHEDULE_NOTIFICATION_DOCTOR",
  "CALENDAR_UPDATE"
] as const;

type AppointmentMutationOptions = {
  now?: Date;
  simulateFailureAfterAppointmentUpdate?: boolean;
};

type RescheduleInput = {
  patientId: string;
  appointmentId: string;
  newReservationId: string;
};

const patientAppointmentSelect = {
  id: true,
  doctorId: true,
  startAt: true,
  endAt: true,
  status: true,
  symptoms: true,
  preSummaryStatus: true,
  postSummaryStatus: true,
  postVisitSummary: true,
  urgency: true,
  followUpInstructions: true,
  cancelledAt: true,
  createdAt: true,
  updatedAt: true,
  doctor: {
    select: {
      id: true,
      specialization: true,
      bio: true,
      slotDurationMinutes: true,
      user: {
        select: {
          id: true,
          name: true
        }
      }
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

type PatientAppointmentRecord = Prisma.AppointmentGetPayload<{
  select: typeof patientAppointmentSelect;
}>;

function toPatientAppointment(appointment: PatientAppointmentRecord) {
  return {
    id: appointment.id,
    doctorId: appointment.doctorId,
    doctor: {
      id: appointment.doctor.id,
      name: appointment.doctor.user.name,
      userId: appointment.doctor.user.id,
      specialization: appointment.doctor.specialization,
      bio: appointment.doctor.bio,
      slotDuration: appointment.doctor.slotDurationMinutes
    },
    startAt: appointment.startAt.toISOString(),
    endAt: appointment.endAt.toISOString(),
    status: appointment.status,
    symptoms: appointment.symptoms,
    preSummaryStatus: appointment.preSummaryStatus,
    postSummaryStatus: appointment.postSummaryStatus,
    postVisitSummary: appointment.postVisitSummary,
    postVisitSummaryFallback: getPostVisitSummaryFallback(
      appointment.postSummaryStatus
    ),
    urgency: appointment.urgency,
    followUpInstructions: appointment.followUpInstructions,
    prescriptions: appointment.prescriptions,
    cancelledAt: appointment.cancelledAt?.toISOString() ?? null,
    createdAt: appointment.createdAt.toISOString(),
    updatedAt: appointment.updatedAt.toISOString()
  };
}

function getDateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function isConflictError(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    ["P2002", "P2025", "P2028", "P2034"].includes(error.code)
  );
}

async function ensureReservationSlotStillValid(
  tx: Prisma.TransactionClient,
  reservation: {
    doctorId: string;
    startAt: Date;
  },
  now: Date
) {
  if (reservation.startAt.getTime() <= now.getTime()) {
    throw new AppError("Slot start time must be in the future", 400, "PAST_SLOT");
  }

  const dateKey = getDateKey(reservation.startAt);
  const baseSlots = await getBaseSlotsForDoctorDate(
    reservation.doctorId,
    dateKey,
    now,
    tx
  );
  const matchingSlot = baseSlots.slots.find(
    (slot) => slot.startAt === reservation.startAt.toISOString()
  );

  if (!matchingSlot) {
    throw new AppError(
      "Reserved slot is no longer available",
      409,
      "SLOT_NO_LONGER_AVAILABLE"
    );
  }

  return matchingSlot;
}

async function hasRescheduleOutboxJobs(
  tx: Prisma.TransactionClient,
  appointmentId: string
) {
  const rows = await tx.$queryRaw<Array<{ type: string }>>`
    SELECT type
    FROM "OutboxJob"
    WHERE payload->>'appointmentId' = ${appointmentId}
  `;

  return rows.some((row) =>
    rescheduleOutboxJobTypes.includes(
      row.type as (typeof rescheduleOutboxJobTypes)[number]
    )
  );
}

export async function listPatientAppointments(patientId: string) {
  const appointments = await prisma.appointment.findMany({
    where: {
      patientId
    },
    orderBy: [{ startAt: "asc" }, { createdAt: "asc" }],
    select: patientAppointmentSelect
  });

  return appointments.map(toPatientAppointment);
}

export async function getPatientAppointment(patientId: string, appointmentId: string) {
  const appointment = await prisma.appointment.findFirst({
    where: {
      id: appointmentId,
      patientId
    },
    select: patientAppointmentSelect
  });

  if (!appointment) {
    throw new AppError("Appointment not found", 404, "APPOINTMENT_NOT_FOUND");
  }

  return toPatientAppointment(appointment);
}

export async function cancelPatientAppointment(
  patientId: string,
  appointmentId: string,
  options: AppointmentMutationOptions = {}
) {
  const now = options.now ?? new Date();

  try {
    const appointment = await prisma.$transaction(
      async (tx) => {
        const existingAppointment = await tx.appointment.findFirst({
          where: {
            id: appointmentId,
            patientId
          },
          select: {
            id: true,
            doctorId: true,
            status: true,
            slotReservation: {
              select: {
                id: true,
                status: true
              }
            }
          }
        });

        if (!existingAppointment) {
          throw new AppError("Appointment not found", 404, "APPOINTMENT_NOT_FOUND");
        }

        if (existingAppointment.status !== AppointmentStatus.BOOKED) {
          throw new AppError(
            "Appointment cannot be cancelled",
            409,
            "APPOINTMENT_NOT_CANCELLABLE"
          );
        }

        const cancelledAppointment = await tx.appointment.update({
          where: {
            id: existingAppointment.id
          },
          data: {
            status: AppointmentStatus.CANCELLED,
            cancelledAt: now
          },
          select: patientAppointmentSelect
        });

        if (options.simulateFailureAfterAppointmentUpdate) {
          throw new Error("Simulated cancellation transaction failure");
        }

        if (existingAppointment.slotReservation) {
          const releasedReservation = await tx.slotReservation.updateMany({
            where: {
              id: existingAppointment.slotReservation.id,
              appointmentId: existingAppointment.id,
              status: ReservationStatus.BOOKED
            },
            data: {
              status: ReservationStatus.RELEASED,
              appointmentId: null
            }
          });

          if (releasedReservation.count !== 1) {
            throw new AppError(
              "Appointment reservation could not be released",
              409,
              "RESERVATION_RELEASE_CONFLICT"
            );
          }
        }

        await deactivateAppointmentReminderJobs(
          tx,
          existingAppointment.id,
          "Appointment reminder obsolete after cancellation"
        );

        await tx.outboxJob.createMany({
          data: [
            {
              type: "CANCELLATION_CONFIRMATION_PATIENT",
              payload: {
                appointmentId: existingAppointment.id,
                patientId
              },
              status: OutboxJobStatus.PENDING,
              attempts: 0,
              nextAttemptAt: now
            },
            {
              type: "CANCELLATION_NOTIFICATION_DOCTOR",
              payload: {
                appointmentId: existingAppointment.id,
                doctorId: existingAppointment.doctorId
              },
              status: OutboxJobStatus.PENDING,
              attempts: 0,
              nextAttemptAt: now
            },
            {
              type: "CALENDAR_DELETE",
              payload: {
                appointmentId: existingAppointment.id
              },
              status: OutboxJobStatus.PENDING,
              attempts: 0,
              nextAttemptAt: now
            }
          ]
        });

        return cancelledAppointment;
      }
    );

    return toPatientAppointment(appointment);
  } catch (error) {
    if (isConflictError(error)) {
      throw new AppError(
        "Appointment could not be cancelled due to a concurrent change",
        409,
        "APPOINTMENT_CANCEL_CONFLICT"
      );
    }

    throw error;
  }
}

export async function reschedulePatientAppointment(
  input: RescheduleInput,
  options: AppointmentMutationOptions = {}
) {
  const now = options.now ?? new Date();

  try {
    const result = await prisma.$transaction(
      async (tx) => {
        const [appointment, newReservation] = await Promise.all([
          tx.appointment.findFirst({
            where: {
              id: input.appointmentId,
              patientId: input.patientId
            },
            select: {
              id: true,
              doctorId: true,
              startAt: true,
              status: true,
              slotReservation: {
                select: {
                  id: true,
                  status: true
                }
              }
            }
          }),
          tx.slotReservation.findUnique({
            where: {
              id: input.newReservationId
            },
            select: {
              id: true,
              patientId: true,
              doctorId: true,
              startAt: true,
              expiresAt: true,
              status: true,
              appointmentId: true
            }
          })
        ]);

        if (!appointment) {
          throw new AppError("Appointment not found", 404, "APPOINTMENT_NOT_FOUND");
        }

        if (appointment.status !== AppointmentStatus.BOOKED) {
          throw new AppError(
            "Appointment cannot be rescheduled",
            409,
            "APPOINTMENT_NOT_RESCHEDULABLE"
          );
        }

        if (!newReservation || newReservation.patientId !== input.patientId) {
          throw new AppError("Reservation not found", 404, "RESERVATION_NOT_FOUND");
        }

        if (
          newReservation.status === ReservationStatus.BOOKED &&
          newReservation.appointmentId === appointment.id
        ) {
          const currentAppointment = await tx.appointment.findUniqueOrThrow({
            where: {
              id: appointment.id
            },
            select: patientAppointmentSelect
          });

          return {
            appointment: currentAppointment,
            reused: true
          };
        }

        if (await hasRescheduleOutboxJobs(tx, appointment.id)) {
          throw new AppError(
            "Appointment already has a pending reschedule",
            409,
            "APPOINTMENT_RESCHEDULE_ALREADY_REQUESTED"
          );
        }

        if (newReservation.status !== ReservationStatus.HOLD) {
          throw new AppError(
            "Reservation is not an active hold",
            409,
            "RESERVATION_NOT_ACTIVE"
          );
        }

        if (
          newReservation.expiresAt === null ||
          newReservation.expiresAt.getTime() <= now.getTime()
        ) {
          throw new AppError("Reservation hold has expired", 409, "RESERVATION_EXPIRED");
        }

        const matchingSlot = await ensureReservationSlotStillValid(
          tx,
          newReservation,
          now
        );

        const conflictingAppointment = await tx.appointment.findFirst({
          where: {
            id: {
              not: appointment.id
            },
            doctorId: newReservation.doctorId,
            startAt: newReservation.startAt,
            status: {
              not: AppointmentStatus.CANCELLED
            }
          },
          select: {
            id: true
          }
        });

        if (conflictingAppointment) {
          throw new AppError("Slot is already booked", 409, "SLOT_ALREADY_BOOKED");
        }

        const rescheduledAppointment = await tx.appointment.update({
          where: {
            id: appointment.id
          },
          data: {
            doctorId: newReservation.doctorId,
            startAt: newReservation.startAt,
            endAt: new Date(matchingSlot.endAt)
          },
          select: patientAppointmentSelect
        });

        if (options.simulateFailureAfterAppointmentUpdate) {
          throw new Error("Simulated reschedule transaction failure");
        }

        if (appointment.slotReservation) {
          const releasedOldReservation = await tx.slotReservation.updateMany({
            where: {
              id: appointment.slotReservation.id,
              appointmentId: appointment.id,
              status: ReservationStatus.BOOKED
            },
            data: {
              status: ReservationStatus.RELEASED,
              appointmentId: null
            }
          });

          if (releasedOldReservation.count !== 1) {
            throw new AppError(
              "Appointment reservation could not be released",
              409,
              "RESERVATION_RELEASE_CONFLICT"
            );
          }
        }

        const bookedNewReservation = await tx.slotReservation.updateMany({
          where: {
            id: newReservation.id,
            patientId: input.patientId,
            status: ReservationStatus.HOLD,
            appointmentId: null
          },
          data: {
            status: ReservationStatus.BOOKED,
            appointmentId: appointment.id
          }
        });

        if (bookedNewReservation.count !== 1) {
          throw new AppError(
            "Reservation could not be booked",
            409,
            "RESERVATION_BOOKING_CONFLICT"
          );
        }

        await tx.outboxJob.createMany({
          data: [
            {
              type: "RESCHEDULE_CONFIRMATION_PATIENT",
              payload: {
                appointmentId: appointment.id,
                patientId: input.patientId
              },
              status: OutboxJobStatus.PENDING,
              attempts: 0,
              nextAttemptAt: now
            },
            {
              type: "RESCHEDULE_NOTIFICATION_DOCTOR",
              payload: {
                appointmentId: appointment.id,
                previousDoctorId: appointment.doctorId,
                doctorId: newReservation.doctorId
              },
              status: OutboxJobStatus.PENDING,
              attempts: 0,
              nextAttemptAt: now
            },
            {
              type: "CALENDAR_UPDATE",
              payload: {
                appointmentId: appointment.id
              },
              status: OutboxJobStatus.PENDING,
              attempts: 0,
              nextAttemptAt: now
            }
          ]
        });

        await deactivateAppointmentReminderJobs(
          tx,
          appointment.id,
          "Appointment reminder obsolete after reschedule"
        );

        await createAppointmentReminderJob(tx, {
          appointmentId: appointment.id,
          patientId: input.patientId,
          startAt: newReservation.startAt,
          now
        });

        return {
          appointment: rescheduledAppointment,
          reused: false
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable
      }
    );

    return {
      appointment: toPatientAppointment(result.appointment),
      reused: result.reused
    };
  } catch (error) {
    if (isConflictError(error)) {
      throw new AppError(
        "Appointment could not be rescheduled due to a concurrent change",
        409,
        "APPOINTMENT_RESCHEDULE_CONFLICT"
      );
    }

    throw error;
  }
}
