import {
  AiSummaryStatus,
  AppointmentStatus,
  OutboxJobStatus,
  PrescriptionFrequency,
  Prisma
} from "@prisma/client";
import { z } from "zod";

import type {
  LlmProvider,
  PostVisitSummary
} from "../integrations/llm/llm-provider.js";
import { createLlmProvider } from "../integrations/llm/provider-factory.js";
import { AppError } from "../middleware/app-error.js";
import { prisma } from "../utils/prisma.js";

export const postVisitSummaryJobType = "POST_VISIT_SUMMARY";
export const postVisitSummaryRetryDelayMs = 5 * 60 * 1000;

const providerPostVisitSummarySchema = z
  .object({
    visitSummary: z.string().trim().min(1).max(2_000),
    followUpSteps: z.array(z.string().trim().min(1).max(500)).min(1).max(10)
  })
  .passthrough();

const storedPostVisitSummarySchema = z
  .object({
    visitSummary: z.string().trim().min(1).max(2_000),
    medicationSchedule: z.array(
      z
        .object({
          medicine: z.string().trim().min(1),
          dosage: z.string().trim().min(1),
          frequency: z.nativeEnum(PrescriptionFrequency),
          durationDays: z.number().int().positive(),
          instructions: z.string().nullable()
        })
        .strict()
    ),
    followUpSteps: z.array(z.string().trim().min(1).max(500)).min(1).max(10)
  })
  .strict();

const outboxPayloadSchema = z
  .object({
    appointmentId: z.string().min(1)
  })
  .passthrough();

type ProcessPostVisitSummaryOptions = {
  provider?: Pick<LlmProvider, "generatePostVisitSummary">;
  now?: Date;
};

type AppointmentPrescription = {
  medicineName: string;
  dosage: string;
  frequency: PrescriptionFrequency;
  durationDays: number;
  instructions: string | null;
};

type ClaimedPostVisitSummaryJob =
  | {
      kind: "ready";
      jobId: string;
      appointmentId: string;
      clinicalNotes: string;
      followUpInstructions: string | null;
      prescriptions: AppointmentPrescription[];
    }
  | {
      kind: "completed";
      jobId: string;
      appointmentId: string;
      summary: PostVisitSummary | null;
    }
  | {
      kind: "failed";
      jobId: string;
      appointmentId?: string;
      error: string;
    };

export type ProcessPostVisitSummaryResult = {
  jobId: string;
  appointmentId?: string;
  status: OutboxJobStatus;
  summary?: PostVisitSummary | null;
  error?: string;
};

function sanitizePostVisitFailure(error: unknown) {
  if (error instanceof z.ZodError) {
    return "LLM provider returned invalid post-visit summary";
  }

  return "LLM provider failed while generating post-visit summary";
}

function sanitizeJobFailure(message: string) {
  return message.slice(0, 300);
}

function nextRetryAt(now: Date) {
  return new Date(now.getTime() + postVisitSummaryRetryDelayMs);
}

function toMedicationSchedule(prescriptions: AppointmentPrescription[]) {
  return prescriptions.map((prescription) => ({
    medicine: prescription.medicineName,
    dosage: prescription.dosage,
    frequency: prescription.frequency,
    durationDays: prescription.durationDays,
    instructions: prescription.instructions
  }));
}

function toProviderPrescription(prescription: AppointmentPrescription) {
  return {
    medicine: prescription.medicineName,
    dosage: prescription.dosage,
    frequency: prescription.frequency,
    durationDays: prescription.durationDays,
    instructions: prescription.instructions
  };
}

function fromStoredSummary(value: Prisma.JsonValue | null): PostVisitSummary | null {
  if (value === null) {
    return null;
  }

  const parsed = storedPostVisitSummarySchema.safeParse(value);

  return parsed.success ? (parsed.data as PostVisitSummary) : null;
}

async function failJob(
  tx: Prisma.TransactionClient,
  jobId: string,
  error: string,
  now: Date,
  appointmentId?: string
) {
  if (appointmentId) {
    await tx.appointment.update({
      where: {
        id: appointmentId
      },
      data: {
        postSummaryStatus: AiSummaryStatus.FAILED
      }
    });
  }

  await tx.outboxJob.update({
    where: {
      id: jobId
    },
    data: {
      status: OutboxJobStatus.FAILED,
      attempts: {
        increment: 1
      },
      nextAttemptAt: nextRetryAt(now),
      lastError: sanitizeJobFailure(error)
    }
  });
}

