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

const [
  { app },
  { prisma },
  {
    cancellationOutboxJobTypes,
    cancelPatientAppointment,
    rescheduleOutboxJobTypes,
    reschedulePatientAppointment
  },
  { bookingOutboxJobTypes }
] = await Promise.all([
  import("../app.js"),
  import("../utils/prisma.js"),
  import("../services/patient-appointment.service.js"),
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

type AppointmentResponse = {
  appointment: {
    id: string;
    doctorId: string;
    doctor: {
      id: string;
      name: string;
      specialization: string;
      slotDuration: number;
      passwordHash?: string;
      email?: string;
    };
    startAt: string;
    endAt: string;
    status: string;
    symptoms: string | null;
    preSummaryStatus: string;
    postSummaryStatus: string;
    prescriptions: unknown[];
    passwordHash?: string;
    patientId?: string;
    email?: string;
  };
};

type AppointmentListResponse = {
  appointments: AppointmentResponse["appointment"][];
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

function nextUtcDateForWeekday(targetWeekday: number, offsetDays = 21) {
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

async function createPatient() {
  const email = makeEmail("appointment.patient");
  const passwordHash = await bcrypt.hash("Password123!", 10);
  const user = await prisma.user.create({
    data: {
      name: "Appointment Test Patient",
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
  const email = makeEmail("appointment.doctor");
  const doctor = await prisma.user.create({
    data: {
      name: "Dr. Appointment Test",
      email,
      passwordHash: "not-used-in-appointment-tests",
      role: UserRole.DOCTOR,
      doctorProfile: {
        create: {
          specialization: "Appointment Testing",
          slotDurationMinutes: options.slotDuration ?? 30,
          availabilities: {
            create: {
              weekday: options.weekday ?? Weekday.MONDAY,
              startTime: options.startTime ?? "09:00",
              endTime: options.endTime ?? "12:00"
            }
          },
          leaves: options.leaveDate
            ? {
                create: {
                  date: new Date(`${options.leaveDate}T00:00:00.000Z`),
                  reason: "Appointment test leave"
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
}) {
  return prisma.slotReservation.create({
    data: {
      doctorId: options.doctorId,
      patientId: options.patientId ?? seededPatientId,
      startAt: new Date(options.slotStartAt),
      status: ReservationStatus.HOLD,
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

async function createBookedAppointment(options: {
  patientId?: string;
  doctorId?: string;
  date?: string;
  time?: string;
  durationMinutes?: number;
  status?: AppointmentStatus;
} = {}) {
  const doctorId = options.doctorId ?? (await createDoctor());
  const patientId = options.patientId ?? seededPatientId;
  const date = options.date ?? nextUtcDateForWeekday(1);
  const time = options.time ?? "09:00";
  const start = dateAt(date, time);
  const appointment = await prisma.appointment.create({
    data: {
      doctorId,
      patientId,
      startAt: start,
      endAt: new Date(start.getTime() + (options.durationMinutes ?? 30) * 60 * 1000),
      status: options.status ?? AppointmentStatus.BOOKED,
      symptoms: "Original appointment symptoms"
    },
    select: {
      id: true,
      doctorId: true,
      startAt: true,
      endAt: true
    }
  });
  const reservation = await prisma.slotReservation.create({
    data: {
      doctorId,
      patientId,
      startAt: start,
      status: ReservationStatus.BOOKED,
      expiresAt: null,
      appointmentId: appointment.id
    },
    select: {
      id: true
    }
  });

  return {
    appointment,
    reservation,
    date,
    slotStartAt: start.toISOString()
  };
}

async function countOutboxJobsForAppointment(
  appointmentId: string,
  types: readonly string[]
) {
  const rows = await prisma.$queryRaw<Array<{ type: string; status: string }>>`
    SELECT type, status
    FROM "OutboxJob"
    WHERE payload->>'appointmentId' = ${appointmentId}
  `;

  return rows.filter((row) => types.includes(row.type));
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
        in: [
          ...bookingOutboxJobTypes,
          ...cancellationOutboxJobTypes,
          ...rescheduleOutboxJobTypes
        ]
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

describe("patient appointment views, cancellation, and rescheduling", () => {
  test("unauthenticated list returns 401", async () => {
    const response = await requestJson("/api/appointments/me");

    assert.equal(response.status, 401);
  });

  test("doctor and admin are blocked from patient appointment list", async () => {
    const [doctorResponse, adminResponse] = await Promise.all([
      requestJson("/api/appointments/me", {
        headers: authHeaders(doctorToken)
      }),
      requestJson("/api/appointments/me", {
        headers: authHeaders(adminToken)
      })
    ]);

    assert.equal(doctorResponse.status, 403);
    assert.equal(adminResponse.status, 403);
  });

  test("patient sees only own appointments", async () => {
    const otherPatient = await createPatient();
    const own = await createBookedAppointment();
    const other = await createBookedAppointment({
      patientId: otherPatient.id
    });

    const response = await requestJson("/api/appointments/me", {
      headers: authHeaders(patientToken)
    });

    assert.equal(response.status, 200);

    const body = response.body as AppointmentListResponse;
    const appointmentIds = body.appointments.map((appointment) => appointment.id);

    assert.ok(appointmentIds.includes(own.appointment.id));
    assert.equal(appointmentIds.includes(other.appointment.id), false);
  });

  test("appointment detail succeeds", async () => {
    const { appointment } = await createBookedAppointment();

    const response = await requestJson(`/api/appointments/${appointment.id}`, {
      headers: authHeaders(patientToken)
    });

    assert.equal(response.status, 200);

    const body = response.body as AppointmentResponse;
    assert.equal(body.appointment.id, appointment.id);
    assert.equal(body.appointment.status, "BOOKED");
    assert.ok(body.appointment.doctor.name);
  });

  test("patient cannot view another patient's appointment", async () => {
    const otherPatient = await createPatient();
    const { appointment } = await createBookedAppointment({
      patientId: otherPatient.id
    });

    const response = await requestJson(`/api/appointments/${appointment.id}`, {
      headers: authHeaders(patientToken)
    });

    assert.equal(response.status, 404);
  });

  test("appointment view responses expose no passwordHash or private user data", async () => {
    const { appointment } = await createBookedAppointment();
    const [listResponse, detailResponse] = await Promise.all([
      requestJson("/api/appointments/me", {
        headers: authHeaders(patientToken)
      }),
      requestJson(`/api/appointments/${appointment.id}`, {
        headers: authHeaders(patientToken)
      })
    ]);

    assert.equal(listResponse.status, 200);
    assert.equal(detailResponse.status, 200);
    assert.equal(containsSensitiveField(listResponse.body), false);
    assert.equal(containsSensitiveField(detailResponse.body), false);
  });

  test("patient can cancel own BOOKED appointment", async () => {
    const { appointment } = await createBookedAppointment();

    const response = await requestJson(`/api/appointments/${appointment.id}`, {
      method: "DELETE",
      headers: authHeaders(patientToken)
    });

    assert.equal(response.status, 200);

    const body = response.body as AppointmentResponse;
    assert.equal(body.appointment.status, "CANCELLED");
  });

  test("appointment becomes CANCELLED", async () => {
    const { appointment } = await createBookedAppointment();

    const response = await requestJson(`/api/appointments/${appointment.id}`, {
      method: "DELETE",
      headers: authHeaders(patientToken)
    });
    assert.equal(response.status, 200);

    const storedAppointment = await prisma.appointment.findUniqueOrThrow({
      where: { id: appointment.id },
      select: { status: true, cancelledAt: true }
    });

    assert.equal(storedAppointment.status, AppointmentStatus.CANCELLED);
    assert.ok(storedAppointment.cancelledAt);
  });

  test("old reservation is released after cancellation", async () => {
    const { appointment, reservation } = await createBookedAppointment();

    const response = await requestJson(`/api/appointments/${appointment.id}`, {
      method: "DELETE",
      headers: authHeaders(patientToken)
    });
    assert.equal(response.status, 200);

    const storedReservation = await prisma.slotReservation.findUniqueOrThrow({
      where: { id: reservation.id },
      select: { status: true, appointmentId: true }
    });

    assert.equal(storedReservation.status, ReservationStatus.RELEASED);
    assert.equal(storedReservation.appointmentId, null);
  });

  test("cancellation creates exactly three expected outbox jobs", async () => {
    const { appointment } = await createBookedAppointment();

    const response = await requestJson(`/api/appointments/${appointment.id}`, {
      method: "DELETE",
      headers: authHeaders(patientToken)
    });
    assert.equal(response.status, 200);

    const jobs = await countOutboxJobsForAppointment(
      appointment.id,
      cancellationOutboxJobTypes
    );

    assert.deepEqual(
      jobs.map((job) => job.type).sort(),
      [...cancellationOutboxJobTypes].sort()
    );
    assert.equal(jobs.every((job) => job.status === "PENDING"), true);
  });

  test("another patient cannot cancel", async () => {
    const otherPatient = await createPatient();
    const { appointment } = await createBookedAppointment();

    const response = await requestJson(`/api/appointments/${appointment.id}`, {
      method: "DELETE",
      headers: authHeaders(otherPatient.token)
    });

    assert.equal(response.status, 404);
  });

  test("completed appointment cannot cancel", async () => {
    const { appointment } = await createBookedAppointment({
      status: AppointmentStatus.COMPLETED
    });

    const response = await requestJson(`/api/appointments/${appointment.id}`, {
      method: "DELETE",
      headers: authHeaders(patientToken)
    });

    assert.equal(response.status, 409);
  });

  test("cancelled appointment cannot cancel again and creates no duplicate jobs", async () => {
    const { appointment } = await createBookedAppointment();

    const firstResponse = await requestJson(`/api/appointments/${appointment.id}`, {
      method: "DELETE",
      headers: authHeaders(patientToken)
    });
    const secondResponse = await requestJson(`/api/appointments/${appointment.id}`, {
      method: "DELETE",
      headers: authHeaders(patientToken)
    });

    const jobs = await countOutboxJobsForAppointment(
      appointment.id,
      cancellationOutboxJobTypes
    );

    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 409);
    assert.equal(jobs.length, 3);
  });

  test("cancellation rollback leaves original state intact", async () => {
    const { appointment, reservation } = await createBookedAppointment();
    const jobsBefore = await countOutboxJobsForAppointment(
      appointment.id,
      cancellationOutboxJobTypes
    );

    await assert.rejects(
      () =>
        cancelPatientAppointment(seededPatientId, appointment.id, {
          simulateFailureAfterAppointmentUpdate: true
        }),
      /Simulated cancellation transaction failure/
    );

    const [storedAppointment, storedReservation, jobsAfter] = await Promise.all([
      prisma.appointment.findUniqueOrThrow({
        where: { id: appointment.id },
        select: { status: true, cancelledAt: true }
      }),
      prisma.slotReservation.findUniqueOrThrow({
        where: { id: reservation.id },
        select: { status: true, appointmentId: true }
      }),
      countOutboxJobsForAppointment(appointment.id, cancellationOutboxJobTypes)
    ]);

    assert.equal(storedAppointment.status, AppointmentStatus.BOOKED);
    assert.equal(storedAppointment.cancelledAt, null);
    assert.equal(storedReservation.status, ReservationStatus.BOOKED);
    assert.equal(storedReservation.appointmentId, appointment.id);
    assert.equal(jobsAfter.length, jobsBefore.length);
  });

  test("cancellation makes slot available again through slot generation", async () => {
    const date = nextUtcDateForWeekday(1);
    const { appointment } = await createBookedAppointment({
      date,
      time: "09:00"
    });

    const beforeCancel = await requestJson(
      `/api/doctors/${appointment.doctorId}/slots?date=${date}`
    );
    assert.equal(beforeCancel.status, 200);
    assert.equal(
      (beforeCancel.body as { slots: Array<{ startAt: string }> }).slots.some(
        (slot) => slot.startAt === startAt(date, "09:00")
      ),
      false
    );

    const cancelResponse = await requestJson(`/api/appointments/${appointment.id}`, {
      method: "DELETE",
      headers: authHeaders(patientToken)
    });
    assert.equal(cancelResponse.status, 200);

    const afterCancel = await requestJson(
      `/api/doctors/${appointment.doctorId}/slots?date=${date}`
    );
    assert.equal(afterCancel.status, 200);
    assert.equal(
      (afterCancel.body as { slots: Array<{ startAt: string }> }).slots.some(
        (slot) => slot.startAt === startAt(date, "09:00")
      ),
      true
    );
  });

  test("patient can reschedule to valid active HOLD, including a different doctor", async () => {
    const date = nextUtcDateForWeekday(1);
    const { appointment } = await createBookedAppointment({
      date,
      time: "09:00"
    });
    const newDoctorId = await createDoctor({ slotDuration: 45, endTime: "11:00" });
    const newHold = await createHold({
      doctorId: newDoctorId,
      slotStartAt: startAt(date, "09:45")
    });

    const response = await requestJson(
      `/api/appointments/${appointment.id}/reschedule`,
      {
        method: "PATCH",
        headers: authHeaders(patientToken),
        body: JSON.stringify({
          newReservationId: newHold.id
        })
      }
    );

    assert.equal(response.status, 201);

    const body = response.body as AppointmentResponse;
    assert.equal(body.appointment.doctorId, newDoctorId);
    assert.equal(body.appointment.startAt, startAt(date, "09:45"));
    assert.equal(body.appointment.endAt, startAt(date, "10:30"));
  });

  test("appointment startAt and endAt update correctly on reschedule", async () => {
    const date = nextUtcDateForWeekday(1);
    const { appointment } = await createBookedAppointment({
      date,
      time: "09:00"
    });
    const newDoctorId = await createDoctor({ slotDuration: 30 });
    const newHold = await createHold({
      doctorId: newDoctorId,
      slotStartAt: startAt(date, "10:30")
    });

    const response = await requestJson(
      `/api/appointments/${appointment.id}/reschedule`,
      {
        method: "PATCH",
        headers: authHeaders(patientToken),
        body: JSON.stringify({
          newReservationId: newHold.id
        })
      }
    );

    assert.equal(response.status, 201);

    const storedAppointment = await prisma.appointment.findUniqueOrThrow({
      where: { id: appointment.id },
      select: { startAt: true, endAt: true }
    });

    assert.equal(storedAppointment.startAt.toISOString(), startAt(date, "10:30"));
    assert.equal(storedAppointment.endAt.toISOString(), startAt(date, "11:00"));
  });

  test("new reservation becomes BOOKED and links to appointment", async () => {
    const date = nextUtcDateForWeekday(1);
    const { appointment } = await createBookedAppointment({ date });
    const newDoctorId = await createDoctor();
    const newHold = await createHold({
      doctorId: newDoctorId,
      slotStartAt: startAt(date, "10:00")
    });

    const response = await requestJson(
      `/api/appointments/${appointment.id}/reschedule`,
      {
        method: "PATCH",
        headers: authHeaders(patientToken),
        body: JSON.stringify({ newReservationId: newHold.id })
      }
    );
    assert.equal(response.status, 201);

    const reservation = await prisma.slotReservation.findUniqueOrThrow({
      where: { id: newHold.id },
      select: { status: true, appointmentId: true }
    });

    assert.equal(reservation.status, ReservationStatus.BOOKED);
    assert.equal(reservation.appointmentId, appointment.id);
  });

  test("old reservation is released after reschedule", async () => {
    const date = nextUtcDateForWeekday(1);
    const { appointment, reservation } = await createBookedAppointment({ date });
    const newDoctorId = await createDoctor();
    const newHold = await createHold({
      doctorId: newDoctorId,
      slotStartAt: startAt(date, "10:00")
    });

    const response = await requestJson(
      `/api/appointments/${appointment.id}/reschedule`,
      {
        method: "PATCH",
        headers: authHeaders(patientToken),
        body: JSON.stringify({ newReservationId: newHold.id })
      }
    );
    assert.equal(response.status, 201);

    const oldReservation = await prisma.slotReservation.findUniqueOrThrow({
      where: { id: reservation.id },
      select: { status: true, appointmentId: true }
    });

    assert.equal(oldReservation.status, ReservationStatus.RELEASED);
    assert.equal(oldReservation.appointmentId, null);
  });

  test("new hold owned by another patient is rejected", async () => {
    const otherPatient = await createPatient();
    const date = nextUtcDateForWeekday(1);
    const { appointment } = await createBookedAppointment({ date });
    const newDoctorId = await createDoctor();
    const otherHold = await createHold({
      doctorId: newDoctorId,
      patientId: otherPatient.id,
      slotStartAt: startAt(date, "10:00")
    });

    const response = await requestJson(
      `/api/appointments/${appointment.id}/reschedule`,
      {
        method: "PATCH",
        headers: authHeaders(patientToken),
        body: JSON.stringify({ newReservationId: otherHold.id })
      }
    );

    assert.equal(response.status, 404);
  });

  test("expired new hold is rejected", async () => {
    const date = nextUtcDateForWeekday(1);
    const { appointment } = await createBookedAppointment({ date });
    const newDoctorId = await createDoctor();
    const expiredHold = await createHold({
      doctorId: newDoctorId,
      slotStartAt: startAt(date, "10:00"),
      expiresAt: new Date(Date.now() - 60_000)
    });

    const response = await requestJson(
      `/api/appointments/${appointment.id}/reschedule`,
      {
        method: "PATCH",
        headers: authHeaders(patientToken),
        body: JSON.stringify({ newReservationId: expiredHold.id })
      }
    );

    assert.equal(response.status, 409);
  });

  test("leave on new slot is rejected", async () => {
    const date = nextUtcDateForWeekday(1);
    const { appointment } = await createBookedAppointment({ date });
    const newDoctorId = await createDoctor({ leaveDate: date });
    const newHold = await createHold({
      doctorId: newDoctorId,
      slotStartAt: startAt(date, "10:00")
    });

    const response = await requestJson(
      `/api/appointments/${appointment.id}/reschedule`,
      {
        method: "PATCH",
        headers: authHeaders(patientToken),
        body: JSON.stringify({ newReservationId: newHold.id })
      }
    );

    assert.equal(response.status, 409);
  });

  test("non-working new slot is rejected", async () => {
    const date = nextUtcDateForWeekday(1);
    const { appointment } = await createBookedAppointment({ date });
    const newDoctorId = await createDoctor({ endTime: "10:00" });
    const newHold = await createHold({
      doctorId: newDoctorId,
      slotStartAt: startAt(date, "11:00")
    });

    const response = await requestJson(
      `/api/appointments/${appointment.id}/reschedule`,
      {
        method: "PATCH",
        headers: authHeaders(patientToken),
        body: JSON.stringify({ newReservationId: newHold.id })
      }
    );

    assert.equal(response.status, 409);
  });

  test("conflicting new slot is rejected", async () => {
    const otherPatient = await createPatient();
    const date = nextUtcDateForWeekday(1);
    const { appointment } = await createBookedAppointment({ date });
    const newDoctorId = await createDoctor();
    const newHold = await createHold({
      doctorId: newDoctorId,
      slotStartAt: startAt(date, "10:00")
    });
    await prisma.appointment.create({
      data: {
        doctorId: newDoctorId,
        patientId: otherPatient.id,
        startAt: dateAt(date, "10:00"),
        endAt: dateAt(date, "10:30"),
        status: AppointmentStatus.BOOKED,
        symptoms: "Conflicting appointment"
      }
    });

    const response = await requestJson(
      `/api/appointments/${appointment.id}/reschedule`,
      {
        method: "PATCH",
        headers: authHeaders(patientToken),
        body: JSON.stringify({ newReservationId: newHold.id })
      }
    );

    assert.equal(response.status, 409);
  });

  test("reschedule creates exactly three expected outbox jobs", async () => {
    const date = nextUtcDateForWeekday(1);
    const { appointment } = await createBookedAppointment({ date });
    const newDoctorId = await createDoctor();
    const newHold = await createHold({
      doctorId: newDoctorId,
      slotStartAt: startAt(date, "10:00")
    });

    const response = await requestJson(
      `/api/appointments/${appointment.id}/reschedule`,
      {
        method: "PATCH",
        headers: authHeaders(patientToken),
        body: JSON.stringify({ newReservationId: newHold.id })
      }
    );
    assert.equal(response.status, 201);

    const jobs = await countOutboxJobsForAppointment(
      appointment.id,
      rescheduleOutboxJobTypes
    );

    assert.deepEqual(
      jobs.map((job) => job.type).sort(),
      [...rescheduleOutboxJobTypes].sort()
    );
    assert.equal(jobs.every((job) => job.status === "PENDING"), true);
  });

  test("rescheduling failure preserves old appointment and reservations", async () => {
    const date = nextUtcDateForWeekday(1);
    const { appointment, reservation } = await createBookedAppointment({
      date,
      time: "09:00"
    });
    const newDoctorId = await createDoctor();
    const newHold = await createHold({
      doctorId: newDoctorId,
      slotStartAt: startAt(date, "10:00")
    });
    const jobsBefore = await countOutboxJobsForAppointment(
      appointment.id,
      rescheduleOutboxJobTypes
    );

    await assert.rejects(
      () =>
        reschedulePatientAppointment(
          {
            patientId: seededPatientId,
            appointmentId: appointment.id,
            newReservationId: newHold.id
          },
          {
            simulateFailureAfterAppointmentUpdate: true
          }
        ),
      /Simulated reschedule transaction failure/
    );

    const [storedAppointment, oldReservation, newReservation, jobsAfter] =
      await Promise.all([
        prisma.appointment.findUniqueOrThrow({
          where: { id: appointment.id },
          select: { doctorId: true, startAt: true, endAt: true, status: true }
        }),
        prisma.slotReservation.findUniqueOrThrow({
          where: { id: reservation.id },
          select: { status: true, appointmentId: true }
        }),
        prisma.slotReservation.findUniqueOrThrow({
          where: { id: newHold.id },
          select: { status: true, appointmentId: true }
        }),
        countOutboxJobsForAppointment(appointment.id, rescheduleOutboxJobTypes)
      ]);

    assert.equal(storedAppointment.doctorId, appointment.doctorId);
    assert.equal(storedAppointment.startAt.toISOString(), startAt(date, "09:00"));
    assert.equal(storedAppointment.status, AppointmentStatus.BOOKED);
    assert.equal(oldReservation.status, ReservationStatus.BOOKED);
    assert.equal(oldReservation.appointmentId, appointment.id);
    assert.equal(newReservation.status, ReservationStatus.HOLD);
    assert.equal(newReservation.appointmentId, null);
    assert.equal(jobsAfter.length, jobsBefore.length);
  });

  test("repeated reschedule with same reservation does not duplicate state or jobs", async () => {
    const date = nextUtcDateForWeekday(1);
    const { appointment } = await createBookedAppointment({ date });
    const newDoctorId = await createDoctor();
    const newHold = await createHold({
      doctorId: newDoctorId,
      slotStartAt: startAt(date, "10:00")
    });

    const firstResponse = await requestJson(
      `/api/appointments/${appointment.id}/reschedule`,
      {
        method: "PATCH",
        headers: authHeaders(patientToken),
        body: JSON.stringify({ newReservationId: newHold.id })
      }
    );
    const secondResponse = await requestJson(
      `/api/appointments/${appointment.id}/reschedule`,
      {
        method: "PATCH",
        headers: authHeaders(patientToken),
        body: JSON.stringify({ newReservationId: newHold.id })
      }
    );

    const jobs = await countOutboxJobsForAppointment(
      appointment.id,
      rescheduleOutboxJobTypes
    );
    const linkedBookedReservations = await prisma.slotReservation.count({
      where: {
        appointmentId: appointment.id,
        status: ReservationStatus.BOOKED
      }
    });

    assert.equal(firstResponse.status, 201);
    assert.equal(secondResponse.status, 200);
    assert.equal(jobs.length, 3);
    assert.equal(linkedBookedReservations, 1);
  });

  test("simultaneous competing reschedules leave one final booked reservation and one job set", async () => {
    const date = nextUtcDateForWeekday(1);
    const { appointment, reservation } = await createBookedAppointment({
      date,
      time: "09:00"
    });
    const newDoctorA = await createDoctor();
    const newDoctorB = await createDoctor();
    const newHoldA = await createHold({
      doctorId: newDoctorA,
      slotStartAt: startAt(date, "10:00")
    });
    const newHoldB = await createHold({
      doctorId: newDoctorB,
      slotStartAt: startAt(date, "10:30")
    });

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_value, index) =>
        requestJson(`/api/appointments/${appointment.id}/reschedule`, {
          method: "PATCH",
          headers: authHeaders(patientToken),
          body: JSON.stringify({
            newReservationId: index % 2 === 0 ? newHoldA.id : newHoldB.id
          })
        })
      )
    );

    const acceptableResponses = responses.filter((response) =>
      [200, 201, 409].includes(response.status)
    );
    const [storedAppointment, oldReservation, bookedReservations, jobs] =
      await Promise.all([
        prisma.appointment.findUniqueOrThrow({
          where: { id: appointment.id },
          select: { doctorId: true, startAt: true, status: true }
        }),
        prisma.slotReservation.findUniqueOrThrow({
          where: { id: reservation.id },
          select: { status: true, appointmentId: true }
        }),
        prisma.slotReservation.findMany({
          where: {
            appointmentId: appointment.id,
            status: ReservationStatus.BOOKED
          },
          select: {
            id: true,
            doctorId: true,
            startAt: true
          }
        }),
        countOutboxJobsForAppointment(appointment.id, rescheduleOutboxJobTypes)
      ]);

    assert.equal(acceptableResponses.length, 10);
    assert.equal(storedAppointment.status, AppointmentStatus.BOOKED);
    assert.equal(oldReservation.status, ReservationStatus.RELEASED);
    assert.equal(oldReservation.appointmentId, null);
    assert.equal(bookedReservations.length, 1);
    assert.equal(bookedReservations[0].doctorId, storedAppointment.doctorId);
    assert.equal(
      bookedReservations[0].startAt.toISOString(),
      storedAppointment.startAt.toISOString()
    );
    assert.equal(jobs.length, 3);
  });
});
