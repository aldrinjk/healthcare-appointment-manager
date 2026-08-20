import {
  AppointmentStatus,
  ReservationStatus,
  Weekday,
  type Prisma
} from "@prisma/client";

import { AppError } from "../middleware/app-error.js";
import { prisma } from "../utils/prisma.js";

export const applicationTimeZone = "UTC";

const doctorPublicSelect = {
  id: true,
  specialization: true,
  bio: true,
  slotDurationMinutes: true,
  createdAt: true,
  updatedAt: true,
  user: {
    select: {
      id: true,
      name: true
    }
  },
  availabilities: {
    orderBy: [{ weekday: "asc" as const }, { startTime: "asc" as const }],
    select: {
      id: true,
      weekday: true,
      startTime: true,
      endTime: true
    }
  },
  leaves: {
    orderBy: { date: "asc" as const },
    select: {
      id: true,
      date: true,
      reason: true
    }
  }
};

type DoctorPublicRecord = Prisma.DoctorProfileGetPayload<{
  select: typeof doctorPublicSelect;
}>;

export type GeneratedSlot = {
  startAt: string;
  endAt: string;
};

type DateRange = {
  dateStart: Date;
  dateEnd: Date;
  dateKey: string;
};

function toPublicDoctor(doctor: DoctorPublicRecord) {
  return {
    id: doctor.id,
    name: doctor.user.name,
    userId: doctor.user.id,
    specialization: doctor.specialization,
    bio: doctor.bio,
    slotDuration: doctor.slotDurationMinutes,
    createdAt: doctor.createdAt,
    updatedAt: doctor.updatedAt,
    availabilities: doctor.availabilities,
    leaves: doctor.leaves
  };
}

export function parseDateParam(date: string): DateRange {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new AppError("Date must use YYYY-MM-DD format", 400, "INVALID_DATE");
  }

  const dateStart = new Date(`${date}T00:00:00.000Z`);

  if (Number.isNaN(dateStart.getTime()) || dateStart.toISOString().slice(0, 10) !== date) {
    throw new AppError("Date must be a valid calendar date", 400, "INVALID_DATE");
  }

  const dateEnd = new Date(dateStart.getTime() + 24 * 60 * 60 * 1000);

  return {
    dateStart,
    dateEnd,
    dateKey: date
  };
}

function getWeekday(date: Date) {
  const weekdayByUtcDay: Weekday[] = [
    Weekday.SUNDAY,
    Weekday.MONDAY,
    Weekday.TUESDAY,
    Weekday.WEDNESDAY,
    Weekday.THURSDAY,
    Weekday.FRIDAY,
    Weekday.SATURDAY
  ];

  return weekdayByUtcDay[date.getUTCDay()];
}

function combineDateAndTime(dateKey: string, time: string) {
  return new Date(`${dateKey}T${time}:00.000Z`);
}

function generateSlotsFromAvailability(
  dateKey: string,
  slotDurationMinutes: number,
  availabilities: Array<{ startTime: string; endTime: string }>,
  now: Date
) {
  const slotDurationMs = slotDurationMinutes * 60 * 1000;
  const slots: GeneratedSlot[] = [];

  for (const availability of availabilities) {
    let slotStart = combineDateAndTime(dateKey, availability.startTime);
    const availabilityEnd = combineDateAndTime(dateKey, availability.endTime);

    while (slotStart.getTime() + slotDurationMs <= availabilityEnd.getTime()) {
      const slotEnd = new Date(slotStart.getTime() + slotDurationMs);

      if (slotStart.getTime() > now.getTime()) {
        slots.push({
          startAt: slotStart.toISOString(),
          endAt: slotEnd.toISOString()
        });
      }

      slotStart = slotEnd;
    }
  }

  return slots;
}

function isBlockedByReservation(
  slotStartMs: number,
  reservation: {
    startAt: Date;
    status: ReservationStatus;
    expiresAt: Date | null;
  },
  now: Date
) {
  if (reservation.startAt.getTime() !== slotStartMs) {
    return false;
  }

  if (reservation.status === ReservationStatus.BOOKED) {
    return true;
  }

  return (
    reservation.status === ReservationStatus.HOLD &&
    (reservation.expiresAt === null || reservation.expiresAt.getTime() > now.getTime())
  );
}

