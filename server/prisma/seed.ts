import "dotenv/config";

import bcrypt from "bcrypt";
import {
  PrismaClient,
  UserRole,
  Weekday
} from "@prisma/client";

const prisma = new PrismaClient();

const seedPassword = "Password123!";
const weekdays: Weekday[] = [
  Weekday.MONDAY,
  Weekday.TUESDAY,
  Weekday.WEDNESDAY,
  Weekday.THURSDAY,
  Weekday.FRIDAY
];

type DoctorSeed = {
  name: string;
  email: string;
  specialization: string;
  bio: string;
  slotDurationMinutes: number;
  startTime: string;
  endTime: string;
};

const doctors: DoctorSeed[] = [
  {
    name: "Dr. Maya Patel",
    email: "maya.patel@example.com",
    specialization: "Cardiology",
    bio: "Cardiologist focused on preventive heart care.",
    slotDurationMinutes: 30,
    startTime: "09:00",
    endTime: "17:00"
  },
  {
    name: "Dr. Noah Williams",
    email: "noah.williams@example.com",
    specialization: "Dermatology",
    bio: "Dermatologist treating adult and adolescent skin concerns.",
    slotDurationMinutes: 20,
    startTime: "10:00",
    endTime: "16:00"
  },
  {
    name: "Dr. Aisha Khan",
    email: "aisha.khan@example.com",
    specialization: "Pediatrics",
    bio: "Pediatrician supporting routine and urgent child health visits.",
    slotDurationMinutes: 30,
    startTime: "08:30",
    endTime: "14:30"
  }
];

async function upsertUser(
  email: string,
  name: string,
  role: UserRole,
  passwordHash: string
) {
  return prisma.user.upsert({
    where: { email },
    update: {
      name,
      passwordHash,
      role
    },
    create: {
      email,
      name,
      passwordHash,
      role
    }
  });
}

async function seed() {
  const passwordHash = await bcrypt.hash(seedPassword, 10);

  await upsertUser(
    "admin@example.com",
    "Development Admin",
    UserRole.ADMIN,
    passwordHash
  );

  await upsertUser(
    "patient@example.com",
    "Development Patient",
    UserRole.PATIENT,
    passwordHash
  );

  for (const doctorSeed of doctors) {
    const user = await upsertUser(
      doctorSeed.email,
      doctorSeed.name,
      UserRole.DOCTOR,
      passwordHash
    );

    const doctorProfile = await prisma.doctorProfile.upsert({
      where: { userId: user.id },
      update: {
        specialization: doctorSeed.specialization,
        bio: doctorSeed.bio,
        slotDurationMinutes: doctorSeed.slotDurationMinutes
      },
      create: {
        userId: user.id,
        specialization: doctorSeed.specialization,
        bio: doctorSeed.bio,
        slotDurationMinutes: doctorSeed.slotDurationMinutes
      }
    });

    await prisma.doctorAvailability.deleteMany({
      where: { doctorId: doctorProfile.id }
    });

    await prisma.doctorAvailability.createMany({
      data: weekdays.map((weekday) => ({
        doctorId: doctorProfile.id,
        weekday,
        startTime: doctorSeed.startTime,
        endTime: doctorSeed.endTime
      }))
    });
  }

  const [userCount, doctorCount, availabilityCount] = await Promise.all([
    prisma.user.count(),
    prisma.doctorProfile.count(),
    prisma.doctorAvailability.count()
  ]);

  console.log(
    JSON.stringify({
      users: userCount,
      doctors: doctorCount,
      availabilityRules: availabilityCount
    })
  );
}

seed()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
