import { AppointmentStatus, Prisma, ReservationStatus } from "@prisma/client";

import { AppError } from "../middleware/app-error.js";
import { getBaseSlotsForDoctorDate } from "./doctor.service.js";
import { prisma } from "../utils/prisma.js";

export const holdDurationMs = 5 * 60 * 1000;

type HoldSlotInput = {
  patientId: string;
  doctorId: string;
  startAt: string;
};

const reservationSelect = {
  id: true,
  doctorId: true,
  patientId: true,
  startAt: true,
  expiresAt: true,
  status: true
};

type ReservationRecord = {
  id: string;
  doctorId: string;
  patientId: string;
  startAt: Date;
  expiresAt: Date | null;
  status: ReservationStatus;
};

function toReservationResponse(reservation: ReservationRecord) {
  return {
    id: reservation.id,
    doctorId: reservation.doctorId,
    startAt: reservation.startAt.toISOString(),
    expiresAt: reservation.expiresAt?.toISOString() ?? null,
    status: reservation.status
  };
}

function parseStartAt(startAt: string) {
  const parsed = new Date(startAt);

  if (Number.isNaN(parsed.getTime())) {
    throw new AppError("startAt must be a valid ISO-8601 timestamp", 400, "INVALID_START_AT");
  }

  return parsed;
}

function isUniqueConflict(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

export async function holdSlot(input: HoldSlotInput, now = new Date()) {
  const startAt = parseStartAt(input.startAt);
  const normalizedStartAt = startAt.toISOString();

  if (startAt.getTime() <= now.getTime()) {
    throw new AppError("Slot start time must be in the future", 400, "PAST_SLOT");
  }

  const dateKey = normalizedStartAt.slice(0, 10);
  const baseSlots = await getBaseSlotsForDoctorDate(input.doctorId, dateKey, now);
  const matchingBaseSlot = baseSlots.slots.find(
    (slot) => slot.startAt === normalizedStartAt
  );

  if (!matchingBaseSlot) {
    throw new AppError("Requested time is not an available slot", 400, "INVALID_SLOT");
  }

  const expiresAt = new Date(now.getTime() + holdDurationMs);

  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.slotReservation.updateMany({
        where: {
          doctorId: input.doctorId,
          startAt,
          status: ReservationStatus.HOLD,
          expiresAt: {
            lte: now
          }
        },
        data: {
          status: ReservationStatus.EXPIRED
        }
      });

      const existingReservation = await tx.slotReservation.findFirst({
        where: {
          doctorId: input.doctorId,
          startAt,
          status: {
            in: [ReservationStatus.HOLD, ReservationStatus.BOOKED]
          }
        },
        select: reservationSelect
      });

      if (existingReservation) {
        if (
          existingReservation.status === ReservationStatus.HOLD &&
          existingReservation.patientId === input.patientId &&
          existingReservation.expiresAt !== null &&
          existingReservation.expiresAt.getTime() > now.getTime()
        ) {
          return {
            reservation: existingReservation,
            reused: true
          };
        }

        throw new AppError("Slot is already reserved", 409, "SLOT_ALREADY_RESERVED");
      }

      const existingAppointment = await tx.appointment.findFirst({
        where: {
          doctorId: input.doctorId,
          startAt,
          status: {
            not: AppointmentStatus.CANCELLED
          }
        },
        select: {
          id: true
        }
      });

      if (existingAppointment) {
        throw new AppError("Slot is already booked", 409, "SLOT_ALREADY_BOOKED");
      }

      const createdReservation = await tx.slotReservation.create({
        data: {
          doctorId: input.doctorId,
          patientId: input.patientId,
          startAt,
          expiresAt,
          status: ReservationStatus.HOLD
        },
        select: reservationSelect
      });

      return {
        reservation: createdReservation,
        reused: false
      };
    });

    return {
      reservation: toReservationResponse(result.reservation),
      reused: result.reused
    };
  } catch (error) {
    if (isUniqueConflict(error)) {
      throw new AppError("Slot is already reserved", 409, "SLOT_ALREADY_RESERVED");
    }

    throw error;
  }
}
