import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import bcrypt from "bcrypt";
import {
  AiSummaryStatus,
  AppointmentStatus,
  OutboxJobStatus,
  PrescriptionFrequency,
  UserRole,
  UrgencyLevel
} from "@prisma/client";

process.env.NODE_ENV = "test";

const [
  { app },
  { prisma },
  { completeDoctorVisit, postVisitSummaryJobType }
] = await Promise.all([
  import("../app.js"),
  import("../utils/prisma.js"),
  import("../services/doctor-appointment.service.js")
]);

const userIds = new Set<string>();
const appointmentIds = new Set<string>();
let server: Server;
let baseUrl: string;
let doctorOne: DoctorFixture;
let doctorTwo: DoctorFixture;
let patient: UserFixture;
let patientToken: string;
let adminToken: string;

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

type UserFixture = {
  id: string;
  email: string;
};

type DoctorFixture = UserFixture & {
  token: string;
  doctorProfileId: string;
};

type DoctorAppointmentResponse = {
  appointment: {
    id: string;
    patient: {
      id: string;
      name: string;
      email?: string;
      passwordHash?: string;
    };
    startAt: string;
    endAt: string;
    status: string;
    symptoms: string | null;
    urgency: string | null;
    preVisitSummary: unknown;
    preSummaryStatus: string;
    preVisitSummaryFallback: string | null;
    clinicalNotes: string | null;
    followUpInstructions: string | null;
    postSummaryStatus: string;
    prescriptions: Array<{
      id: string;
      medicine: string;
      dosage: string;
      frequency: string;
      durationDays: number;
      instructions: string | null;
    }>;
    passwordHash?: string;
    email?: string;
  };
};

type DoctorAppointmentListResponse = {
  appointments: DoctorAppointmentResponse["appointment"][];
};

function makeEmail(prefix: string) {
  return `${prefix}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2)}@example.com`;
}

function futureDate(offsetDays: number, hour = 9) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  date.setUTCHours(hour, 0, 0, 0);

  return date;
}

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
      key === "password" ||
      key === "JWT_SECRET" ||
      key === "LLM_API_KEY" ||
      containsSensitiveField(childValue)
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
  const email = makeEmail("doctor.visit.patient");
  const user = await prisma.user.create({
    data: {
      name: "Doctor Visit Patient",
      email,
      passwordHash: await bcrypt.hash("Password123!", 10),
      role: UserRole.PATIENT
    },
    select: {
      id: true,
      email: true
    }
  });

  userIds.add(user.id);

  return user;
}

async function createAdmin() {
  const email = makeEmail("doctor.visit.admin");
  const user = await prisma.user.create({
    data: {
      name: "Doctor Visit Admin",
      email,
      passwordHash: await bcrypt.hash("Password123!", 10),
      role: UserRole.ADMIN
    },
    select: {
      id: true,
      email: true
    }
  });

  userIds.add(user.id);

  return user;
}

async function createDoctor(name: string) {
  const email = makeEmail("doctor.visit.doctor");
  const user = await prisma.user.create({
    data: {
      name,
      email,
      passwordHash: await bcrypt.hash("Password123!", 10),
      role: UserRole.DOCTOR,
      doctorProfile: {
        create: {
          specialization: "Visit Completion",
          slotDurationMinutes: 30
        }
      }
    },
    select: {
      id: true,
      email: true,
      doctorProfile: {
        select: {
          id: true
        }
      }
    }
  });

  userIds.add(user.id);
  assert.ok(user.doctorProfile);

  return {
    id: user.id,
    email: user.email,
    doctorProfileId: user.doctorProfile.id,
    token: (await login(user.email)).token
  };
}

async function createAppointment(options: {
  doctorId?: string;
  patientId?: string;
  status?: AppointmentStatus;
  symptoms?: string;
  startAt?: Date;
  preSummaryStatus?: AiSummaryStatus;
  preVisitSummary?: object;
  urgency?: UrgencyLevel | null;
  clinicalNotes?: string | null;
  followUpInstructions?: string | null;
  postSummaryStatus?: AiSummaryStatus;
} = {}) {
  const startAt = options.startAt ?? futureDate(14 + appointmentIds.size);
  const appointment = await prisma.appointment.create({
    data: {
      patientId: options.patientId ?? patient.id,
      doctorId: options.doctorId ?? doctorOne.doctorProfileId,
      startAt,
      endAt: new Date(startAt.getTime() + 30 * 60 * 1000),
      status: options.status ?? AppointmentStatus.BOOKED,
      symptoms: options.symptoms ?? "Persistent cough and mild fever.",
      preSummaryStatus: options.preSummaryStatus ?? AiSummaryStatus.PENDING,
      preVisitSummary: options.preVisitSummary,
      urgency: options.urgency,
      clinicalNotes: options.clinicalNotes,
      followUpInstructions: options.followUpInstructions,
      postSummaryStatus: options.postSummaryStatus ?? AiSummaryStatus.NOT_REQUESTED
    },
    select: {
      id: true
    }
  });

  appointmentIds.add(appointment.id);

  return appointment;
}

