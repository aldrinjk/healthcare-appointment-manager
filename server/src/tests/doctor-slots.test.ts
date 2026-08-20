import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  AppointmentStatus,
  ReservationStatus,
  UserRole,
  Weekday
} from "@prisma/client";

process.env.NODE_ENV = "test";

const [{ app }, { prisma }, { getAvailableSlots }] = await Promise.all([
  import("../app.js"),
  import("../utils/prisma.js"),
  import("../services/doctor.service.js")
]);

const testEmails = new Set<string>();
const doctorIds = new Set<string>();
const appointmentIds = new Set<string>();
const reservationIds = new Set<string>();
let server: Server;
let baseUrl: string;
let patientId: string;

type JsonResponse = {
  status: number;
  body: unknown;
};

type PublicDoctor = {
  id: string;
  name: string;
  specialization: string;
  slotDuration: number;
  availabilities?: unknown[];
  leaves?: unknown[];
  passwordHash?: string;
};

type SlotResponse = {
  date: string;
  timeZone: string;
  slots: Array<{
    startAt: string;
    endAt: string;
    passwordHash?: string;
  }>;
};

function makeEmail(prefix: string) {
  const email = `${prefix}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2)}@example.com`;
  testEmails.add(email);
  return email;
}

function containsPasswordHash(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsPasswordHash);
  }

  if (typeof value !== "object" || value === null) {
    return false;
  }

  return Object.entries(value).some(
    ([key, childValue]) => key === "passwordHash" || containsPasswordHash(childValue)
  );
}

function dateAt(date: string, time: string) {
  return new Date(`${date}T${time}:00.000Z`);
}

async function requestJson(path: string): Promise<JsonResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      Accept: "application/json"
    }
  });

  return {
    status: response.status,
    body: await response.json()
  };
}

