import {
  AiSummaryStatus,
  AppointmentStatus,
  OutboxJobStatus,
  Prisma,
  ReservationStatus
} from "@prisma/client";

import { AppError } from "../middleware/app-error.js";
import { getBaseSlotsForDoctorDate } from "./doctor.service.js";
import { prisma } from "../utils/prisma.js";

export const maxSymptomsLength = 5_000;

export const bookingOutboxJobTypes = [
  "BOOKING_CONFIRMATION_PATIENT",
  "BOOKING_CONFIRMATION_DOCTOR",
  "PRE_VISIT_SUMMARY",
  "CALENDAR_CREATE"
] as const;

type ConfirmAppointmentInput = {
  patientId: string;
  reservationId: string;
  symptoms: string;
};

type ConfirmAppointmentOptions = {
  now?: Date;
  simulateFailureAfterAppointmentCreate?: boolean;
};

const appointmentSelect = {
  id: true,
  doctorId: true,
  startAt: true,
  endAt: true,
  status: true,
  symptoms: true,
  preSummaryStatus: true
};

const serializableRetryLimit = 3;

type AppointmentRecord = Prisma.AppointmentGetPayload<{
  select: typeof appointmentSelect;
}>;

function toAppointmentResponse(appointment: AppointmentRecord) {
  return {
    id: appointment.id,
    doctorId: appointment.doctorId,
    startAt: appointment.startAt.toISOString(),
    endAt: appointment.endAt.toISOString(),
    status: appointment.status,
    symptoms: appointment.symptoms,
    preSummaryStatus: appointment.preSummaryStatus
  };
}

function isUniqueConflict(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

function isSerializationConflict(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2034"
  );
}

function getDateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

export async function confirmAppointment(
  input: ConfirmAppointmentInput,
  options: ConfirmAppointmentOptions = {}
) {
  const now = options.now ?? new Date();
  const symptoms = input.symptoms.trim();

  for (let attempt = 1; attempt <= serializableRetryLimit; attempt += 1) {
    try {
      const result = await prisma.$transaction(
        async (tx) => {
        const reservation = await tx.slotReservation.findUnique({
          where: {
            id: input.reservationId
          },
          select: {
            id: true,
            patientId: true,
            doctorId: true,
            startAt: true,
            expiresAt: true,
            status: true,
            appointmentId: true,
            appointment: {
              select: appointmentSelect
            }
          }
        });

        if (!reservation) {
          throw new AppError("Reservation not found", 404, "RESERVATION_NOT_FOUND");
        }

        if (reservation.patientId !== input.patientId) {
          throw new AppError("Reservation not found", 404, "RESERVATION_NOT_FOUND");
        }

        if (reservation.status === ReservationStatus.BOOKED) {
          if (reservation.appointment) {
            return {
              appointment: reservation.appointment,
              reused: true
            };
          }

          throw new AppError(
            "Reservation is already booked",
            409,
            "RESERVATION_ALREADY_BOOKED"
          );
        }

        if (reservation.status !== ReservationStatus.HOLD) {
          throw new AppError("Reservation is not an active hold", 409, "RESERVATION_NOT_ACTIVE");
        }

        if (
          reservation.expiresAt === null ||
          reservation.expiresAt.getTime() <= now.getTime()
        ) {
          throw new AppError("Reservation hold has expired", 409, "RESERVATION_EXPIRED");
        }

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

        const conflictingAppointment = await tx.appointment.findFirst({
          where: {
            doctorId: reservation.doctorId,
            startAt: reservation.startAt,
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

        const appointment = await tx.appointment.create({
          data: {
            patientId: input.patientId,
            doctorId: reservation.doctorId,
            startAt: reservation.startAt,
            endAt: new Date(matchingSlot.endAt),
            status: AppointmentStatus.BOOKED,
            symptoms,
            preSummaryStatus: AiSummaryStatus.PENDING
          },
          select: appointmentSelect
        });

        if (options.simulateFailureAfterAppointmentCreate) {
          throw new Error("Simulated booking transaction failure");
        }

        const reservationUpdate = await tx.slotReservation.updateMany({
          where: {
            id: reservation.id,
            patientId: input.patientId,
            status: ReservationStatus.HOLD,
            appointmentId: null
          },
          data: {
            status: ReservationStatus.BOOKED,
            appointmentId: appointment.id
          }
        });

        if (reservationUpdate.count !== 1) {
          throw new AppError(
            "Reservation has already been confirmed",
            409,
            "RESERVATION_ALREADY_CONFIRMED"
          );
        }

        const nextAttemptAt = now;
        await tx.outboxJob.createMany({
          data: [
            {
              type: "BOOKING_CONFIRMATION_PATIENT",
              payload: {
                appointmentId: appointment.id,
                patientId: input.patientId
              },
              status: OutboxJobStatus.PENDING,
              attempts: 0,
              nextAttemptAt
            },
            {
              type: "BOOKING_CONFIRMATION_DOCTOR",
              payload: {
                appointmentId: appointment.id,
                doctorId: reservation.doctorId
              },
              status: OutboxJobStatus.PENDING,
              attempts: 0,
              nextAttemptAt
            },
            {
              type: "PRE_VISIT_SUMMARY",
              payload: {
                appointmentId: appointment.id
              },
              status: OutboxJobStatus.PENDING,
              attempts: 0,
              nextAttemptAt
            },
            {
              type: "CALENDAR_CREATE",
              payload: {
                appointmentId: appointment.id,
                doctorId: reservation.doctorId
              },
              status: OutboxJobStatus.PENDING,
              attempts: 0,
              nextAttemptAt
            }
          ]
        });

        return {
          appointment,
          reused: false
        };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable
        }
      );

      return {
        appointment: toAppointmentResponse(result.appointment),
        reused: result.reused
      };
    } catch (error) {
      if (isSerializationConflict(error) && attempt < serializableRetryLimit) {
        continue;
      }

      if (isSerializationConflict(error)) {
        throw new AppError(
          "Appointment could not be confirmed due to a concurrent schedule change",
          409,
          "APPOINTMENT_CONFIRM_CONFLICT"
        );
      }

      if (isUniqueConflict(error)) {
        throw new AppError("Slot is already booked", 409, "SLOT_ALREADY_BOOKED");
      }

      throw error;
    }
  }

  throw new AppError(
    "Appointment could not be confirmed due to a concurrent schedule change",
    409,
    "APPOINTMENT_CONFIRM_CONFLICT"
  );
}
