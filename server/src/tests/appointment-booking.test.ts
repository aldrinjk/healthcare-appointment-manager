import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import bcrypt from "bcrypt";
import {
  AppointmentStatus,
  OutboxJobStatus,
  ReservationStatus,
  UserRole,
  Weekday
} from "@prisma/client";

process.env.NODE_ENV = "test";

const [
  { app },
  { prisma },
  { bookingOutboxJobTypes, confirmAppointment, maxSymptomsLength }
] = await Promise.all([
  import("../app.js"),
  import("../utils/prisma.js"),
  import("../services/appointment-booking.service.js")
]);

const testEmails = new Set<string>();
const doctorIds = new Set<string>();
const patientIds = new Set<string>();
let server: Server;
let baseUrl: string;
let patientToken: string;
let doctorToken: string;
let adminToken: string;
let seededPatientId: string;

type JsonResponse = {
  status: number;
  body: unknown;
};

type LoginResponse = {
  token: string;
  user: {
    id: string;
    role: string;
  };
};

type BookingResponse = {
  appointment: {
    id: string;
    doctorId: string;
    startAt: string;
    endAt: string;
    status: string;
    symptoms: string;
    preSummaryStatus: string;
    passwordHash?: string;
    patientId?: string;
    email?: string;
  };
};

function containsSensitiveField(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsSensitiveField);
  }

  if (typeof value !== "object" || value === null) {
    return false;
  }

  return Object.entries(value).some(
    ([key, childValue]) =>
      key === "passwordHash" ||
      key === "email" ||
      key === "patientId" ||
      containsSensitiveField(childValue)
  );
}

function makeEmail(prefix: string) {
  const email = `${prefix}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2)}@example.com`;
  testEmails.add(email);
  return email;
}

function formatUtcDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function nextUtcDateForWeekday(targetWeekday: number, offsetDays = 14) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + offsetDays);

  while (date.getUTCDay() !== targetWeekday) {
    date.setUTCDate(date.getUTCDate() + 1);
  }

  return formatUtcDate(date);
}

function startAt(date: string, time: string) {
  return `${date}T${time}:00.000Z`;
}

function dateAt(date: string, time: string) {
  return new Date(startAt(date, time));
}

async function requestJson(
  path: string,
  options: RequestInit = {}
): Promise<JsonResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...options.headers
    }
  });

  return {
    status: response.status,
    body: await response.json()
  };
}

async function login(email: string, password = "Password123!") {
  const response = await requestJson("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });

  assert.equal(response.status, 200);

  return response.body as LoginResponse;
}

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`
  };
}

async function bookingRequest(
  token: string | undefined,
  reservationId: string,
  symptoms: unknown = "Persistent cough and mild fever."
) {
  return requestJson("/api/appointments", {
    method: "POST",
    headers: token ? authHeaders(token) : {},
    body: JSON.stringify({
      reservationId,
      symptoms
    })
  });
}

async function createPatient() {
  const email = makeEmail("booking.patient");
  const passwordHash = await bcrypt.hash("Password123!", 10);
  const user = await prisma.user.create({
    data: {
      name: "Booking Test Patient",
      email,
      passwordHash,
      role: UserRole.PATIENT
    },
    select: { id: true }
  });

  patientIds.add(user.id);

  return {
    id: user.id,
    email,
    token: (await login(email)).token
  };
}

async function createDoctor(options: {
  weekday?: Weekday;
  startTime?: string;
  endTime?: string;
  slotDuration?: number;
  leaveDate?: string;
} = {}) {
  const email = makeEmail("booking.doctor");
  const doctor = await prisma.user.create({
    data: {
      name: "Dr. Booking Test",
      email,
      passwordHash: "not-used-in-booking-tests",
      role: UserRole.DOCTOR,
      doctorProfile: {
        create: {
          specialization: "Booking Testing",
          slotDurationMinutes: options.slotDuration ?? 30,
          availabilities: {
            create: {
              weekday: options.weekday ?? Weekday.MONDAY,
              startTime: options.startTime ?? "09:00",
              endTime: options.endTime ?? "10:00"
            }
          },
          leaves: options.leaveDate
            ? {
                create: {
                  date: new Date(`${options.leaveDate}T00:00:00.000Z`),
                  reason: "Booking test leave"
                }
              }
            : undefined
        }
      }
    },
    select: {
      doctorProfile: {
        select: {
          id: true
        }
      }
    }
  });

  assert.ok(doctor.doctorProfile);
  doctorIds.add(doctor.doctorProfile.id);

  return doctor.doctorProfile.id;
}

async function createHold(options: {
  doctorId: string;
  patientId?: string;
  slotStartAt: string;
  expiresAt?: Date | null;
  status?: ReservationStatus;
}) {
  return prisma.slotReservation.create({
    data: {
      doctorId: options.doctorId,
      patientId: options.patientId ?? seededPatientId,
      startAt: new Date(options.slotStartAt),
      status: options.status ?? ReservationStatus.HOLD,
      expiresAt:
        options.expiresAt === undefined
          ? new Date(Date.now() + 5 * 60 * 1000)
          : options.expiresAt
    },
    select: {
      id: true
    }
  });
}

async function createConflictingAppointment(options: {
  doctorId: string;
  patientId?: string;
  slotStartAt: string;
  durationMinutes?: number;
}) {
  const start = new Date(options.slotStartAt);

  return prisma.appointment.create({
    data: {
      doctorId: options.doctorId,
      patientId: options.patientId ?? seededPatientId,
      startAt: start,
      endAt: new Date(start.getTime() + (options.durationMinutes ?? 30) * 60 * 1000),
      status: AppointmentStatus.BOOKED,
      symptoms: "Existing conflicting appointment"
    },
    select: {
      id: true
    }
  });
}

async function countOutboxJobsForAppointment(appointmentId: string) {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM "OutboxJob"
    WHERE payload->>'appointmentId' = ${appointmentId}
  `;

  return Number(rows[0]?.count ?? 0);
}

