import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import {
  AiSummaryStatus,
  AppointmentStatus,
  OutboxJobStatus,
  PrescriptionFrequency,
  UserRole
} from "@prisma/client";

process.env.NODE_ENV = "test";

const [
  { buildPostVisitSummaryPrompt },
  { MockLlmProvider },
  { prisma },
  {
    getPostVisitSummaryFallback,
    postVisitSummaryJobType,
    processPostVisitSummaryJob
  }
] = await Promise.all([
  import("../integrations/llm/prompts.js"),
  import("../integrations/llm/mock-llm-provider.js"),
  import("../utils/prisma.js"),
  import("../services/post-visit-summary.service.js")
]);

const userIds = new Set<string>();
const appointmentIds = new Set<string>();
const jobIds = new Set<string>();

type ProviderPostVisitOutput = {
  visitSummary?: string;
  followUpSteps?: string[];
  medicationSchedule?: unknown;
};

type StoredPostVisitSummary = {
  visitSummary: string;
  medicationSchedule: Array<{
    medicine: string;
    dosage: string;
    frequency: string;
    durationDays: number;
    instructions: string | null;
  }>;
  followUpSteps: string[];
};

class StaticPostVisitProvider {
  public callCount = 0;

  constructor(private readonly output: unknown) {}

  async generatePostVisitSummary() {
    this.callCount += 1;

    return this.output;
  }
}

class ThrowingPostVisitProvider {
  public callCount = 0;

  async generatePostVisitSummary() {
    this.callCount += 1;

    throw new Error("provider failed with secret-token passwordHash LLM_API_KEY stack");
  }
}

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

function validProviderOutput(overrides: ProviderPostVisitOutput = {}) {
  return {
    visitSummary:
      "Your doctor reviewed your symptoms and documented the visit findings.",
    followUpSteps: ["Return if symptoms worsen."],
    ...overrides
  };
}

function expectedMedicationSchedule() {
  return [
    {
      medicine: "Amoxicillin",
      dosage: "500mg",
      frequency: PrescriptionFrequency.TWICE_DAILY,
      durationDays: 5,
      instructions: "Take after food"
    },
    {
      medicine: "Cetirizine",
      dosage: "10mg",
      frequency: PrescriptionFrequency.ONCE_DAILY,
      durationDays: 3,
      instructions: "Take at night"
    }
  ];
}

async function createPatient() {
  const user = await prisma.user.create({
    data: {
      name: "Post Visit Patient",
      email: makeEmail("postvisit.patient"),
      passwordHash: "not-used-in-postvisit-tests",
      role: UserRole.PATIENT
    },
    select: {
      id: true
    }
  });

  userIds.add(user.id);

  return user;
}

async function createDoctor() {
  const user = await prisma.user.create({
    data: {
      name: "Dr. Post Visit",
      email: makeEmail("postvisit.doctor"),
      passwordHash: "not-used-in-postvisit-tests",
      role: UserRole.DOCTOR,
      doctorProfile: {
        create: {
          specialization: "Post Visit Testing",
          slotDurationMinutes: 30
        }
      }
    },
    select: {
      id: true,
      doctorProfile: {
        select: {
          id: true
        }
      }
    }
  });

  userIds.add(user.id);
  assert.ok(user.doctorProfile);

  return user.doctorProfile;
}

