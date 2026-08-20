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

const [
  { app },
  { prisma },
  { bookingOutboxJobTypes },
  { addLeave, doctorLeaveCancellationOutboxJobTypes }
] = await Promise.all([
  import("../app.js"),
  import("../utils/prisma.js"),
  import("../services/appointment-booking.service.js"),
  import("../services/admin-doctor.service.js")
]);

const testEmails = new Set<string>();
const doctorIds = new Set<string>();
let server: Server;
let baseUrl: string;
let adminToken: string;
let patientToken: string;
let doctorToken: string;
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

type LeaveResponse = {
  leave: {
    id: string;
    date: string;
    reason?: string;
    passwordHash?: string;
  };
};

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

function nextUtcDateForWeekday(targetWeekday: number, offsetDays = 35) {
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

function dayRange(date: string) {
  const start = new Date(`${date}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  return { start, end };
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

  if (response.status === 204) {
    return {
      status: response.status,
      body: null
    };
  }

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

async function createDoctor(options: {
  weekday?: Weekday;
  startTime?: string;
  endTime?: string;
  slotDuration?: number;
} = {}) {
  const email = makeEmail("leave.doctor");
  const doctor = await prisma.user.create({
    data: {
      name: "Dr. Leave Test",
      email,
      passwordHash: "not-used-in-leave-tests",
      role: UserRole.DOCTOR,
      doctorProfile: {
        create: {
          specialization: "Leave Testing",
          slotDurationMinutes: options.slotDuration ?? 30,
          availabilities: {
            create: {
              weekday: options.weekday ?? Weekday.MONDAY,
              startTime: options.startTime ?? "09:00",
              endTime: options.endTime ?? "12:00"
            }
          }
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

async function createAppointmentWithReservation(options: {
  doctorId: string;
  patientId?: string;
  slotStartAt: string;
  status?: AppointmentStatus;
  reservationStatus?: ReservationStatus;
}) {
  const start = new Date(options.slotStartAt);
  const appointment = await prisma.appointment.create({
    data: {
      doctorId: options.doctorId,
      patientId: options.patientId ?? seededPatientId,
      startAt: start,
      endAt: new Date(start.getTime() + 30 * 60 * 1000),
      status: options.status ?? AppointmentStatus.BOOKED,
      symptoms: "Leave conflict test symptoms",
      cancelledAt:
        options.status === AppointmentStatus.CANCELLED
          ? new Date(start.getTime() - 60 * 60 * 1000)
          : undefined
    },
    select: {
      id: true,
      startAt: true
    }
  });

  const reservationStatus =
    options.reservationStatus ??
    (options.status === AppointmentStatus.CANCELLED
      ? ReservationStatus.RELEASED
      : ReservationStatus.BOOKED);

  const reservation = await prisma.slotReservation.create({
    data: {
      doctorId: options.doctorId,
      patientId: options.patientId ?? seededPatientId,
      startAt: start,
      status: reservationStatus,
      expiresAt: reservationStatus === ReservationStatus.HOLD ? new Date(Date.now() + 300_000) : null,
      appointmentId:
        reservationStatus === ReservationStatus.BOOKED ? appointment.id : null
    },
    select: {
      id: true
    }
  });

  return { appointment, reservation };
}

async function createHold(options: {
  doctorId: string;
  slotStartAt: string;
  patientId?: string;
}) {
  return prisma.slotReservation.create({
    data: {
      doctorId: options.doctorId,
      patientId: options.patientId ?? seededPatientId,
      startAt: new Date(options.slotStartAt),
      status: ReservationStatus.HOLD,
      expiresAt: new Date(Date.now() + 300_000)
    },
    select: {
      id: true
    }
  });
}

async function createLeaveRequest(
  token: string | undefined,
  doctorId: string,
  date: string,
  reason = "Milestone 9 leave"
) {
  return requestJson(`/api/admin/doctors/${doctorId}/leave`, {
    method: "POST",
    headers: token ? authHeaders(token) : {},
    body: JSON.stringify({
      date,
      reason
    })
  });
}

async function bookingRequest(
  token: string,
  reservationId: string,
  symptoms = "Symptoms for leave race booking"
) {
  return requestJson("/api/appointments", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      reservationId,
      symptoms
    })
  });
}

async function leaveJobsForAppointment(appointmentId: string) {
  const rows = await prisma.$queryRaw<Array<{ type: string; status: string }>>`
    SELECT type, status
    FROM "OutboxJob"
    WHERE payload->>'appointmentId' = ${appointmentId}
  `;

  return rows.filter((row) =>
    doctorLeaveCancellationOutboxJobTypes.includes(
      row.type as (typeof doctorLeaveCancellationOutboxJobTypes)[number]
    )
  );
}

async function milestoneOutboxCountForAppointment(appointmentId: string) {
  const rows = await prisma.$queryRaw<Array<{ type: string }>>`
    SELECT type
    FROM "OutboxJob"
    WHERE payload->>'appointmentId' = ${appointmentId}
  `;

  return rows.filter((row) =>
    [...bookingOutboxJobTypes, ...doctorLeaveCancellationOutboxJobTypes].includes(
      row.type as (typeof bookingOutboxJobTypes)[number]
    )
  ).length;
}

before(async () => {
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [adminLogin, patientLogin, doctorLogin] = await Promise.all([
    login("admin@example.com"),
    login("patient@example.com"),
    login("maya.patel@example.com")
  ]);

  adminToken = adminLogin.token;
  patientToken = patientLogin.token;
  seededPatientId = patientLogin.user.id;
  doctorToken = doctorLogin.token;
});

after(async () => {
  await prisma.outboxJob.deleteMany({
    where: {
      type: {
        in: [...bookingOutboxJobTypes, ...doctorLeaveCancellationOutboxJobTypes]
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

describe("doctor leave conflict handling", () => {
  test("unauthenticated leave create returns 401", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();

    const response = await createLeaveRequest(undefined, doctorId, date);

    assert.equal(response.status, 401);
  });

  test("patient and doctor are blocked from leave create", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    const [patientResponse, doctorResponse] = await Promise.all([
      createLeaveRequest(patientToken, doctorId, date),
      createLeaveRequest(doctorToken, doctorId, date)
    ]);

    assert.equal(patientResponse.status, 403);
    assert.equal(doctorResponse.status, 403);
  });

  test("admin creates leave with no appointments", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();

    const response = await createLeaveRequest(adminToken, doctorId, date);

    assert.equal(response.status, 201);
    assert.ok((response.body as LeaveResponse).leave.id);
  });

  test("leave record exists after creation", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    const response = await createLeaveRequest(adminToken, doctorId, date);
    assert.equal(response.status, 201);

    const leaveCount = await prisma.doctorLeave.count({
      where: {
        doctorId,
        date: new Date(`${date}T00:00:00.000Z`)
      }
    });

    assert.equal(leaveCount, 1);
  });

  test("admin creates leave with one BOOKED appointment", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    await createAppointmentWithReservation({
      doctorId,
      slotStartAt: startAt(date, "09:00")
    });

    const response = await createLeaveRequest(adminToken, doctorId, date);

    assert.equal(response.status, 201);
  });

  test("affected BOOKED appointment becomes CANCELLED", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    const { appointment } = await createAppointmentWithReservation({
      doctorId,
      slotStartAt: startAt(date, "09:00")
    });

    const response = await createLeaveRequest(adminToken, doctorId, date);
    assert.equal(response.status, 201);

    const storedAppointment = await prisma.appointment.findUniqueOrThrow({
      where: { id: appointment.id },
      select: { status: true, cancelledAt: true }
    });

    assert.equal(storedAppointment.status, AppointmentStatus.CANCELLED);
    assert.ok(storedAppointment.cancelledAt);
  });

  test("associated BOOKED reservation becomes RELEASED", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    const { reservation } = await createAppointmentWithReservation({
      doctorId,
      slotStartAt: startAt(date, "09:00")
    });

    const response = await createLeaveRequest(adminToken, doctorId, date);
    assert.equal(response.status, 201);

    const storedReservation = await prisma.slotReservation.findUniqueOrThrow({
      where: { id: reservation.id },
      select: { status: true, appointmentId: true }
    });

    assert.equal(storedReservation.status, ReservationStatus.RELEASED);
    assert.equal(storedReservation.appointmentId, null);
  });

  test("exactly expected leave cancellation outbox jobs are created", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    const { appointment } = await createAppointmentWithReservation({
      doctorId,
      slotStartAt: startAt(date, "09:00")
    });

    const response = await createLeaveRequest(adminToken, doctorId, date);
    assert.equal(response.status, 201);

    const jobs = await leaveJobsForAppointment(appointment.id);

    assert.deepEqual(
      jobs.map((job) => job.type).sort(),
      [...doctorLeaveCancellationOutboxJobTypes].sort()
    );
    assert.equal(jobs.every((job) => job.status === "PENDING"), true);
  });

  test("leave with multiple booked appointments cancels all of them", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    const first = await createAppointmentWithReservation({
      doctorId,
      slotStartAt: startAt(date, "09:00")
    });
    const second = await createAppointmentWithReservation({
      doctorId,
      slotStartAt: startAt(date, "10:00")
    });

    const response = await createLeaveRequest(adminToken, doctorId, date);
    assert.equal(response.status, 201);

    const cancelledCount = await prisma.appointment.count({
      where: {
        id: {
          in: [first.appointment.id, second.appointment.id]
        },
        status: AppointmentStatus.CANCELLED
      }
    });

    assert.equal(cancelledCount, 2);
  });

  test("already CANCELLED appointment remains unchanged", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    const { appointment } = await createAppointmentWithReservation({
      doctorId,
      slotStartAt: startAt(date, "09:00"),
      status: AppointmentStatus.CANCELLED,
      reservationStatus: ReservationStatus.RELEASED
    });

    const response = await createLeaveRequest(adminToken, doctorId, date);
    assert.equal(response.status, 201);

    const storedAppointment = await prisma.appointment.findUniqueOrThrow({
      where: { id: appointment.id },
      select: { status: true }
    });
    const jobs = await leaveJobsForAppointment(appointment.id);

    assert.equal(storedAppointment.status, AppointmentStatus.CANCELLED);
    assert.equal(jobs.length, 0);
  });

  test("COMPLETED appointment remains unchanged", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    const { appointment, reservation } = await createAppointmentWithReservation({
      doctorId,
      slotStartAt: startAt(date, "09:00"),
      status: AppointmentStatus.COMPLETED,
      reservationStatus: ReservationStatus.BOOKED
    });

    const response = await createLeaveRequest(adminToken, doctorId, date);
    assert.equal(response.status, 201);

    const [storedAppointment, storedReservation, jobs] = await Promise.all([
      prisma.appointment.findUniqueOrThrow({
        where: { id: appointment.id },
        select: { status: true }
      }),
      prisma.slotReservation.findUniqueOrThrow({
        where: { id: reservation.id },
        select: { status: true, appointmentId: true }
      }),
      leaveJobsForAppointment(appointment.id)
    ]);

    assert.equal(storedAppointment.status, AppointmentStatus.COMPLETED);
    assert.equal(storedReservation.status, ReservationStatus.BOOKED);
    assert.equal(storedReservation.appointmentId, appointment.id);
    assert.equal(jobs.length, 0);
  });

  test("duplicate leave returns 409", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();

    const firstResponse = await createLeaveRequest(adminToken, doctorId, date);
    const duplicateResponse = await createLeaveRequest(adminToken, doctorId, date);

    assert.equal(firstResponse.status, 201);
    assert.equal(duplicateResponse.status, 409);
  });

  test("duplicate leave creates no duplicate outbox jobs", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    const { appointment } = await createAppointmentWithReservation({
      doctorId,
      slotStartAt: startAt(date, "09:00")
    });

    const firstResponse = await createLeaveRequest(adminToken, doctorId, date);
    const duplicateResponse = await createLeaveRequest(adminToken, doctorId, date);
    const jobs = await leaveJobsForAppointment(appointment.id);

    assert.equal(firstResponse.status, 201);
    assert.equal(duplicateResponse.status, 409);
    assert.equal(jobs.length, 3);
  });

  test("deleting leave does not restore cancelled appointments", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    const { appointment, reservation } = await createAppointmentWithReservation({
      doctorId,
      slotStartAt: startAt(date, "09:00")
    });
    const createResponse = await createLeaveRequest(adminToken, doctorId, date);
    assert.equal(createResponse.status, 201);

    const leave = (createResponse.body as LeaveResponse).leave;
    const deleteResponse = await requestJson(
      `/api/admin/doctors/${doctorId}/leave/${leave.id}`,
      {
        method: "DELETE",
        headers: authHeaders(adminToken)
      }
    );
    assert.equal(deleteResponse.status, 204);

    const [storedAppointment, storedReservation] = await Promise.all([
      prisma.appointment.findUniqueOrThrow({
        where: { id: appointment.id },
        select: { status: true }
      }),
      prisma.slotReservation.findUniqueOrThrow({
        where: { id: reservation.id },
        select: { status: true, appointmentId: true }
      })
    ]);

    assert.equal(storedAppointment.status, AppointmentStatus.CANCELLED);
    assert.equal(storedReservation.status, ReservationStatus.RELEASED);
    assert.equal(storedReservation.appointmentId, null);
  });

  test("booking after existing leave fails", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    const hold = await createHold({
      doctorId,
      slotStartAt: startAt(date, "09:00")
    });
    const leaveResponse = await createLeaveRequest(adminToken, doctorId, date);
    assert.equal(leaveResponse.status, 201);

    const bookingResponse = await bookingRequest(patientToken, hold.id);

    assert.equal(bookingResponse.status, 409);
  });

  test("slot generation returns empty slots for leave date", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    const leaveResponse = await createLeaveRequest(adminToken, doctorId, date);
    assert.equal(leaveResponse.status, 201);

    const slotsResponse = await requestJson(`/api/doctors/${doctorId}/slots?date=${date}`);

    assert.equal(slotsResponse.status, 200);
    assert.deepEqual((slotsResponse.body as { slots: unknown[] }).slots, []);
  });

  test("leave responses expose no passwordHash", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();

    const response = await createLeaveRequest(adminToken, doctorId, date);

    assert.equal(response.status, 201);
    assert.equal(containsPasswordHash(response.body), false);
  });

  test("leave transaction rollback leaves no partial cancellation state", async () => {
    const date = nextUtcDateForWeekday(1);
    const doctorId = await createDoctor();
    const { appointment, reservation } = await createAppointmentWithReservation({
      doctorId,
      slotStartAt: startAt(date, "09:00")
    });
    const jobCountBefore = await milestoneOutboxCountForAppointment(
      appointment.id
    );

    await assert.rejects(
      () =>
        addLeave(
          doctorId,
          {
            date,
            reason: "Simulated failure"
          },
          {
            simulateFailureAfterAppointmentCancellation: true
          }
        ),
      /Simulated doctor leave transaction failure/
    );

    const [leaveCount, storedAppointment, storedReservation, jobCountAfter] =
      await Promise.all([
        prisma.doctorLeave.count({
          where: {
            doctorId,
            date: new Date(`${date}T00:00:00.000Z`)
          }
        }),
        prisma.appointment.findUniqueOrThrow({
          where: { id: appointment.id },
          select: { status: true, cancelledAt: true }
        }),
        prisma.slotReservation.findUniqueOrThrow({
          where: { id: reservation.id },
          select: { status: true, appointmentId: true }
        }),
        milestoneOutboxCountForAppointment(appointment.id)
      ]);

    assert.equal(leaveCount, 0);
    assert.equal(storedAppointment.status, AppointmentStatus.BOOKED);
    assert.equal(storedAppointment.cancelledAt, null);
    assert.equal(storedReservation.status, ReservationStatus.BOOKED);
    assert.equal(storedReservation.appointmentId, appointment.id);
    assert.equal(jobCountAfter, jobCountBefore);
  });

  test("booking-vs-leave race never leaves an active booked appointment under leave", async () => {
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const date = nextUtcDateForWeekday(1, 42 + iteration * 7);
      const doctorId = await createDoctor();
      const hold = await createHold({
        doctorId,
        slotStartAt: startAt(date, "09:00")
      });

      const [bookingResponse, leaveResponse] = await Promise.all([
        bookingRequest(patientToken, hold.id, `Race symptoms ${iteration}`),
        createLeaveRequest(adminToken, doctorId, date, `Race leave ${iteration}`)
      ]);

      assert.ok([201, 409].includes(bookingResponse.status));
      assert.equal(leaveResponse.status, 201);

      const { start, end } = dayRange(date);
      const [leaveCount, appointments, bookedReservations] = await Promise.all([
        prisma.doctorLeave.count({
          where: {
            doctorId,
            date: start
          }
        }),
        prisma.appointment.findMany({
          where: {
            doctorId,
            startAt: {
              gte: start,
              lt: end
            }
          },
          select: {
            id: true,
            status: true
          }
        }),
        prisma.slotReservation.count({
          where: {
            doctorId,
            startAt: {
              gte: start,
              lt: end
            },
            status: ReservationStatus.BOOKED
          }
        })
      ]);
      const activeBookedAppointments = appointments.filter(
        (appointment) => appointment.status === AppointmentStatus.BOOKED
      );
      const cancellationJobsByAppointment = await Promise.all(
        appointments.map((appointment) => leaveJobsForAppointment(appointment.id))
      );

      assert.equal(leaveCount, 1);
      assert.equal(activeBookedAppointments.length, 0);
      assert.ok(appointments.length <= 1);
      assert.equal(bookedReservations, 0);

      for (const jobs of cancellationJobsByAppointment) {
        assert.ok(jobs.length === 0 || jobs.length === 3);
      }
    }
  });
});