async function outboxStatusesForAppointment(appointmentId: string) {
  return prisma.outboxJob.findMany({
    where: {
      type: {
        in: [...bookingOutboxJobTypes]
      },
      payload: {
        path: ["appointmentId"],
        equals: appointmentId
      }
    },
    select: {
      status: true
    }
  });
}

async function countBookingOutboxJobs() {
  return prisma.outboxJob.count({
    where: {
      type: {
        in: [...bookingOutboxJobTypes]
      }
    }
  });
}

before(async () => {
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [patientLogin, doctorLogin, adminLogin] = await Promise.all([
    login("patient@example.com"),
    login("maya.patel@example.com"),
    login("admin@example.com")
  ]);

  patientToken = patientLogin.token;
  seededPatientId = patientLogin.user.id;
  doctorToken = doctorLogin.token;
  adminToken = adminLogin.token;
});

after(async () => {
  await prisma.outboxJob.deleteMany({
    where: {
      type: {
        in: [...bookingOutboxJobTypes]
      }
    }
  });
  await prisma.slotReservation.deleteMany({
    where: {
      doctorId: {
        in: [...doctorIds]
      }
    }
  });
  await prisma.appointment.deleteMany({
    where: {
      doctorId: {
        in: [...doctorIds]
      }
    }
  });
  await prisma.user.deleteMany({
    where: {
      id: {
        in: [...patientIds]
      }
    }
  });
  await prisma.user.deleteMany({
    where: {
      email: {
        in: [...testEmails]
      }
    }
  });

  await prisma.$disconnect();

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
});