function completeVisitBody(overrides: Record<string, unknown> = {}) {
  return {
    clinicalNotes: "Patient examined. Findings consistent with reported symptoms.",
    followUpInstructions: "Return if symptoms worsen or do not improve.",
    prescriptions: [
      {
        medicine: "Amoxicillin",
        dosage: "500mg",
        frequency: PrescriptionFrequency.TWICE_DAILY,
        durationDays: 5,
        instructions: "Take after food"
      }
    ],
    ...overrides
  };
}

async function completeVisitRequest(
  token: string | undefined,
  appointmentId: string,
  body: unknown = completeVisitBody()
) {
  return requestJson(`/api/doctor/appointments/${appointmentId}/complete`, {
    method: "POST",
    headers: token ? authHeaders(token) : {},
    body: JSON.stringify(body)
  });
}

async function postVisitJobsForAppointment(appointmentId: string) {
  const jobs = await prisma.outboxJob.findMany({
    where: {
      type: postVisitSummaryJobType
    },
    select: {
      id: true,
      status: true,
      attempts: true,
      payload: true
    }
  });

  return jobs.filter((job) => {
    const payload = job.payload;

    return (
      typeof payload === "object" &&
      payload !== null &&
      !Array.isArray(payload) &&
      "appointmentId" in payload &&
      payload.appointmentId === appointmentId
    );
  });
}

async function appointmentPrescriptionCount(appointmentId: string) {
  return prisma.prescription.count({
    where: {
      appointmentId
    }
  });
}

before(async () => {
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  patient = await createPatient();
  const admin = await createAdmin();
  patientToken = (await login(patient.email)).token;
  adminToken = (await login(admin.email)).token;
  doctorOne = await createDoctor("Dr. Visit One");
  doctorTwo = await createDoctor("Dr. Visit Two");
});

