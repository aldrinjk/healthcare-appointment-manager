import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import bcrypt from "bcrypt";
import {
  AppointmentStatus,
  ReservationStatus,
  UserRole,
  Weekday
} from "@prisma/client";

process.env.NODE_ENV = "test";

const [{ app }, { prisma }, { holdDurationMs }] = await Promise.all([
  import("../app.js"),
  import("../utils/prisma.js"),
  import("../services/slot-reservation.service.js")
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

type HoldResponse = {
  reservation: {
    id: string;
    doctorId: string;
    startAt: string;
    expiresAt: string;
    status: string;
    passwordHash?: string;
  };
};

type LoginResponse = {
  token: string;
  user: {
    id: string;
    role: string;
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
      key === "patientId" ||
      key === "email" ||
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

async function holdRequest(token: string | undefined, doctorId: string, slotStartAt: string) {
  return requestJson("/api/appointments/hold", {
    method: "POST",
    headers: token ? authHeaders(token) : {},
    body: JSON.stringify({
      doctorId,
      startAt: slotStartAt
    })
  });
}

async function createPatient() {
  const email = makeEmail("hold.patient");
  const passwordHash = await bcrypt.hash("Password123!", 10);
  const user = await prisma.user.create({
    data: {
      name: "Hold Test Patient",
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
  const email = makeEmail("hold.doctor");
  const doctor = await prisma.user.create({
    data: {
      name: "Dr. Hold Test",
      email,
      passwordHash: "not-used-in-hold-tests",
      role: UserRole.DOCTOR,
      doctorProfile: {
        create: {
          specialization: "Hold Testing",
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
                  reason: "Hold test leave"
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

async function createReservation(options: {
  doctorId: string;
  patientId?: string;
  slotStartAt: string;
  status: ReservationStatus;
  expiresAt?: Date | null;
}) {
  return prisma.slotReservation.create({
    data: {
      doctorId: options.doctorId,
      patientId: options.patientId ?? seededPatientId,
      startAt: new Date(options.slotStartAt),
      status: options.status,
      expiresAt: options.expiresAt
    },
    select: {
      id: true
    }
  });
}

async function createAppointment(doctorId: string, slotStartAt: string) {
  const start = new Date(slotStartAt);

  return prisma.appointment.create({
    data: {
      doctorId,
      patientId: seededPatientId,
      startAt: start,
      endAt: new Date(start.getTime() + 30 * 60 * 1000),
      status: AppointmentStatus.BOOKED
    },
    select: {
      id: true
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

describe("slot hold", () => {
  test("unauthenticated hold returns 401", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    const response = await holdRequest(undefined, doctorId, startAt(date, "09:00"));

    assert.equal(response.status, 401);
  });

  test("doctor cannot hold a slot", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    const response = await holdRequest(doctorToken, doctorId, startAt(date, "09:00"));

    assert.equal(response.status, 403);
  });

  test("admin cannot hold a slot", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    const response = await holdRequest(adminToken, doctorId, startAt(date, "09:00"));

    assert.equal(response.status, 403);
  });

  test("patient can hold a valid slot", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    const response = await holdRequest(patientToken, doctorId, startAt(date, "09:00"));

    assert.equal(response.status, 201);

    const body = response.body as HoldResponse;
    assert.equal(body.reservation.doctorId, doctorId);
    assert.equal(body.reservation.startAt, startAt(date, "09:00"));
    assert.equal(body.reservation.status, "HOLD");
  });

  test("returned expiry is approximately 5 minutes", async () => {
    const before = Date.now();
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    const response = await holdRequest(patientToken, doctorId, startAt(date, "09:00"));
    const after = Date.now();

    assert.equal(response.status, 201);

    const body = response.body as HoldResponse;
    const expiresAt = new Date(body.reservation.expiresAt).getTime();

    assert.ok(expiresAt - before >= holdDurationMs - 10_000);
    assert.ok(expiresAt - after <= holdDurationMs + 10_000);
  });

  test("nonexistent doctor returns 404", async () => {
    const date = nextUtcDateForWeekday(1);
    const response = await holdRequest(
      patientToken,
      "not-a-real-doctor",
      startAt(date, "09:00")
    );

    assert.equal(response.status, 404);
  });

  test("malformed startAt returns 400", async () => {
    const doctorId = await createDoctor();
    const response = await holdRequest(patientToken, doctorId, "not-a-date");

    assert.equal(response.status, 400);
  });

  test("past slot returns 400", async () => {
    const doctorId = await createDoctor();
    const response = await holdRequest(
      patientToken,
      doctorId,
      "2000-01-03T09:00:00.000Z"
    );

    assert.equal(response.status, 400);
  });

  test("non-working time is rejected", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    const response = await holdRequest(patientToken, doctorId, startAt(date, "12:00"));

    assert.equal(response.status, 400);
  });

  test("doctor leave slot is rejected", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor({ leaveDate: date });
    const response = await holdRequest(patientToken, doctorId, startAt(date, "09:00"));

    assert.equal(response.status, 400);
  });

  test("slot not aligned to configured boundary is rejected", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    const response = await holdRequest(patientToken, doctorId, startAt(date, "09:15"));

    assert.equal(response.status, 400);
  });

  test("active HOLD causes 409", async () => {
    const otherPatient = await createPatient();
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    await createReservation({
      doctorId,
      patientId: otherPatient.id,
      slotStartAt: startAt(date, "09:00"),
      status: ReservationStatus.HOLD,
      expiresAt: new Date(Date.now() + holdDurationMs)
    });

    const response = await holdRequest(patientToken, doctorId, startAt(date, "09:00"));

    assert.equal(response.status, 409);
  });

  test("same patient active HOLD returns existing reservation", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    const firstResponse = await holdRequest(patientToken, doctorId, startAt(date, "09:00"));
    const secondResponse = await holdRequest(patientToken, doctorId, startAt(date, "09:00"));

    assert.equal(firstResponse.status, 201);
    assert.equal(secondResponse.status, 200);
    assert.equal(
      (secondResponse.body as HoldResponse).reservation.id,
      (firstResponse.body as HoldResponse).reservation.id
    );
  });

  test("BOOKED reservation causes 409", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    await createReservation({
      doctorId,
      slotStartAt: startAt(date, "09:00"),
      status: ReservationStatus.BOOKED,
      expiresAt: null
    });

    const response = await holdRequest(patientToken, doctorId, startAt(date, "09:00"));

    assert.equal(response.status, 409);
  });

  test("existing appointment causes conflict", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    await createAppointment(doctorId, startAt(date, "09:00"));

    const response = await holdRequest(patientToken, doctorId, startAt(date, "09:00"));

    assert.equal(response.status, 409);
  });

  test("expired HOLD no longer blocks the slot", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    await createReservation({
      doctorId,
      slotStartAt: startAt(date, "09:00"),
      status: ReservationStatus.HOLD,
      expiresAt: new Date(Date.now() - 60_000)
    });

    const response = await holdRequest(patientToken, doctorId, startAt(date, "09:00"));

    assert.equal(response.status, 201);
  });

  test("replacement of expired HOLD creates one valid new hold", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    await createReservation({
      doctorId,
      slotStartAt: startAt(date, "09:00"),
      status: ReservationStatus.HOLD,
      expiresAt: new Date(Date.now() - 60_000)
    });

    const response = await holdRequest(patientToken, doctorId, startAt(date, "09:00"));
    assert.equal(response.status, 201);

    const activeHolds = await prisma.slotReservation.count({
      where: {
        doctorId,
        startAt: dateAt(date, "09:00"),
        status: ReservationStatus.HOLD,
        expiresAt: {
          gt: new Date()
        }
      }
    });
    const expiredHolds = await prisma.slotReservation.count({
      where: {
        doctorId,
        startAt: dateAt(date, "09:00"),
        status: ReservationStatus.EXPIRED
      }
    });

    assert.equal(activeHolds, 1);
    assert.equal(expiredHolds, 1);
  });

  test("responses do not expose sensitive fields", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    const response = await holdRequest(patientToken, doctorId, startAt(date, "09:00"));

    assert.equal(response.status, 201);
    assert.equal(containsSensitiveField(response.body), false);
  });

  test("simultaneous hold requests produce exactly one winner", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    const patients = await Promise.all(
      Array.from({ length: 10 }, () => createPatient())
    );

    const responses = await Promise.all(
      patients.map((patient) =>
        holdRequest(patient.token, doctorId, startAt(date, "09:00"))
      )
    );

    const successCount = responses.filter((response) => response.status === 201).length;
    const conflictCount = responses.filter((response) => response.status === 409).length;
    const activeHolds = await prisma.slotReservation.count({
      where: {
        doctorId,
        startAt: dateAt(date, "09:00"),
        status: ReservationStatus.HOLD,
        expiresAt: {
          gt: new Date()
        }
      }
    });

    assert.equal(successCount, 1);
    assert.equal(conflictCount, 9);
    assert.equal(activeHolds, 1);
  });

  test("simultaneous expired hold replacement produces exactly one winner", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    await createReservation({
      doctorId,
      slotStartAt: startAt(date, "09:00"),
      status: ReservationStatus.HOLD,
      expiresAt: new Date(Date.now() - 60_000)
    });
    const patients = await Promise.all(
      Array.from({ length: 10 }, () => createPatient())
    );

    const responses = await Promise.all(
      patients.map((patient) =>
        holdRequest(patient.token, doctorId, startAt(date, "09:00"))
      )
    );

    const successCount = responses.filter((response) => response.status === 201).length;
    const conflictCount = responses.filter((response) => response.status === 409).length;
    const activeHolds = await prisma.slotReservation.count({
      where: {
        doctorId,
        startAt: dateAt(date, "09:00"),
        status: ReservationStatus.HOLD,
        expiresAt: {
          gt: new Date()
        }
      }
    });

    assert.equal(successCount, 1);
    assert.equal(conflictCount, 9);
    assert.equal(activeHolds, 1);
  });
});