async function createDoctor(options: {
  specialization?: string;
  slotDuration?: number;
  availability?: {
    weekday: Weekday;
    startTime: string;
    endTime: string;
  };
}) {
  const email = makeEmail("public.doctor");
  const user = await prisma.user.create({
    data: {
      name: "Dr. Public Test",
      email,
      passwordHash: "not-used-in-public-tests",
      role: UserRole.DOCTOR,
      doctorProfile: {
        create: {
          specialization: options.specialization ?? "Cardiology",
          slotDurationMinutes: options.slotDuration ?? 30,
          availabilities: options.availability
            ? {
                create: options.availability
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

  assert.ok(user.doctorProfile);
  doctorIds.add(user.doctorProfile.id);

  return user.doctorProfile.id;
}

async function addLeave(doctorId: string, date: string) {
  return prisma.doctorLeave.create({
    data: {
      doctorId,
      date: new Date(`${date}T00:00:00.000Z`),
      reason: "Test leave"
    }
  });
}

async function addReservation(
  doctorId: string,
  date: string,
  time: string,
  status: ReservationStatus,
  expiresAt?: Date | null
) {
  const reservation = await prisma.slotReservation.create({
    data: {
      doctorId,
      patientId,
      startAt: dateAt(date, time),
      status,
      expiresAt
    },
    select: {
      id: true
    }
  });

  reservationIds.add(reservation.id);
}

async function addAppointment(doctorId: string, date: string, time: string) {
  const startAt = dateAt(date, time);
  const appointment = await prisma.appointment.create({
    data: {
      doctorId,
      patientId,
      startAt,
      endAt: new Date(startAt.getTime() + 30 * 60 * 1000),
      status: AppointmentStatus.BOOKED
    },
    select: {
      id: true
    }
  });

  appointmentIds.add(appointment.id);
}

before(async () => {
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  const patient = await prisma.user.findUniqueOrThrow({
    where: { email: "patient@example.com" },
    select: { id: true }
  });
  patientId = patient.id;
});

after(async () => {
  await prisma.slotReservation.deleteMany({
    where: {
      OR: [
        { id: { in: [...reservationIds] } },
        { doctorId: { in: [...doctorIds] } }
      ]
    }
  });
  await prisma.appointment.deleteMany({
    where: {
      OR: [
        { id: { in: [...appointmentIds] } },
        { doctorId: { in: [...doctorIds] } }
      ]
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

describe("doctor discovery and slot generation", () => {
  test("list doctors succeeds", async () => {
    await createDoctor({ specialization: "Cardiology" });
    const response = await requestJson("/api/doctors");

    assert.equal(response.status, 200);
    const body = response.body as { doctors: PublicDoctor[] };
    assert.ok(body.doctors.length >= 1);
  });

  test("specialization filter is case-insensitive", async () => {
    const doctorId = await createDoctor({ specialization: "Pediatric Neurology" });
    const response = await requestJson("/api/doctors?specialization=neurology");

    assert.equal(response.status, 200);
    const body = response.body as { doctors: PublicDoctor[] };
    assert.ok(body.doctors.some((doctor) => doctor.id === doctorId));
  });

  test("no-match specialization returns empty array", async () => {
    const response = await requestJson(
      `/api/doctors?specialization=no-match-${Date.now()}`
    );

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { doctors: [] });
  });

  test("doctor detail succeeds with public schedule data", async () => {
    const doctorId = await createDoctor({
      specialization: "Dermatology",
      slotDuration: 20,
      availability: {
        weekday: Weekday.MONDAY,
        startTime: "09:00",
        endTime: "10:00"
      }
    });
    const response = await requestJson(`/api/doctors/${doctorId}`);

    assert.equal(response.status, 200);
    const body = response.body as { doctor: PublicDoctor };
    assert.equal(body.doctor.id, doctorId);
    assert.equal(body.doctor.specialization, "Dermatology");
    assert.equal(body.doctor.slotDuration, 20);
    assert.equal(body.doctor.availabilities?.length, 1);
  });

  test("nonexistent doctor returns 404", async () => {
    const response = await requestJson("/api/doctors/not-a-real-doctor");

    assert.equal(response.status, 404);
  });

  test("slots are generated correctly for a working day", async () => {
    const doctorId = await createDoctor({
      slotDuration: 30,
      availability: {
        weekday: Weekday.MONDAY,
        startTime: "09:00",
        endTime: "10:30"
      }
    });
    const response = await requestJson(`/api/doctors/${doctorId}/slots?date=2026-09-21`);

    assert.equal(response.status, 200);
    const body = response.body as SlotResponse;
    assert.equal(body.timeZone, "UTC");
    assert.deepEqual(
      body.slots.map((slot) => slot.startAt),
      [
        "2026-09-21T09:00:00.000Z",
        "2026-09-21T09:30:00.000Z",
        "2026-09-21T10:00:00.000Z"
      ]
    );
  });

  test("non-working weekday returns empty slots", async () => {
    const doctorId = await createDoctor({
      availability: {
        weekday: Weekday.TUESDAY,
        startTime: "09:00",
        endTime: "10:00"
      }
    });
    const response = await requestJson(`/api/doctors/${doctorId}/slots?date=2026-09-21`);

    assert.equal(response.status, 200);
    assert.deepEqual((response.body as SlotResponse).slots, []);
  });

  test("doctor leave date returns empty slots", async () => {
    const doctorId = await createDoctor({
      availability: {
        weekday: Weekday.MONDAY,
        startTime: "09:00",
        endTime: "10:00"
      }
    });
    await addLeave(doctorId, "2026-09-21");
    const response = await requestJson(`/api/doctors/${doctorId}/slots?date=2026-09-21`);

    assert.equal(response.status, 200);
    assert.deepEqual((response.body as SlotResponse).slots, []);
  });

  test("invalid date returns 400", async () => {
    const doctorId = await createDoctor({});
    const response = await requestJson(`/api/doctors/${doctorId}/slots?date=2026-02-31`);

    assert.equal(response.status, 400);
  });

  test("active HOLD blocks a slot", async () => {
    const doctorId = await createDoctor({
      availability: {
        weekday: Weekday.MONDAY,
        startTime: "09:00",
        endTime: "10:00"
      }
    });
    await addReservation(
      doctorId,
      "2026-09-21",
      "09:00",
      ReservationStatus.HOLD,
      new Date("2026-09-21T09:05:00.000Z")
    );

    const result = await getAvailableSlots(
      doctorId,
      "2026-09-21",
      new Date("2026-09-21T08:00:00.000Z")
    );

    assert.deepEqual(
      result.slots.map((slot) => slot.startAt),
      ["2026-09-21T09:30:00.000Z"]
    );
  });

  test("BOOKED reservation blocks a slot", async () => {
    const doctorId = await createDoctor({
      availability: {
        weekday: Weekday.MONDAY,
        startTime: "09:00",
        endTime: "10:00"
      }
    });
    await addReservation(
      doctorId,
      "2026-09-21",
      "09:30",
      ReservationStatus.BOOKED,
      null
    );
    const response = await requestJson(`/api/doctors/${doctorId}/slots?date=2026-09-21`);

    assert.equal(response.status, 200);
    assert.deepEqual(
      (response.body as SlotResponse).slots.map((slot) => slot.startAt),
      ["2026-09-21T09:00:00.000Z"]
    );
  });

  test("expired HOLD does not block a slot", async () => {
    const doctorId = await createDoctor({
      availability: {
        weekday: Weekday.MONDAY,
        startTime: "09:00",
        endTime: "10:00"
      }
    });
    await addReservation(
      doctorId,
      "2026-09-21",
      "09:00",
      ReservationStatus.HOLD,
      new Date("2026-09-21T08:30:00.000Z")
    );

    const result = await getAvailableSlots(
      doctorId,
      "2026-09-21",
      new Date("2026-09-21T08:45:00.000Z")
    );

    assert.deepEqual(
      result.slots.map((slot) => slot.startAt),
      ["2026-09-21T09:00:00.000Z", "2026-09-21T09:30:00.000Z"]
    );
  });

  test("slot duration is respected", async () => {
    const doctorId = await createDoctor({
      slotDuration: 20,
      availability: {
        weekday: Weekday.MONDAY,
        startTime: "09:00",
        endTime: "10:00"
      }
    });
    const response = await requestJson(`/api/doctors/${doctorId}/slots?date=2026-09-21`);

    assert.equal(response.status, 200);
    assert.deepEqual(
      (response.body as SlotResponse).slots.map((slot) => slot.startAt),
      [
        "2026-09-21T09:00:00.000Z",
        "2026-09-21T09:20:00.000Z",
        "2026-09-21T09:40:00.000Z"
      ]
    );
  });

  test("slot does not exceed working-hours end", async () => {
    const doctorId = await createDoctor({
      slotDuration: 45,
      availability: {
        weekday: Weekday.MONDAY,
        startTime: "09:00",
        endTime: "10:00"
      }
    });
    const response = await requestJson(`/api/doctors/${doctorId}/slots?date=2026-09-21`);

    assert.equal(response.status, 200);
    assert.deepEqual(
      (response.body as SlotResponse).slots.map((slot) => slot.startAt),
      ["2026-09-21T09:00:00.000Z"]
    );
  });

  test("past slots are excluded when date is today", async () => {
    const doctorId = await createDoctor({
      slotDuration: 60,
      availability: {
        weekday: Weekday.MONDAY,
        startTime: "09:00",
        endTime: "13:00"
      }
    });
    const result = await getAvailableSlots(
      doctorId,
      "2026-09-21",
      new Date("2026-09-21T10:30:00.000Z")
    );

    assert.deepEqual(
      result.slots.map((slot) => slot.startAt),
      ["2026-09-21T11:00:00.000Z", "2026-09-21T12:00:00.000Z"]
    );
  });

  test("confirmed appointment blocks a slot", async () => {
    const doctorId = await createDoctor({
      availability: {
        weekday: Weekday.MONDAY,
        startTime: "09:00",
        endTime: "10:00"
      }
    });
    await addAppointment(doctorId, "2026-09-21", "09:00");
    const response = await requestJson(`/api/doctors/${doctorId}/slots?date=2026-09-21`);

    assert.equal(response.status, 200);
    assert.deepEqual(
      (response.body as SlotResponse).slots.map((slot) => slot.startAt),
      ["2026-09-21T09:30:00.000Z"]
    );
  });

  test("public responses never expose passwordHash", async () => {
    const doctorId = await createDoctor({
      availability: {
        weekday: Weekday.MONDAY,
        startTime: "09:00",
        endTime: "10:00"
      }
    });
    const [listResponse, detailResponse, slotsResponse] = await Promise.all([
      requestJson("/api/doctors"),
      requestJson(`/api/doctors/${doctorId}`),
      requestJson(`/api/doctors/${doctorId}/slots?date=2026-09-21`)
    ]);

    assert.equal(listResponse.status, 200);
    assert.equal(detailResponse.status, 200);
    assert.equal(slotsResponse.status, 200);
    assert.equal(containsPasswordHash(listResponse.body), false);
    assert.equal(containsPasswordHash(detailResponse.body), false);
    assert.equal(containsPasswordHash(slotsResponse.body), false);
  });
});