async function claimPostVisitSummaryJob(
  jobId: string,
  now: Date
): Promise<ClaimedPostVisitSummaryJob> {
  return prisma.$transaction(async (tx) => {
    const job = await tx.outboxJob.findUnique({
      where: {
        id: jobId
      },
      select: {
        id: true,
        type: true,
        payload: true,
        status: true
      }
    });

    if (!job) {
      throw new AppError("Outbox job not found", 404, "OUTBOX_JOB_NOT_FOUND");
    }

    if (job.type !== postVisitSummaryJobType) {
      throw new AppError(
        "Outbox job is not a post-visit summary job",
        400,
        "INVALID_OUTBOX_JOB_TYPE"
      );
    }

    const payload = outboxPayloadSchema.safeParse(job.payload);

    if (!payload.success) {
      await failJob(
        tx,
        job.id,
        "POST_VISIT_SUMMARY job payload is invalid",
        now
      );

      return {
        kind: "failed",
        jobId: job.id,
        error: "POST_VISIT_SUMMARY job payload is invalid"
      };
    }

    const appointment = await tx.appointment.findUnique({
      where: {
        id: payload.data.appointmentId
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

    if (!appointment) {
      await failJob(
        tx,
        job.id,
        "Appointment for POST_VISIT_SUMMARY job was not found",
        now
      );

      return {
        kind: "failed",
        jobId: job.id,
        appointmentId: payload.data.appointmentId,
        error: "Appointment for POST_VISIT_SUMMARY job was not found"
      };
    }

    if (
      job.status === OutboxJobStatus.COMPLETED ||
      (appointment.postSummaryStatus === AiSummaryStatus.COMPLETED &&
        appointment.postVisitSummary !== null)
    ) {
      await tx.outboxJob.update({
        where: {
          id: job.id
        },
        data: {
          status: OutboxJobStatus.COMPLETED,
          lastError: null
        }
      });

      return {
        kind: "completed",
        jobId: job.id,
        appointmentId: appointment.id,
        summary: fromStoredSummary(appointment.postVisitSummary)
      };
    }

    if (job.status === OutboxJobStatus.PROCESSING) {
      throw new AppError(
        "Post-visit summary job is already processing",
        409,
        "OUTBOX_JOB_PROCESSING"
      );
    }

    if (appointment.status !== AppointmentStatus.COMPLETED) {
      await failJob(
        tx,
        job.id,
        "Appointment must be completed before post-visit summary generation",
        now,
        appointment.id
      );

      return {
        kind: "failed",
        jobId: job.id,
        appointmentId: appointment.id,
        error: "Appointment must be completed before post-visit summary generation"
      };
    }

    if (!appointment.clinicalNotes?.trim()) {
      await failJob(
        tx,
        job.id,
        "Clinical notes are required for post-visit summary",
        now,
        appointment.id
      );

      return {
        kind: "failed",
        jobId: job.id,
        appointmentId: appointment.id,
        error: "Clinical notes are required for post-visit summary"
      };
    }

    if (appointment.prescriptions.length === 0) {
      await failJob(
        tx,
        job.id,
        "Prescription data is required for post-visit summary",
        now,
        appointment.id
      );

      return {
        kind: "failed",
        jobId: job.id,
        appointmentId: appointment.id,
        error: "Prescription data is required for post-visit summary"
      };
    }

    const claim = await tx.outboxJob.updateMany({
      where: {
        id: job.id,
        status: {
          in: [OutboxJobStatus.PENDING, OutboxJobStatus.FAILED]
        }
      },
      data: {
        status: OutboxJobStatus.PROCESSING,
        attempts: {
          increment: 1
        },
        lastError: null
      }
    });

    if (claim.count !== 1) {
      throw new AppError(
        "Post-visit summary job is already processing",
        409,
        "OUTBOX_JOB_PROCESSING"
      );
    }

    await tx.appointment.update({
      where: {
        id: appointment.id
      },
      data: {
        postSummaryStatus: AiSummaryStatus.PENDING
      }
    });

    return {
      kind: "ready",
      jobId: job.id,
      appointmentId: appointment.id,
      clinicalNotes: appointment.clinicalNotes,
      followUpInstructions: appointment.followUpInstructions,
      prescriptions: appointment.prescriptions
    };
  });
}

export async function processPostVisitSummaryJob(
  jobId: string,
  options: ProcessPostVisitSummaryOptions = {}
): Promise<ProcessPostVisitSummaryResult> {
  const now = options.now ?? new Date();
  const provider = options.provider ?? createLlmProvider();
  const claimedJob = await claimPostVisitSummaryJob(jobId, now);

  if (claimedJob.kind === "completed") {
    return {
      jobId: claimedJob.jobId,
      appointmentId: claimedJob.appointmentId,
      status: OutboxJobStatus.COMPLETED,
      summary: claimedJob.summary
    };
  }

  if (claimedJob.kind === "failed") {
    return {
      jobId: claimedJob.jobId,
      appointmentId: claimedJob.appointmentId,
      status: OutboxJobStatus.FAILED,
      error: claimedJob.error
    };
  }

  try {
    const providerOutput = await provider.generatePostVisitSummary({
      clinicalNotes: claimedJob.clinicalNotes,
      followUpInstructions: claimedJob.followUpInstructions,
      prescriptions: claimedJob.prescriptions.map(toProviderPrescription)
    });
    const providerSummary = providerPostVisitSummarySchema.parse(providerOutput);
    const summary = storedPostVisitSummarySchema.parse({
      visitSummary: providerSummary.visitSummary,
      medicationSchedule: toMedicationSchedule(claimedJob.prescriptions),
      followUpSteps: providerSummary.followUpSteps
    }) as PostVisitSummary;

    await prisma.$transaction(async (tx) => {
      await tx.appointment.update({
        where: {
          id: claimedJob.appointmentId
        },
        data: {
          postVisitSummary: summary,
          postSummaryStatus: AiSummaryStatus.COMPLETED
        }
      });

      await tx.outboxJob.update({
        where: {
          id: claimedJob.jobId
        },
        data: {
          status: OutboxJobStatus.COMPLETED,
          nextAttemptAt: now,
          lastError: null
        }
      });
    });

    return {
      jobId: claimedJob.jobId,
      appointmentId: claimedJob.appointmentId,
      status: OutboxJobStatus.COMPLETED,
      summary
    };
  } catch (error) {
    const safeError = sanitizePostVisitFailure(error);

    await prisma.$transaction(async (tx) => {
      await tx.appointment.update({
        where: {
          id: claimedJob.appointmentId
        },
        data: {
          postSummaryStatus: AiSummaryStatus.FAILED
        }
      });

      await tx.outboxJob.update({
        where: {
          id: claimedJob.jobId
        },
        data: {
          status: OutboxJobStatus.FAILED,
          nextAttemptAt: nextRetryAt(now),
          lastError: safeError
        }
      });
    });

    return {
      jobId: claimedJob.jobId,
      appointmentId: claimedJob.appointmentId,
      status: OutboxJobStatus.FAILED,
      error: safeError
    };
  }
}

export async function processPendingPostVisitSummaryJobs(
  limit = 10,
  options: ProcessPostVisitSummaryOptions = {}
) {
  const now = options.now ?? new Date();
  const jobs = await prisma.outboxJob.findMany({
    where: {
      type: postVisitSummaryJobType,
      status: OutboxJobStatus.PENDING,
      nextAttemptAt: {
        lte: now
      }
    },
    orderBy: {
      createdAt: "asc"
    },
    take: limit,
    select: {
      id: true
    }
  });

  const results: ProcessPostVisitSummaryResult[] = [];

  for (const job of jobs) {
    results.push(
      await processPostVisitSummaryJob(job.id, {
        ...options,
        now
      })
    );
  }

  return results;
}

export function getPostVisitSummaryFallback(postSummaryStatus: AiSummaryStatus) {
  if (postSummaryStatus === AiSummaryStatus.FAILED) {
    return "AI summary unavailable.";
  }

  return null;
}
