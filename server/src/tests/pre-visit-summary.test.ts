import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import {
  AiSummaryStatus,
  AppointmentStatus,
  OutboxJobStatus,
  UserRole,
  UrgencyLevel
} from "@prisma/client";

process.env.NODE_ENV = "test";

const [
  { buildPreVisitSummaryPrompt },
  { MockLlmProvider },
  { prisma },
  {
    getPreVisitSummaryFallback,
    preVisitSummaryJobType,
    processPreVisitSummaryJob
  }
] = await Promise.all([
  import("../integrations/llm/prompts.js"),
  import("../integrations/llm/mock-llm-provider.js"),
  import("../utils/prisma.js"),
  import("../services/pre-visit-summary.service.js")
]);

const userIds = new Set<string>();
const appointmentIds = new Set<string>();
const jobIds = new Set<string>();

type ProviderOutput = {
  urgency: string;
  chiefComplaint: string;
  suggestedQuestions: string[];
};

class StaticProvider {
  public callCount = 0;

  constructor(private readonly output: unknown) {}

  async generatePreVisitSummary() {
    this.callCount += 1;

    return this.output;
  }
}

class ThrowingProvider {
  public callCount = 0;

  async generatePreVisitSummary() {
    this.callCount += 1;

    throw new Error("provider failed with secret-token passwordHash LLM_API_KEY");
  }
}

function makeEmail(prefix: string) {
  return `${prefix}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2)}@example.com`;
}

function validSummary(overrides: Partial<ProviderOutput> = {}) {
  return {
    urgency: UrgencyLevel.MEDIUM,
    chiefComplaint: "Persistent cough and fever",
    suggestedQuestions: [
      "When did the cough and fever start?",
      "Have the symptoms changed or worsened?",
      "What makes the symptoms better or worse?"
    ],
    ...overrides
  };
}