function isBlockedByAppointment(
  slotStartMs: number,
  appointment: {
    startAt: Date;
    status: AppointmentStatus;
  }
) {
  return (
    appointment.startAt.getTime() === slotStartMs &&
    appointment.status !== AppointmentStatus.CANCELLED
  );
}

export async function listPublicDoctors(specialization?: string) {
  const doctors = await prisma.doctorProfile.findMany({
    where: specialization
      ? {
          specialization: {
            contains: specialization.trim(),
            mode: "insensitive"
          }
        }
      : undefined,
    orderBy: { createdAt: "asc" },
    select: doctorPublicSelect
  });

  return doctors.map(toPublicDoctor);
}

export async function getPublicDoctor(doctorId: string) {
  const todayUtc = new Date();
  todayUtc.setUTCHours(0, 0, 0, 0);

  const doctor = await prisma.doctorProfile.findUnique({
    where: { id: doctorId },
    select: {
      ...doctorPublicSelect,
      leaves: {
        where: {
          date: {
            gte: todayUtc
          }
        },
        orderBy: { date: "asc" },
        select: {
          id: true,
          date: true,
          reason: true
        }
      }
    }
  });

  if (!doctor) {
    throw new AppError("Doctor not found", 404, "DOCTOR_NOT_FOUND");
  }

  return toPublicDoctor(doctor);
}

export async function getBaseSlotsForDoctorDate(
  doctorId: string,
  date: string,
  now = new Date()
) {
  const { dateStart, dateKey } = parseDateParam(date);
  const doctor = await prisma.doctorProfile.findUnique({
    where: { id: doctorId },
    select: {
      id: true,
      slotDurationMinutes: true,
      availabilities: {
        where: {
          weekday: getWeekday(dateStart)
        },
        orderBy: { startTime: "asc" },
        select: {
          startTime: true,
          endTime: true
        }
      },
      leaves: {
        where: {
          date: dateStart
        },
        select: {
          id: true
        }
      }
    }
  });

  if (!doctor) {
    throw new AppError("Doctor not found", 404, "DOCTOR_NOT_FOUND");
  }

  if (doctor.availabilities.length === 0 || doctor.leaves.length > 0) {
    return {
      date,
      timeZone: applicationTimeZone,
      slots: [] as GeneratedSlot[]
    };
  }

  return {
    date,
    timeZone: applicationTimeZone,
    slots: generateSlotsFromAvailability(
      dateKey,
      doctor.slotDurationMinutes,
      doctor.availabilities,
      now
    )
  };
}

export async function getAvailableSlots(
  doctorId: string,
  date: string,
  now = new Date()
) {
  const { dateStart, dateEnd } = parseDateParam(date);
  const baseSlots = await getBaseSlotsForDoctorDate(doctorId, date, now);

  const [reservations, appointments] = await Promise.all([
    prisma.slotReservation.findMany({
      where: {
        doctorId,
        startAt: {
          gte: dateStart,
          lt: dateEnd
        },
        status: {
          in: [ReservationStatus.HOLD, ReservationStatus.BOOKED]
        }
      },
      select: {
        startAt: true,
        status: true,
        expiresAt: true
      }
    }),
    prisma.appointment.findMany({
      where: {
        doctorId,
        startAt: {
          gte: dateStart,
          lt: dateEnd
        },
        status: {
          not: AppointmentStatus.CANCELLED
        }
      },
      select: {
        startAt: true,
        status: true
      }
    })
  ]);

  const slots = baseSlots.slots.filter((slot) => {
    const slotStartMs = new Date(slot.startAt).getTime();

    return (
      !reservations.some((reservation) =>
        isBlockedByReservation(slotStartMs, reservation, now)
      ) &&
      !appointments.some((appointment) =>
        isBlockedByAppointment(slotStartMs, appointment)
      )
    );
  });

  return {
    date,
    timeZone: applicationTimeZone,
    slots
  };
}