describe("appointment booking confirmation", () => {
  test("unauthenticated booking returns 401", async () => {
    const response = await bookingRequest(undefined, "some-reservation-id");

    assert.equal(response.status, 401);
  });

  test("doctor cannot book", async () => {
    const response = await bookingRequest(doctorToken, "some-reservation-id");

    assert.equal(response.status, 403);
  });

  test("admin cannot book", async () => {
    const response = await bookingRequest(adminToken, "some-reservation-id");

    assert.equal(response.status, 403);
  });

  test("valid patient-owned HOLD confirms successfully", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    const hold = await createHold({
      doctorId,
      slotStartAt: startAt(date, "09:00")
    });

    const response = await bookingRequest(patientToken, hold.id);

    assert.equal(response.status, 201);

    const body = response.body as BookingResponse;
    assert.equal(body.appointment.doctorId, doctorId);
    assert.equal(body.appointment.startAt, startAt(date, "09:00"));
    assert.equal(body.appointment.status, "BOOKED");
    assert.equal(body.appointment.preSummaryStatus, "PENDING");
  });

  test("appointment stores symptoms", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    const symptoms = "  Headache for two days.  ";
    const hold = await createHold({
      doctorId,
      slotStartAt: startAt(date, "09:00")
    });

    const response = await bookingRequest(patientToken, hold.id, symptoms);
    assert.equal(response.status, 201);

    const body = response.body as BookingResponse;
    const appointment = await prisma.appointment.findUniqueOrThrow({
      where: {
        id: body.appointment.id
      },
      select: {
        symptoms: true
      }
    });

    assert.equal(appointment.symptoms, "Headache for two days.");
  });

  test("appointment start and end are calculated from slot duration", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor({ slotDuration: 45, endTime: "10:30" });
    const hold = await createHold({
      doctorId,
      slotStartAt: startAt(date, "09:00")
    });

    const response = await bookingRequest(patientToken, hold.id);
    assert.equal(response.status, 201);

    const body = response.body as BookingResponse;
    assert.equal(body.appointment.startAt, startAt(date, "09:00"));
    assert.equal(body.appointment.endAt, startAt(date, "09:45"));
  });

  test("reservation changes HOLD to BOOKED", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    const hold = await createHold({
      doctorId,
      slotStartAt: startAt(date, "09:00")
    });

    const response = await bookingRequest(patientToken, hold.id);
    assert.equal(response.status, 201);

    const reservation = await prisma.slotReservation.findUniqueOrThrow({
      where: {
        id: hold.id
      },
      select: {
        status: true
      }
    });

    assert.equal(reservation.status, ReservationStatus.BOOKED);
  });

  test("reservation links to appointment", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    const hold = await createHold({
      doctorId,
      slotStartAt: startAt(date, "09:00")
    });

    const response = await bookingRequest(patientToken, hold.id);
    assert.equal(response.status, 201);

    const body = response.body as BookingResponse;
    const reservation = await prisma.slotReservation.findUniqueOrThrow({
      where: {
        id: hold.id
      },
      select: {
        appointmentId: true
      }
    });

    assert.equal(reservation.appointmentId, body.appointment.id);
  });

  test("expired HOLD cannot confirm", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    const hold = await createHold({
      doctorId,
      slotStartAt: startAt(date, "09:00"),
      expiresAt: new Date(Date.now() - 60_000)
    });

    const response = await bookingRequest(patientToken, hold.id);

    assert.equal(response.status, 409);
  });

  test("another patient cannot confirm someone else's hold", async () => {
    const otherPatient = await createPatient();
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    const hold = await createHold({
      doctorId,
      slotStartAt: startAt(date, "09:00")
    });

    const response = await bookingRequest(otherPatient.token, hold.id);

    assert.equal(response.status, 404);
  });

  test("invalid reservation returns 404", async () => {
    const response = await bookingRequest(patientToken, "not-a-real-reservation");

    assert.equal(response.status, 404);
  });

  test("missing symptoms returns 400", async () => {
    const response = await requestJson("/api/appointments", {
      method: "POST",
      headers: authHeaders(patientToken),
      body: JSON.stringify({
        reservationId: "some-reservation-id"
      })
    });

    assert.equal(response.status, 400);
  });

  test("empty symptoms returns 400", async () => {
    const response = await bookingRequest(patientToken, "some-reservation-id", "   ");

    assert.equal(response.status, 400);
  });

  test("overly long symptoms return 400", async () => {
    const response = await bookingRequest(
      patientToken,
      "some-reservation-id",
      "x".repeat(maxSymptomsLength + 1)
    );

    assert.equal(response.status, 400);
  });

  test("doctor leave introduced after hold blocks confirmation", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    const hold = await createHold({
      doctorId,
      slotStartAt: startAt(date, "09:00")
    });
    await prisma.doctorLeave.create({
      data: {
        doctorId,
        date: new Date(`${date}T00:00:00.000Z`),
        reason: "Leave added after hold"
      }
    });

    const response = await bookingRequest(patientToken, hold.id);

    assert.equal(response.status, 409);
  });

  test("conflicting appointment prevents confirmation", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    const slotStartAt = startAt(date, "09:00");
    const hold = await createHold({
      doctorId,
      slotStartAt
    });
    await createConflictingAppointment({
      doctorId,
      slotStartAt
    });

    const response = await bookingRequest(patientToken, hold.id);

    assert.equal(response.status, 409);
  });

  test("exactly five expected outbox jobs are created", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    const hold = await createHold({
      doctorId,
      slotStartAt: startAt(date, "09:00")
    });

    const response = await bookingRequest(patientToken, hold.id);
    assert.equal(response.status, 201);

    const body = response.body as BookingResponse;
    const jobCount = await countOutboxJobsForAppointment(body.appointment.id);

    assert.equal(jobCount, 5);
  });

  test("all outbox jobs start PENDING", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    const hold = await createHold({
      doctorId,
      slotStartAt: startAt(date, "09:00")
    });

    const response = await bookingRequest(patientToken, hold.id);
    assert.equal(response.status, 201);

    const body = response.body as BookingResponse;
    const statuses = await outboxStatusesForAppointment(body.appointment.id);

    assert.equal(statuses.length, 5);
    assert.equal(
      statuses.every((job) => job.status === OutboxJobStatus.PENDING),
      true
    );
  });

  test("booking response exposes no sensitive fields", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    const hold = await createHold({
      doctorId,
      slotStartAt: startAt(date, "09:00")
    });

    const response = await bookingRequest(patientToken, hold.id);

    assert.equal(response.status, 201);
    assert.equal(containsSensitiveField(response.body), false);
  });

  test("repeated confirmation returns existing appointment without duplicates", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    const slotStartAt = startAt(date, "09:00");
    const hold = await createHold({
      doctorId,
      slotStartAt
    });

    const firstResponse = await bookingRequest(patientToken, hold.id);
    const secondResponse = await bookingRequest(patientToken, hold.id);

    assert.equal(firstResponse.status, 201);
    assert.equal(secondResponse.status, 200);

    const firstBody = firstResponse.body as BookingResponse;
    const secondBody = secondResponse.body as BookingResponse;
    const appointmentCount = await prisma.appointment.count({
      where: {
        doctorId,
        startAt: dateAt(date, "09:00"),
        status: {
          not: AppointmentStatus.CANCELLED
        }
      }
    });
    const jobCount = await countOutboxJobsForAppointment(firstBody.appointment.id);

    assert.equal(secondBody.appointment.id, firstBody.appointment.id);
    assert.equal(appointmentCount, 1);
    assert.equal(jobCount, 5);
  });

  test("transaction rollback leaves no partial appointment or jobs after simulated failure", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    const slotStartAt = startAt(date, "09:00");
    const hold = await createHold({
      doctorId,
      slotStartAt
    });
    const jobCountBefore = await countBookingOutboxJobs();

    await assert.rejects(
      () =>
        confirmAppointment(
          {
            patientId: seededPatientId,
            reservationId: hold.id,
            symptoms: "Symptoms before simulated failure"
          },
          {
            simulateFailureAfterAppointmentCreate: true
          }
        ),
      /Simulated booking transaction failure/
    );

    const [appointmentCount, reservation, jobCountAfter] = await Promise.all([
      prisma.appointment.count({
        where: {
          doctorId,
          startAt: dateAt(date, "09:00")
        }
      }),
      prisma.slotReservation.findUniqueOrThrow({
        where: {
          id: hold.id
        },
        select: {
          status: true,
          appointmentId: true
        }
      }),
      countBookingOutboxJobs()
    ]);

    assert.equal(appointmentCount, 0);
    assert.equal(reservation.status, ReservationStatus.HOLD);
    assert.equal(reservation.appointmentId, null);
    assert.equal(jobCountAfter, jobCountBefore);
  });

  test("simultaneous confirmation creates exactly one appointment and one outbox set", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    const slotStartAt = startAt(date, "09:00");
    const hold = await createHold({
      doctorId,
      slotStartAt
    });

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => bookingRequest(patientToken, hold.id))
    );

    const acceptableResponses = responses.filter((response) =>
      [200, 201, 409].includes(response.status)
    );
    const createdAppointments = await prisma.appointment.findMany({
      where: {
        doctorId,
        startAt: dateAt(date, "09:00"),
        status: {
          not: AppointmentStatus.CANCELLED
        }
      },
      select: {
        id: true
      }
    });
    const bookedReservations = await prisma.slotReservation.count({
      where: {
        id: hold.id,
        status: ReservationStatus.BOOKED,
        appointmentId: createdAppointments[0]?.id
      }
    });
    const jobCount =
      createdAppointments.length === 1
        ? await countOutboxJobsForAppointment(createdAppointments[0].id)
        : 0;

    assert.equal(acceptableResponses.length, 10);
    assert.equal(createdAppointments.length, 1);
    assert.equal(bookedReservations, 1);
    assert.equal(jobCount, 5);
  });
});