async function createPatient() {
  const user = await prisma.user.create({
    data: {
      name: "Pre-Visit Test Patient",
      email: makeEmail("previsit.patient"),
      passwordHash: "not-used-in-previsit-tests",
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
      name: "Dr. Pre-Visit Test",
      email: makeEmail("previsit.doctor"),
      passwordHash: "not-used-in-previsit-tests",
      role: UserRole.DOCTOR,
      doctorProfile: {
        create: {
          specialization: "Pre-Visit Testing",
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

async function createAppointmentAndJob(options: {
  symptoms?: string | null;
  status?: AppointmentStatus;
  jobStatus?: OutboxJobStatus;
} = {}) {
  const patient = await createPatient();
  const doctor = await createDoctor();
  const startAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  startAt.setUTCHours(9, 0, 0, 0);
  const endAt = new Date(startAt.getTime() + 30 * 60 * 1000);

  const appointment = await prisma.appointment.create({
    data: {
      patientId: patient.id,
      doctorId: doctor.id,
      startAt,
      endAt,
      status: options.status ?? AppointmentStatus.BOOKED,
      symptoms:
        options.symptoms === undefined
          ? "Persistent cough and fever for two days."
          : options.symptoms,
      preSummaryStatus: AiSummaryStatus.PENDING
    },
    select: {
      id: true,
      symptoms: true
    }
  });
  appointmentIds.add(appointment.id);

  const job = await prisma.outboxJob.create({
    data: {
      type: preVisitSummaryJobType,
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
  const appointment = await prisma.appointment.findUniqueOrThrow({
    where: {
      id
    },
    select: {
      id: true,
      status: true,
      symptoms: true,
      preSummaryStatus: true,
      urgency: true,
      preVisitSummary: true
    }
  });

  return appointment;
}

async function loadJob(id: string) {
  return prisma.outboxJob.findUniqueOrThrow({
    where: {
      id
    },
    select: {
      id: true,
      status: true,
      attempts: true,
      lastError: true
    }
  });
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

describe("pre-visit AI summary processing", () => {
  test("valid symptoms generate and persist a structured summary successfully", async () => {
    const { appointment, job } = await createAppointmentAndJob();
    const provider = new StaticProvider(validSummary());

    const result = await processPreVisitSummaryJob(job.id, { provider });
    const updatedAppointment = await loadAppointment(appointment.id);

    assert.equal(result.status, OutboxJobStatus.COMPLETED);
    assert.equal(provider.callCount, 1);
    assert.equal(updatedAppointment.preSummaryStatus, AiSummaryStatus.COMPLETED);
    assert.deepEqual(updatedAppointment.preVisitSummary, validSummary());
  });

  test("urgency is stored on the appointment", async () => {
    const { appointment, job } = await createAppointmentAndJob();

    await processPreVisitSummaryJob(job.id, {
      provider: new StaticProvider(validSummary({ urgency: UrgencyLevel.HIGH }))
    });

    const updatedAppointment = await loadAppointment(appointment.id);
    assert.equal(updatedAppointment.urgency, UrgencyLevel.HIGH);
  });

  test("chief complaint is stored in the structured summary", async () => {
    const { appointment, job } = await createAppointmentAndJob();

    await processPreVisitSummaryJob(job.id, {
      provider: new StaticProvider(
        validSummary({ chiefComplaint: "Recurring headache" })
      )
    });

    const updatedAppointment = await loadAppointment(appointment.id);
    assert.equal(
      (updatedAppointment.preVisitSummary as ProviderOutput).chiefComplaint,
      "Recurring headache"
    );
  });

  test("exactly three suggested questions are stored", async () => {
    const { appointment, job } = await createAppointmentAndJob();

    await processPreVisitSummaryJob(job.id, {
      provider: new StaticProvider(validSummary())
    });

    const updatedAppointment = await loadAppointment(appointment.id);
    assert.equal(
      (updatedAppointment.preVisitSummary as ProviderOutput).suggestedQuestions
        .length,
      3
    );
  });

  test("original patient symptoms remain unchanged after success", async () => {
    const symptoms = "Sore throat and mild cough since yesterday.";
    const { appointment, job } = await createAppointmentAndJob({ symptoms });

    await processPreVisitSummaryJob(job.id, {
      provider: new StaticProvider(validSummary())
    });

    const updatedAppointment = await loadAppointment(appointment.id);
    assert.equal(updatedAppointment.symptoms, symptoms);
  });

  test("PRE_VISIT_SUMMARY job becomes completed after success", async () => {
    const { job } = await createAppointmentAndJob();

    await processPreVisitSummaryJob(job.id, {
      provider: new StaticProvider(validSummary())
    });

    const updatedJob = await loadJob(job.id);
    assert.equal(updatedJob.status, OutboxJobStatus.COMPLETED);
    assert.equal(updatedJob.attempts, 1);
    assert.equal(updatedJob.lastError, null);
  });

  test("provider failure does not cancel the appointment", async () => {
    const { appointment, job } = await createAppointmentAndJob();

    await processPreVisitSummaryJob(job.id, {
      provider: new ThrowingProvider()
    });

    const updatedAppointment = await loadAppointment(appointment.id);
    assert.equal(updatedAppointment.status, AppointmentStatus.BOOKED);
  });

  test("provider failure sets preSummaryStatus FAILED", async () => {
    const { appointment, job } = await createAppointmentAndJob();

    await processPreVisitSummaryJob(job.id, {
      provider: new ThrowingProvider()
    });

    const updatedAppointment = await loadAppointment(appointment.id);
    assert.equal(updatedAppointment.preSummaryStatus, AiSummaryStatus.FAILED);
  });

  test("provider failure records safe job failure information", async () => {
    const { job } = await createAppointmentAndJob();

    const result = await processPreVisitSummaryJob(job.id, {
      provider: new ThrowingProvider()
    });
    const updatedJob = await loadJob(job.id);
    const serializedResult = JSON.stringify(result);

    assert.equal(updatedJob.status, OutboxJobStatus.FAILED);
    assert.equal(updatedJob.attempts, 1);
    assert.equal(
      updatedJob.lastError,
      "LLM provider failed while generating pre-visit summary"
    );
    assert.ok(!serializedResult.includes("secret-token"));
    assert.ok(!serializedResult.includes("passwordHash"));
    assert.ok(!JSON.stringify(updatedJob).includes("LLM_API_KEY"));
  });

  test("malformed provider response is handled gracefully", async () => {
    const { appointment, job } = await createAppointmentAndJob();

    const result = await processPreVisitSummaryJob(job.id, {
      provider: new StaticProvider({ malformed: true })
    });
    const updatedAppointment = await loadAppointment(appointment.id);

    assert.equal(result.status, OutboxJobStatus.FAILED);
    assert.equal(updatedAppointment.status, AppointmentStatus.BOOKED);
    assert.equal(updatedAppointment.preSummaryStatus, AiSummaryStatus.FAILED);
  });

  test("invalid urgency is rejected", async () => {
    const { appointment, job } = await createAppointmentAndJob();

    await processPreVisitSummaryJob(job.id, {
      provider: new StaticProvider(validSummary({ urgency: "CRITICAL" }))
    });

    const updatedAppointment = await loadAppointment(appointment.id);
    assert.equal(updatedAppointment.preSummaryStatus, AiSummaryStatus.FAILED);
  });

  test("fewer than three suggested questions are rejected", async () => {
    const { appointment, job } = await createAppointmentAndJob();

    await processPreVisitSummaryJob(job.id, {
      provider: new StaticProvider(
        validSummary({ suggestedQuestions: ["Only one question?"] })
      )
    });

    const updatedAppointment = await loadAppointment(appointment.id);
    assert.equal(updatedAppointment.preSummaryStatus, AiSummaryStatus.FAILED);
  });

  test("more than three suggested questions are rejected", async () => {
    const { appointment, job } = await createAppointmentAndJob();

    await processPreVisitSummaryJob(job.id, {
      provider: new StaticProvider(
        validSummary({
          suggestedQuestions: [
            "Question one?",
            "Question two?",
            "Question three?",
            "Question four?"
          ]
        })
      )
    });

    const updatedAppointment = await loadAppointment(appointment.id);
    assert.equal(updatedAppointment.preSummaryStatus, AiSummaryStatus.FAILED);
  });

  test("empty symptoms are handled safely without calling the provider", async () => {
    const { appointment, job } = await createAppointmentAndJob({ symptoms: "   " });
    const provider = new StaticProvider(validSummary());

    const result = await processPreVisitSummaryJob(job.id, { provider });
    const updatedAppointment = await loadAppointment(appointment.id);
    const updatedJob = await loadJob(job.id);

    assert.equal(result.status, OutboxJobStatus.FAILED);
    assert.equal(provider.callCount, 0);
    assert.equal(updatedAppointment.status, AppointmentStatus.BOOKED);
    assert.equal(updatedAppointment.symptoms, "   ");
    assert.equal(updatedAppointment.preSummaryStatus, AiSummaryStatus.FAILED);
    assert.equal(updatedJob.lastError, "Appointment symptoms are required for pre-visit summary");
  });

  test("missing symptoms are handled safely without calling the provider", async () => {
    const { appointment, job } = await createAppointmentAndJob({ symptoms: null });
    const provider = new StaticProvider(validSummary());

    await processPreVisitSummaryJob(job.id, { provider });

    const updatedAppointment = await loadAppointment(appointment.id);
    assert.equal(provider.callCount, 0);
    assert.equal(updatedAppointment.status, AppointmentStatus.BOOKED);
    assert.equal(updatedAppointment.symptoms, null);
    assert.equal(updatedAppointment.preSummaryStatus, AiSummaryStatus.FAILED);
  });

  test("doctor fallback message is available for failed pre-visit summaries", () => {
    assert.equal(
      getPreVisitSummaryFallback(AiSummaryStatus.FAILED),
      "AI summary unavailable. Original patient symptoms remain available."
    );
    assert.equal(getPreVisitSummaryFallback(AiSummaryStatus.COMPLETED), null);
  });

  test("processing an already completed job does not regenerate or overwrite summary", async () => {
    const { appointment, job } = await createAppointmentAndJob();
    const provider = new StaticProvider(validSummary());

    await processPreVisitSummaryJob(job.id, { provider });
    const afterFirstRun = await loadAppointment(appointment.id);
    const secondResult = await processPreVisitSummaryJob(job.id, {
      provider: new ThrowingProvider()
    });
    const afterSecondRun = await loadAppointment(appointment.id);

    assert.equal(provider.callCount, 1);
    assert.equal(secondResult.status, OutboxJobStatus.COMPLETED);
    assert.deepEqual(afterSecondRun.preVisitSummary, afterFirstRun.preVisitSummary);
    assert.equal(afterSecondRun.preSummaryStatus, AiSummaryStatus.COMPLETED);
  });

  test("FAILED jobs are retryable and can later succeed", async () => {
    const { appointment, job } = await createAppointmentAndJob();

    await processPreVisitSummaryJob(job.id, {
      provider: new ThrowingProvider()
    });
    const retryResult = await processPreVisitSummaryJob(job.id, {
      provider: new StaticProvider(validSummary({ urgency: UrgencyLevel.LOW }))
    });

    const updatedAppointment = await loadAppointment(appointment.id);
    const updatedJob = await loadJob(job.id);

    assert.equal(retryResult.status, OutboxJobStatus.COMPLETED);
    assert.equal(updatedAppointment.status, AppointmentStatus.BOOKED);
    assert.equal(updatedAppointment.preSummaryStatus, AiSummaryStatus.COMPLETED);
    assert.equal(updatedAppointment.urgency, UrgencyLevel.LOW);
    assert.equal(updatedJob.status, OutboxJobStatus.COMPLETED);
    assert.equal(updatedJob.attempts, 2);
  });

  test("mock provider behaves deterministically", async () => {
    const provider = new MockLlmProvider();
    const input = { symptoms: "Mild rash on arm." };

    const first = await provider.generatePreVisitSummary(input);
    const second = await provider.generatePreVisitSummary(input);

    assert.deepEqual(first, second);
  });

  test("prompt includes the core assignment constraints", () => {
    const prompt = buildPreVisitSummaryPrompt("Headache and nausea.");
    const normalizedPrompt = prompt.toLowerCase();

    assert.match(normalizedPrompt, /urgency/);
    assert.match(normalizedPrompt, /chief complaint/);
    assert.match(normalizedPrompt, /exactly three/);
    assert.match(normalizedPrompt, /suggestedquestions|suggested questions/);
    assert.match(normalizedPrompt, /do not invent medical history/);
  });
});