async function createCompletedAppointmentAndJob(options: {
  clinicalNotes?: string | null;
  followUpInstructions?: string | null;
  status?: AppointmentStatus;
  postSummaryStatus?: AiSummaryStatus;
  prescriptions?: Array<{
    medicineName: string;
    dosage: string;
    frequency: PrescriptionFrequency;
    durationDays: number;
    instructions?: string | null;
  }>;
  postVisitSummary?: object;
  jobStatus?: OutboxJobStatus;
} = {}) {
  const patient = await createPatient();
  const doctor = await createDoctor();
  const startAt = futureDate(14 + appointmentIds.size);
  const prescriptions = options.prescriptions ?? [
    {
      medicineName: "Amoxicillin",
      dosage: "500mg",
      frequency: PrescriptionFrequency.TWICE_DAILY,
      durationDays: 5,
      instructions: "Take after food"
    },
    {
      medicineName: "Cetirizine",
      dosage: "10mg",
      frequency: PrescriptionFrequency.ONCE_DAILY,
      durationDays: 3,
      instructions: "Take at night"
    }
  ];

  const appointment = await prisma.appointment.create({
    data: {
      patientId: patient.id,
      doctorId: doctor.id,
      startAt,
      endAt: new Date(startAt.getTime() + 30 * 60 * 1000),
      status: options.status ?? AppointmentStatus.COMPLETED,
      symptoms: "Cough and fever.",
      clinicalNotes:
        options.clinicalNotes === undefined
          ? "Patient examined. Lungs clear. Symptomatic care discussed."
          : options.clinicalNotes,
      followUpInstructions:
        options.followUpInstructions === undefined
          ? "Return if symptoms worsen."
          : options.followUpInstructions,
      postSummaryStatus: options.postSummaryStatus ?? AiSummaryStatus.PENDING,
      postVisitSummary: options.postVisitSummary,
      prescriptions: {
        create: prescriptions
      }
    },
    select: {
      id: true
    }
  });
  appointmentIds.add(appointment.id);

  const job = await prisma.outboxJob.create({
    data: {
      type: postVisitSummaryJobType,
      payload: {
        appointmentId: appointment.id
      },
      status: options.jobStatus ?? OutboxJobStatus.PENDING,
      attempts: 0,
      nextAttemptAt: new Date()
    },
    select: {
      id: true
    }
  });
  jobIds.add(job.id);

  return {
    appointment,
    job
  };
}

async function loadAppointment(id: string) {
  return prisma.appointment.findUniqueOrThrow({
    where: {
      id
    },
    select: {
      id: true,
      status: true,
      clinicalNotes: true,
      followUpInstructions: true,
      postSummaryStatus: true,
      postVisitSummary: true,
      prescriptions: {
        orderBy: { createdAt: "asc" },
        select: {
          medicineName: true,
          dosage: true,
          frequency: true,
          durationDays: true,
          instructions: true
        }
      }
    }
  });
}

async function loadJob(id: string) {
  return prisma.outboxJob.findUniqueOrThrow({
    where: {
      id
    },
    select: {
      status: true,
      attempts: true,
      lastError: true
    }
  });
}

function storedSummary(value: unknown) {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));

  return value as StoredPostVisitSummary;
}