after(async () => {
  if (appointmentIds.size > 0) {
    const jobs = await prisma.outboxJob.findMany({
      where: {
        type: postVisitSummaryJobType
      },
      select: {
        id: true,
        payload: true
      }
    });
    const jobIds = jobs
      .filter((job) => {
        const payload = job.payload;

        return (
          typeof payload === "object" &&
          payload !== null &&
          !Array.isArray(payload) &&
          "appointmentId" in payload &&
          typeof payload.appointmentId === "string" &&
          appointmentIds.has(payload.appointmentId)
        );
      })
      .map((job) => job.id);

    if (jobIds.length > 0) {
      await prisma.outboxJob.deleteMany({
        where: {
          id: {
            in: jobIds
          }
        }
      });
    }

    await prisma.appointment.deleteMany({
      where: {
        id: {
          in: [...appointmentIds]
        }
      }
    });
  }

  if (userIds.size > 0) {
    await prisma.user.deleteMany({
      where: {
        id: {
          in: [...userIds]
        }
      }
    });
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await prisma.$disconnect();
});

describe("doctor appointment views and visit completion", () => {
  test("unauthenticated doctor list returns 401", async () => {
    const response = await requestJson("/api/doctor/appointments");

    assert.equal(response.status, 401);
  });

  test("patient cannot access doctor endpoints", async () => {
    const response = await requestJson("/api/doctor/appointments", {
      headers: authHeaders(patientToken)
    });

    assert.equal(response.status, 403);
  });

  test("admin cannot access doctor endpoints", async () => {
    const response = await requestJson("/api/doctor/appointments", {
      headers: authHeaders(adminToken)
    });

    assert.equal(response.status, 403);
  });

  test("doctor sees only their appointments", async () => {
    const ownAppointment = await createAppointment();
    const otherAppointment = await createAppointment({
      doctorId: doctorTwo.doctorProfileId
    });

    const response = await requestJson("/api/doctor/appointments", {
      headers: authHeaders(doctorOne.token)
    });
    const body = response.body as DoctorAppointmentListResponse;
    const appointmentIdsInResponse = body.appointments.map(
      (appointment) => appointment.id
    );

    assert.equal(response.status, 200);
    assert.ok(appointmentIdsInResponse.includes(ownAppointment.id));
    assert.ok(!appointmentIdsInResponse.includes(otherAppointment.id));
  });

  test("doctor detail succeeds for assigned appointment", async () => {
    const appointment = await createAppointment();

    const response = await requestJson(`/api/doctor/appointments/${appointment.id}`, {
      headers: authHeaders(doctorOne.token)
    });
    const body = response.body as DoctorAppointmentResponse;

    assert.equal(response.status, 200);
    assert.equal(body.appointment.id, appointment.id);
    assert.equal(body.appointment.patient.name, "Doctor Visit Patient");
  });

  test("doctor cannot access another doctor's appointment", async () => {
    const appointment = await createAppointment({
      doctorId: doctorTwo.doctorProfileId
    });

    const response = await requestJson(`/api/doctor/appointments/${appointment.id}`, {
      headers: authHeaders(doctorOne.token)
    });

    assert.equal(response.status, 404);
  });

  test("symptoms appear in doctor response", async () => {
    const appointment = await createAppointment({
      symptoms: "Nausea and headache since morning."
    });

    const response = await requestJson(`/api/doctor/appointments/${appointment.id}`, {
      headers: authHeaders(doctorOne.token)
    });
    const body = response.body as DoctorAppointmentResponse;

    assert.equal(body.appointment.symptoms, "Nausea and headache since morning.");
  });

  test("successful pre-visit summary appears in doctor response", async () => {
    const summary = {
      urgency: UrgencyLevel.HIGH,
      chiefComplaint: "Chest pain",
      suggestedQuestions: [
        "When did the chest pain start?",
        "Does the pain radiate anywhere?",
        "What makes the pain better or worse?"
      ]
    };
    const appointment = await createAppointment({
      preSummaryStatus: AiSummaryStatus.COMPLETED,
      preVisitSummary: summary,
      urgency: UrgencyLevel.HIGH
    });

    const response = await requestJson(`/api/doctor/appointments/${appointment.id}`, {
      headers: authHeaders(doctorOne.token)
    });
    const body = response.body as DoctorAppointmentResponse;

    assert.equal(body.appointment.urgency, UrgencyLevel.HIGH);
    assert.deepEqual(body.appointment.preVisitSummary, summary);
    assert.equal(body.appointment.preVisitSummaryFallback, null);
  });

  test("failed pre-summary still exposes symptoms and fallback", async () => {
    const appointment = await createAppointment({
      symptoms: "Original symptoms remain available.",
      preSummaryStatus: AiSummaryStatus.FAILED
    });

    const response = await requestJson(`/api/doctor/appointments/${appointment.id}`, {
      headers: authHeaders(doctorOne.token)
    });
    const body = response.body as DoctorAppointmentResponse;

    assert.equal(body.appointment.preSummaryStatus, AiSummaryStatus.FAILED);
    assert.equal(body.appointment.symptoms, "Original symptoms remain available.");
    assert.equal(
      body.appointment.preVisitSummaryFallback,
      "AI summary unavailable. Original patient symptoms remain available."
    );
  });

  test("doctor responses do not expose passwordHash or sensitive fields", async () => {
    const appointment = await createAppointment();

    const response = await requestJson(`/api/doctor/appointments/${appointment.id}`, {
      headers: authHeaders(doctorOne.token)
    });

    assert.equal(response.status, 200);
    assert.equal(containsSensitiveField(response.body), false);
  });

  test("assigned doctor can complete BOOKED appointment", async () => {
    const appointment = await createAppointment();

    const response = await completeVisitRequest(doctorOne.token, appointment.id);
    const body = response.body as DoctorAppointmentResponse;

    assert.equal(response.status, 200);
    assert.equal(body.appointment.status, AppointmentStatus.COMPLETED);
  });

  test("clinical notes and follow-up instructions are persisted", async () => {
    const appointment = await createAppointment();

    await completeVisitRequest(
      doctorOne.token,
      appointment.id,
      completeVisitBody({
        clinicalNotes: "Clinical notes persisted.",
        followUpInstructions: "Follow up in one week."
      })
    );
    const response = await completeVisitRequest(
      doctorOne.token,
      appointment.id,
      completeVisitBody({
        clinicalNotes: "Second completion should be rejected.",
        followUpInstructions: "Should not overwrite."
      })
    );

    const storedAppointment = await prisma.appointment.findUniqueOrThrow({
      where: {
        id: appointment.id
      },
      select: {
        clinicalNotes: true,
        followUpInstructions: true
      }
    });

    assert.equal(response.status, 409);
    assert.equal(storedAppointment.clinicalNotes, "Clinical notes persisted.");
    assert.equal(storedAppointment.followUpInstructions, "Follow up in one week.");
  });

  test("one prescription persists correctly", async () => {
    const appointment = await createAppointment();

    const response = await completeVisitRequest(doctorOne.token, appointment.id);

    const prescriptions = await prisma.prescription.findMany({
      where: {
        appointmentId: appointment.id
      },
      select: {
        medicineName: true,
        dosage: true,
        frequency: true,
        durationDays: true,
        instructions: true
      }
    });

    assert.equal(response.status, 200);
    assert.equal(prescriptions.length, 1);
    assert.equal(prescriptions[0]?.medicineName, "Amoxicillin");
    assert.equal(prescriptions[0]?.dosage, "500mg");
    assert.equal(prescriptions[0]?.frequency, PrescriptionFrequency.TWICE_DAILY);
    assert.equal(prescriptions[0]?.durationDays, 5);
    assert.equal(prescriptions[0]?.instructions, "Take after food");
  });

  test("multiple prescriptions persist correctly", async () => {
    const appointment = await createAppointment();

    const response = await completeVisitRequest(
      doctorOne.token,
      appointment.id,
      completeVisitBody({
        prescriptions: [
          {
            medicine: "Medicine A",
            dosage: "10mg",
            frequency: PrescriptionFrequency.ONCE_DAILY,
            durationDays: 3,
            instructions: "Morning"
          },
          {
            medicine: "Medicine B",
            dosage: "5ml",
            frequency: PrescriptionFrequency.THREE_TIMES_DAILY,
            durationDays: 7,
            instructions: "After meals"
          }
        ]
      })
    );

    const prescriptions = await prisma.prescription.findMany({
      where: {
        appointmentId: appointment.id
      },
      orderBy: {
        createdAt: "asc"
      }
    });

    assert.equal(response.status, 200);
    assert.equal(prescriptions.length, 2);
    assert.deepEqual(
      prescriptions.map((prescription) => prescription.medicineName).sort(),
      ["Medicine A", "Medicine B"]
    );
  });

  test("appointment becomes COMPLETED and postSummaryStatus becomes PENDING", async () => {
    const appointment = await createAppointment();

    await completeVisitRequest(doctorOne.token, appointment.id);

    const storedAppointment = await prisma.appointment.findUniqueOrThrow({
      where: {
        id: appointment.id
      },
      select: {
        status: true,
        postSummaryStatus: true
      }
    });

    assert.equal(storedAppointment.status, AppointmentStatus.COMPLETED);
    assert.equal(storedAppointment.postSummaryStatus, AiSummaryStatus.PENDING);
  });

  test("exactly one POST_VISIT_SUMMARY job is created and begins PENDING", async () => {
    const appointment = await createAppointment();

    await completeVisitRequest(doctorOne.token, appointment.id);

    const jobs = await postVisitJobsForAppointment(appointment.id);

    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.status, OutboxJobStatus.PENDING);
    assert.equal(jobs[0]?.attempts, 0);
  });

  test("another doctor cannot complete appointment", async () => {
    const appointment = await createAppointment();

    const response = await completeVisitRequest(doctorTwo.token, appointment.id);

    assert.equal(response.status, 404);
  });

  test("patient and admin cannot complete appointment", async () => {
    const appointment = await createAppointment();

    const [patientResponse, adminResponse] = await Promise.all([
      completeVisitRequest(patientToken, appointment.id),
      completeVisitRequest(adminToken, appointment.id)
    ]);

    assert.equal(patientResponse.status, 403);
    assert.equal(adminResponse.status, 403);
  });

  test("CANCELLED appointment cannot complete", async () => {
    const appointment = await createAppointment({
      status: AppointmentStatus.CANCELLED
    });

    const response = await completeVisitRequest(doctorOne.token, appointment.id);

    assert.equal(response.status, 409);
  });

  test("already COMPLETED appointment cannot duplicate data or jobs", async () => {
    const appointment = await createAppointment({
      status: AppointmentStatus.COMPLETED,
      clinicalNotes: "Already completed",
      followUpInstructions: "Already persisted",
      postSummaryStatus: AiSummaryStatus.PENDING
    });
    await prisma.prescription.create({
      data: {
        appointmentId: appointment.id,
        medicineName: "Existing Medicine",
        dosage: "1 tablet",
        frequency: PrescriptionFrequency.ONCE_DAILY,
        durationDays: 1,
        instructions: null
      }
    });
    await prisma.outboxJob.create({
      data: {
        type: postVisitSummaryJobType,
        payload: {
          appointmentId: appointment.id
        },
        status: OutboxJobStatus.PENDING,
        attempts: 0,
        nextAttemptAt: new Date()
      }
    });

    const response = await completeVisitRequest(doctorOne.token, appointment.id);

    assert.equal(response.status, 409);
    assert.equal(await appointmentPrescriptionCount(appointment.id), 1);
    assert.equal((await postVisitJobsForAppointment(appointment.id)).length, 1);
  });

  test("missing clinical notes returns 400", async () => {
    const appointment = await createAppointment();

    const response = await completeVisitRequest(
      doctorOne.token,
      appointment.id,
      completeVisitBody({ clinicalNotes: "" })
    );

    assert.equal(response.status, 400);
  });

  test("invalid prescription returns 400", async () => {
    const appointment = await createAppointment();

    const response = await completeVisitRequest(
      doctorOne.token,
      appointment.id,
      completeVisitBody({
        prescriptions: [
          {
            medicine: "",
            dosage: "500mg",
            frequency: PrescriptionFrequency.TWICE_DAILY,
            durationDays: 5
          }
        ]
      })
    );

    assert.equal(response.status, 400);
  });

  test("invalid medication frequency returns 400", async () => {
    const appointment = await createAppointment();

    const response = await completeVisitRequest(
      doctorOne.token,
      appointment.id,
      completeVisitBody({
        prescriptions: [
          {
            medicine: "Medicine",
            dosage: "500mg",
            frequency: "EVERY_HOUR",
            durationDays: 5
          }
        ]
      })
    );

    assert.equal(response.status, 400);
  });

  test("non-positive duration returns 400", async () => {
    const appointment = await createAppointment();

    const response = await completeVisitRequest(
      doctorOne.token,
      appointment.id,
      completeVisitBody({
        prescriptions: [
          {
            medicine: "Medicine",
            dosage: "500mg",
            frequency: PrescriptionFrequency.TWICE_DAILY,
            durationDays: 0
          }
        ]
      })
    );

    assert.equal(response.status, 400);
  });

  test("completion response exposes no passwordHash or secrets", async () => {
    const appointment = await createAppointment();

    const response = await completeVisitRequest(doctorOne.token, appointment.id);

    assert.equal(response.status, 200);
    assert.equal(containsSensitiveField(response.body), false);
  });

  test("forced failure leaves no partial completion, prescriptions, or job", async () => {
    const appointment = await createAppointment();

    await assert.rejects(
      () =>
        completeDoctorVisit(
          {
            doctorUserId: doctorOne.id,
            appointmentId: appointment.id,
            clinicalNotes: "Rollback clinical notes",
            followUpInstructions: "Rollback follow up",
            prescriptions: [
              {
                medicine: "Rollback Medicine",
                dosage: "1 tablet",
                frequency: PrescriptionFrequency.ONCE_DAILY,
                durationDays: 2,
                instructions: "Rollback instructions"
              }
            ]
          },
          {
            simulateFailureAfterAppointmentUpdate: true
          }
        ),
      /Simulated visit completion transaction failure/
    );

    const storedAppointment = await prisma.appointment.findUniqueOrThrow({
      where: {
        id: appointment.id
      },
      select: {
        status: true,
        clinicalNotes: true,
        followUpInstructions: true,
        postSummaryStatus: true
      }
    });

    assert.equal(storedAppointment.status, AppointmentStatus.BOOKED);
    assert.equal(storedAppointment.clinicalNotes, null);
    assert.equal(storedAppointment.followUpInstructions, null);
    assert.equal(storedAppointment.postSummaryStatus, AiSummaryStatus.NOT_REQUESTED);
    assert.equal(await appointmentPrescriptionCount(appointment.id), 0);
    assert.equal((await postVisitJobsForAppointment(appointment.id)).length, 0);
  });

  test("simultaneous completion creates exactly one completed visit", async () => {
    const appointment = await createAppointment();

    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        completeVisitRequest(doctorOne.token, appointment.id)
      )
    );
    const successResponses = responses.filter((response) => response.status === 200);
    const conflictResponses = responses.filter((response) => response.status === 409);
    const storedAppointment = await prisma.appointment.findUniqueOrThrow({
      where: {
        id: appointment.id
      },
      select: {
        status: true,
        clinicalNotes: true
      }
    });
    const prescriptionCount = await appointmentPrescriptionCount(appointment.id);
    const jobCount = (await postVisitJobsForAppointment(appointment.id)).length;

    assert.equal(successResponses.length, 1);
    assert.equal(conflictResponses.length, 9);
    assert.equal(storedAppointment.status, AppointmentStatus.COMPLETED);
    assert.equal(
      storedAppointment.clinicalNotes,
      "Patient examined. Findings consistent with reported symptoms."
    );
    assert.equal(prescriptionCount, 1);
    assert.equal(jobCount, 1);
  });
});
