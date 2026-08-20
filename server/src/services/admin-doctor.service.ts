import bcrypt from "bcrypt";
import { Prisma, UserRole, Weekday } from "@prisma/client";

import { AppError } from "../middleware/app-error.js";
import { normalizeEmail, toSafeUser } from "./auth.service.js";
import { prisma } from "../utils/prisma.js";

const passwordSaltRounds = 12;

export type CreateDoctorInput = {
  name: string;
  email: string;
  password: string;
  specialization: string;
  slotDuration: number;
};

export type UpdateDoctorInput = {
  name?: string;
  specialization?: string;
  slotDuration?: number;
};

export type CreateAvailabilityInput = {
  weekday: Weekday;
  startTime: string;
  endTime: string;
};

export type CreateLeaveInput = {
  date: string;
  reason?: string;
};

const doctorSelect = {
  id: true,
  specialization: true,
  bio: true,
  slotDurationMinutes: true,
  createdAt: true,
  updatedAt: true,
  user: {
    select: {
      id: true,
      name: true,
      email: true,
      role: true
    }
  },
  availabilities: {
    orderBy: [{ weekday: "asc" as const }, { startTime: "asc" as const }],
    select: {
      id: true,
      weekday: true,
      startTime: true,
      endTime: true,
      createdAt: true,
      updatedAt: true
    }
  },
  leaves: {
    orderBy: { date: "asc" as const },
    select: {
      id: true,
      date: true,
      reason: true,
      createdAt: true,
      updatedAt: true
    }
  }
};

type DoctorRecord = Prisma.DoctorProfileGetPayload<{
  select: typeof doctorSelect;
}>;

function toDoctorResponse(doctor: DoctorRecord) {
  return {
    id: doctor.id,
    specialization: doctor.specialization,
    bio: doctor.bio,
    slotDuration: doctor.slotDurationMinutes,
    createdAt: doctor.createdAt,
    updatedAt: doctor.updatedAt,
    user: toSafeUser(doctor.user),
    availabilities: doctor.availabilities,
    leaves: doctor.leaves
  };
}

function handleUniqueError(error: unknown, message: string, code: string): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    throw new AppError(message, 409, code);
  }

  throw error;
}

function parseLeaveDate(date: string) {
  const parsed = new Date(`${date}T00:00:00.000Z`);

  if (Number.isNaN(parsed.getTime())) {
    throw new AppError("Leave date is invalid", 400, "INVALID_LEAVE_DATE");
  }

  return parsed;
}

export async function listDoctors() {
  const doctors = await prisma.doctorProfile.findMany({
    orderBy: { createdAt: "asc" },
    select: doctorSelect
  });

  return doctors.map(toDoctorResponse);
}

export async function getDoctor(doctorId: string) {
  const doctor = await prisma.doctorProfile.findUnique({
    where: { id: doctorId },
    select: doctorSelect
  });

  if (!doctor) {
    throw new AppError("Doctor not found", 404, "DOCTOR_NOT_FOUND");
  }

  return toDoctorResponse(doctor);
}

export async function createDoctor(input: CreateDoctorInput) {
  const email = normalizeEmail(input.email);
  const passwordHash = await bcrypt.hash(input.password, passwordSaltRounds);

  try {
    const doctor = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: input.name.trim(),
          email,
          passwordHash,
          role: UserRole.DOCTOR
        },
        select: {
          id: true
        }
      });

      return tx.doctorProfile.create({
        data: {
          userId: user.id,
          specialization: input.specialization.trim(),
          slotDurationMinutes: input.slotDuration
        },
        select: doctorSelect
      });
    });

    return toDoctorResponse(doctor);
  } catch (error) {
    return handleUniqueError(
      error,
      "Email is already registered",
      "EMAIL_ALREADY_REGISTERED"
    );
  }
}

export async function updateDoctor(doctorId: string, input: UpdateDoctorInput) {
  await getDoctor(doctorId);

  const userData =
    input.name === undefined
      ? undefined
      : {
          name: input.name.trim()
        };

  const profileData: Prisma.DoctorProfileUpdateInput = {};

  if (input.specialization !== undefined) {
    profileData.specialization = input.specialization.trim();
  }

  if (input.slotDuration !== undefined) {
    profileData.slotDurationMinutes = input.slotDuration;
  }

  const doctor = await prisma.$transaction(async (tx) => {
    const existingDoctor = await tx.doctorProfile.findUniqueOrThrow({
      where: { id: doctorId },
      select: {
        userId: true
      }
    });

    if (userData) {
      await tx.user.update({
        where: { id: existingDoctor.userId },
        data: userData
      });
    }

    if (Object.keys(profileData).length > 0) {
      await tx.doctorProfile.update({
        where: { id: doctorId },
        data: profileData
      });
    }

    return tx.doctorProfile.findUniqueOrThrow({
      where: { id: doctorId },
      select: doctorSelect
    });
  });

  return toDoctorResponse(doctor);
}

export async function addAvailability(
  doctorId: string,
  input: CreateAvailabilityInput
) {
  await getDoctor(doctorId);

  try {
    const availability = await prisma.doctorAvailability.create({
      data: {
        doctorId,
        weekday: input.weekday,
        startTime: input.startTime,
        endTime: input.endTime
      },
      select: {
        id: true,
        weekday: true,
        startTime: true,
        endTime: true,
        createdAt: true,
        updatedAt: true
      }
    });

    return availability;
  } catch (error) {
    return handleUniqueError(
      error,
      "Availability rule already exists",
      "AVAILABILITY_ALREADY_EXISTS"
    );
  }
}

export async function addLeave(doctorId: string, input: CreateLeaveInput) {
  await getDoctor(doctorId);

  try {
    const leave = await prisma.doctorLeave.create({
      data: {
        doctorId,
        date: parseLeaveDate(input.date),
        reason: input.reason?.trim()
      },
      select: {
        id: true,
        date: true,
        reason: true,
        createdAt: true,
        updatedAt: true
      }
    });

    return leave;
  } catch (error) {
    return handleUniqueError(error, "Leave already exists", "LEAVE_ALREADY_EXISTS");
  }
}

export async function removeLeave(doctorId: string, leaveId: string) {
  const result = await prisma.doctorLeave.deleteMany({
    where: {
      id: leaveId,
      doctorId
    }
  });

  if (result.count === 0) {
    throw new AppError("Leave not found", 404, "LEAVE_NOT_FOUND");
  }
}