after(async () => {
  if (jobIds.size > 0) {
    await prisma.outboxJob.deleteMany({
      where: {
        id: {
          in: [...jobIds]
        }
      }
    });
  }

  if (appointmentIds.size > 0) {
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

  await prisma.$disconnect();
});

describe("post-visit AI summary processing", () => {
  test("valid completed appointment generates post-visit summary", async () => {
    const { appointment, job } = await createCompletedAppointmentAndJob();

    const result = await processPostVisitSummaryJob(job.id, {
      provider: new StaticPostVisitProvider(validProviderOutput())
    });
    const updatedAppointment = await loadAppointment(appointment.id);

    assert.equal(result.status, OutboxJobStatus.COMPLETED);
    assert.ok(updatedAppointment.postVisitSummary);
  });

  test("visitSummary is stored", async () => {
    const { appointment, job } = await createCompletedAppointmentAndJob();

    await processPostVisitSummaryJob(job.id, {
      provider: new StaticPostVisitProvider(
        validProviderOutput({ visitSummary: "Patient-friendly visit summary." })
      )
    });

    const summary = storedSummary((await loadAppointment(appointment.id)).postVisitSummary);
    assert.equal(summary.visitSummary, "Patient-friendly visit summary.");
  });

  test("medicationSchedule is stored from authoritative prescriptions", async () => {
    const { appointment, job } = await createCompletedAppointmentAndJob();

    await processPostVisitSummaryJob(job.id, {
      provider: new StaticPostVisitProvider(validProviderOutput())
    });

    const summary = storedSummary((await loadAppointment(appointment.id)).postVisitSummary);
    assert.deepEqual(summary.medicationSchedule, expectedMedicationSchedule());
  });

  test("followUpSteps are stored", async () => {
    const { appointment, job } = await createCompletedAppointmentAndJob();

    await processPostVisitSummaryJob(job.id, {
      provider: new StaticPostVisitProvider(
        validProviderOutput({ followUpSteps: ["Step one.", "Step two."] })
      )
    });

    const summary = storedSummary((await loadAppointment(appointment.id)).postVisitSummary);
    assert.deepEqual(summary.followUpSteps, ["Step one.", "Step two."]);
  });

  test("postSummaryStatus becomes COMPLETED and job becomes COMPLETED", async () => {
    const { appointment, job } = await createCompletedAppointmentAndJob();

    await processPostVisitSummaryJob(job.id, {
      provider: new StaticPostVisitProvider(validProviderOutput())
    });

    const [updatedAppointment, updatedJob] = await Promise.all([
      loadAppointment(appointment.id),
      loadJob(job.id)
    ]);

    assert.equal(updatedAppointment.postSummaryStatus, AiSummaryStatus.COMPLETED);
    assert.equal(updatedJob.status, OutboxJobStatus.COMPLETED);
    assert.equal(updatedJob.attempts, 1);
    assert.equal(updatedJob.lastError, null);
  });

  test("appointment remains COMPLETED after success", async () => {
    const { appointment, job } = await createCompletedAppointmentAndJob();

    await processPostVisitSummaryJob(job.id, {
      provider: new StaticPostVisitProvider(validProviderOutput())
    });

    assert.equal((await loadAppointment(appointment.id)).status, AppointmentStatus.COMPLETED);
  });

  test("clinical notes, prescriptions, and follow-up instructions remain unchanged", async () => {
    const { appointment, job } = await createCompletedAppointmentAndJob();
    const before = await loadAppointment(appointment.id);

    await processPostVisitSummaryJob(job.id, {
      provider: new StaticPostVisitProvider(validProviderOutput())
    });

    const afterProcessing = await loadAppointment(appointment.id);

    assert.equal(afterProcessing.clinicalNotes, before.clinicalNotes);
    assert.equal(
      afterProcessing.followUpInstructions,
      before.followUpInstructions
    );
    assert.deepEqual(afterProcessing.prescriptions, before.prescriptions);
  });

  test("stored medication schedule matches doctor prescriptions", async () => {
    const { appointment, job } = await createCompletedAppointmentAndJob();

    await processPostVisitSummaryJob(job.id, {
      provider: new StaticPostVisitProvider(validProviderOutput())
    });

    const updatedAppointment = await loadAppointment(appointment.id);
    const summary = storedSummary(updatedAppointment.postVisitSummary);

    assert.deepEqual(
      summary.medicationSchedule,
      updatedAppointment.prescriptions.map((prescription) => ({
        medicine: prescription.medicineName,
        dosage: prescription.dosage,
        frequency: prescription.frequency,
        durationDays: prescription.durationDays,
        instructions: prescription.instructions
      }))
    );
  });

  test("AI cannot invent additional medication", async () => {
    const { appointment, job } = await createCompletedAppointmentAndJob();

    await processPostVisitSummaryJob(job.id, {
      provider: new StaticPostVisitProvider(
        validProviderOutput({
          medicationSchedule: [
            ...expectedMedicationSchedule(),
            {
              medicine: "Invented Medicine",
              dosage: "999mg",
              frequency: "HOURLY",
              durationDays: 99,
              instructions: "Invented"
            }
          ]
        })
      )
    });

    const summary = storedSummary((await loadAppointment(appointment.id)).postVisitSummary);
    assert.equal(summary.medicationSchedule.length, 2);
    assert.ok(
      summary.medicationSchedule.every(
        (medication) => medication.medicine !== "Invented Medicine"
      )
    );
  });

  test("AI cannot change dosage, frequency, duration, or medication instructions", async () => {
    const { appointment, job } = await createCompletedAppointmentAndJob();

    await processPostVisitSummaryJob(job.id, {
      provider: new StaticPostVisitProvider(
        validProviderOutput({
          medicationSchedule: [
            {
              medicine: "Amoxicillin",
              dosage: "1000mg",
              frequency: "THREE_TIMES_DAILY",
              durationDays: 30,
              instructions: "Take before food instead"
            }
          ]
        })
      )
    });

    const summary = storedSummary((await loadAppointment(appointment.id)).postVisitSummary);

    assert.deepEqual(summary.medicationSchedule, expectedMedicationSchedule());
  });

  test("provider failure does not change appointment COMPLETED status", async () => {
    const { appointment, job } = await createCompletedAppointmentAndJob();

    await processPostVisitSummaryJob(job.id, {
      provider: new ThrowingPostVisitProvider()
    });

    assert.equal((await loadAppointment(appointment.id)).status, AppointmentStatus.COMPLETED);
  });

  test("provider failure sets postSummaryStatus FAILED and job FAILED", async () => {
    const { appointment, job } = await createCompletedAppointmentAndJob();

    await processPostVisitSummaryJob(job.id, {
      provider: new ThrowingPostVisitProvider()
    });

    const [updatedAppointment, updatedJob] = await Promise.all([
      loadAppointment(appointment.id),
      loadJob(job.id)
    ]);

    assert.equal(updatedAppointment.postSummaryStatus, AiSummaryStatus.FAILED);
    assert.equal(updatedJob.status, OutboxJobStatus.FAILED);
  });

  test("malformed AI response and missing required field are handled safely", async () => {
    const malformed = await createCompletedAppointmentAndJob();
    const missing = await createCompletedAppointmentAndJob();

    const [malformedResult, missingResult] = await Promise.all([
      processPostVisitSummaryJob(malformed.job.id, {
        provider: new StaticPostVisitProvider("not structured")
      }),
      processPostVisitSummaryJob(missing.job.id, {
        provider: new StaticPostVisitProvider({ followUpSteps: ["Only steps."] })
      })
    ]);

    assert.equal(malformedResult.status, OutboxJobStatus.FAILED);
    assert.equal(missingResult.status, OutboxJobStatus.FAILED);
    assert.equal(
      (await loadAppointment(malformed.appointment.id)).postSummaryStatus,
      AiSummaryStatus.FAILED
    );
    assert.equal(
      (await loadAppointment(missing.appointment.id)).postSummaryStatus,
      AiSummaryStatus.FAILED
    );
  });

  test("no prescription, clinical notes, or follow-up data is lost on AI failure", async () => {
    const { appointment, job } = await createCompletedAppointmentAndJob();
    const before = await loadAppointment(appointment.id);

    await processPostVisitSummaryJob(job.id, {
      provider: new ThrowingPostVisitProvider()
    });

    const afterProcessing = await loadAppointment(appointment.id);
    assert.equal(afterProcessing.clinicalNotes, before.clinicalNotes);
    assert.equal(
      afterProcessing.followUpInstructions,
      before.followUpInstructions
    );
    assert.deepEqual(afterProcessing.prescriptions, before.prescriptions);
  });

  test("safe lastError is recorded without secrets or stack traces in user-facing data", async () => {
    const { appointment, job } = await createCompletedAppointmentAndJob();

    const result = await processPostVisitSummaryJob(job.id, {
      provider: new ThrowingPostVisitProvider()
    });
    const [updatedAppointment, updatedJob] = await Promise.all([
      loadAppointment(appointment.id),
      loadJob(job.id)
    ]);
    const serialized = JSON.stringify({
      result,
      updatedAppointment,
      updatedJob
    });

    assert.equal(
      updatedJob.lastError,
      "LLM provider failed while generating post-visit summary"
    );
    assert.ok(!serialized.includes("secret-token"));
    assert.ok(!serialized.includes("passwordHash"));
    assert.ok(!serialized.includes("LLM_API_KEY"));
    assert.ok(!serialized.includes("provider failed with"));
    assert.ok(!serialized.includes("Error:"));
  });

  test("completed job is not regenerated and does not call provider twice", async () => {
    const { appointment, job } = await createCompletedAppointmentAndJob();
    const provider = new StaticPostVisitProvider(validProviderOutput());

    await processPostVisitSummaryJob(job.id, { provider });
    const afterFirstRun = await loadAppointment(appointment.id);
    const secondResult = await processPostVisitSummaryJob(job.id, {
      provider: new ThrowingPostVisitProvider()
    });
    const afterSecondRun = await loadAppointment(appointment.id);

    assert.equal(provider.callCount, 1);
    assert.equal(secondResult.status, OutboxJobStatus.COMPLETED);
    assert.deepEqual(afterSecondRun.postVisitSummary, afterFirstRun.postVisitSummary);
    assert.equal(afterSecondRun.postSummaryStatus, AiSummaryStatus.COMPLETED);
  });

  test("failed job can retry and success updates summary and job", async () => {
    const { appointment, job } = await createCompletedAppointmentAndJob();

    await processPostVisitSummaryJob(job.id, {
      provider: new ThrowingPostVisitProvider()
    });
    const retryResult = await processPostVisitSummaryJob(job.id, {
      provider: new StaticPostVisitProvider(
        validProviderOutput({ visitSummary: "Retry summary." })
      )
    });

    const [updatedAppointment, updatedJob] = await Promise.all([
      loadAppointment(appointment.id),
      loadJob(job.id)
    ]);
    const summary = storedSummary(updatedAppointment.postVisitSummary);

    assert.equal(retryResult.status, OutboxJobStatus.COMPLETED);
    assert.equal(updatedAppointment.postSummaryStatus, AiSummaryStatus.COMPLETED);
    assert.equal(updatedJob.status, OutboxJobStatus.COMPLETED);
    assert.equal(updatedJob.attempts, 2);
    assert.equal(summary.visitSummary, "Retry summary.");
  });

  test("retry does not duplicate prescriptions", async () => {
    const { appointment, job } = await createCompletedAppointmentAndJob();

    await processPostVisitSummaryJob(job.id, {
      provider: new ThrowingPostVisitProvider()
    });
    await processPostVisitSummaryJob(job.id, {
      provider: new StaticPostVisitProvider(validProviderOutput())
    });

    assert.equal((await loadAppointment(appointment.id)).prescriptions.length, 2);
  });

  test("appointment data incomplete is handled safely", async () => {
    const { appointment, job } = await createCompletedAppointmentAndJob({
      prescriptions: []
    });

    const result = await processPostVisitSummaryJob(job.id, {
      provider: new StaticPostVisitProvider(validProviderOutput())
    });
    const updatedAppointment = await loadAppointment(appointment.id);

    assert.equal(result.status, OutboxJobStatus.FAILED);
    assert.equal(updatedAppointment.status, AppointmentStatus.COMPLETED);
    assert.equal(updatedAppointment.postSummaryStatus, AiSummaryStatus.FAILED);
  });

  test("patient fallback message is available for failed post-visit summaries", () => {
    assert.equal(
      getPostVisitSummaryFallback(AiSummaryStatus.FAILED),
      "AI summary unavailable."
    );
    assert.equal(getPostVisitSummaryFallback(AiSummaryStatus.COMPLETED), null);
  });

  test("mock provider behaves deterministically", async () => {
    const provider = new MockLlmProvider();
    const input = {
      clinicalNotes: "Patient improved.",
      followUpInstructions: "Follow up as needed.",
      prescriptions: expectedMedicationSchedule()
    };

    const first = await provider.generatePostVisitSummary(input);
    const second = await provider.generatePostVisitSummary(input);

    assert.deepEqual(first, second);
  });

  test("prompt includes the core post-visit safety constraints", () => {
    const prompt = buildPostVisitSummaryPrompt({
      clinicalNotes: "Clinical notes.",
      followUpInstructions: "Follow up.",
      prescriptions: expectedMedicationSchedule()
    }).toLowerCase();

    assert.match(prompt, /do not invent a diagnosis/);
    assert.match(prompt, /do not invent medications/);
    assert.match(prompt, /do not invent dosage/);
    assert.match(prompt, /do not invent instructions/);
    assert.match(prompt, /patient-friendly/);
  });
});
