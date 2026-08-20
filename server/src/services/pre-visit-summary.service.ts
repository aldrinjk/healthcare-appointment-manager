import {
  AiSummaryStatus,
  OutboxJobStatus,
  Prisma,
  UrgencyLevel
} from "@prisma/client";
import { z } from "zod";

import type {
  LlmProvider,
  PreVisitSummary
} from "../integrations/llm/llm-provider.js";
import { createLlmProvider } from "../integrations/llm/provider-factory.js";
import { AppError } from "../middleware/app-error.js";
import { prisma } from "../utils/prisma.js";

export const preVisitSummaryJobType = "PRE_VISIT_SUMMARY";
export const preVisitSummaryRetryDelayMs = 5 * 60 * 1000;

const preVisitSummarySchema = z
  .object({
    urgency: z.nativeEnum(UrgencyLevel),
    chiefComplaint: z.string().trim().min(1).max(500),
    suggestedQuestions: z
      .tuple([
        z.string().trim().min(1).max(300),
        z.string().trim().min(1).max(300),
        z.string().trim().min(1).max(300)
      ])
  })
  .strict();

const outboxPayloadSchema = z
  .object({
    appointmentId: z.string().min(1)
  })
  .passthrough();

type ProcessPreVisitSummaryOptions = {
  provider?: LlmProvider;
  now?: Date;
};

type ClaimedPreVisitSummaryJob =
  | {
      kind: "ready";
      jobId: string;
      appointmentId: string;
      symptoms: string;
    }
  | {
      kind: "completed";
      jobId: string;
      appointmentId: string;
      summary: PreVisitSummary | null;
    }
  | {
      kind: "failed";
      jobId: string;
      appointmentId?: string;
      error: string;
    };

export type ProcessPreVisitSummaryResult = {
  jobId: string;
  appointmentId?: string;
  status: OutboxJobStatus;
  summary?: PreVisitSummary | null;
  error?: string;
};

function sanitizeLlmFailure(error: unknown) {
  if (error instanceof z.ZodError) {
    return "LLM provider returned invalid pre-visit summary";
  }

  if (error instanceof Error) {
    return "LLM provider failed while generating pre-visit summary";
  }

  return "LLM provider failed while generating pre-visit summary";
}

function sanitizeJobFailure(message: string) {
  return message.slice(0, 300);
}

function toPreVisitSummary(value: unknown) {
  return preVisitSummarySchema.parse(value);
}

function fromStoredSummary(value: Prisma.JsonValue | null): PreVisitSummary | null {
  if (value === null) {
    return null;
  }

  const parsed = preVisitSummarySchema.safeParse(value);

  return parsed.success ? parsed.data : null;
}

function nextRetryAt(now: Date) {
  return new Date(now.getTime() + preVisitSummaryRetryDelayMs);
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
        preSummaryStatus: AiSummaryStatus.FAILED
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

async function claimPreVisitSummaryJob(
  jobId: string,
  now: Date
): Promise<ClaimedPreVisitSummaryJob> {
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

    if (job.type !== preVisitSummaryJobType) {
      throw new AppError(
        "Outbox job is not a pre-visit summary job",
        400,
        "INVALID_OUTBOX_JOB_TYPE"
      );
    }

    const payload = outboxPayloadSchema.safeParse(job.payload);

    if (!payload.success) {
      await failJob(
        tx,
        job.id,
        "PRE_VISIT_SUMMARY job payload is invalid",
        now
      );

      return {
        kind: "failed",
        jobId: job.id,
        error: "PRE_VISIT_SUMMARY job payload is invalid"
      };
    }

    const appointment = await tx.appointment.findUnique({
      where: {
        id: payload.data.appointmentId
      },
      select: {
        id: true,
        symptoms: true,
        preSummaryStatus: true,
        preVisitSummary: true
      }
    });

    if (!appointment) {
      await failJob(
        tx,
        job.id,
        "Appointment for PRE_VISIT_SUMMARY job was not found",
        now
      );

      return {
        kind: "failed",
        jobId: job.id,
        appointmentId: payload.data.appointmentId,
        error: "Appointment for PRE_VISIT_SUMMARY job was not found"
      };
    }

    if (
      job.status === OutboxJobStatus.COMPLETED ||
      (appointment.preSummaryStatus === AiSummaryStatus.COMPLETED &&
        appointment.preVisitSummary !== null)
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
        summary: fromStoredSummary(appointment.preVisitSummary)
      };
    }

    if (job.status === OutboxJobStatus.PROCESSING) {
      throw new AppError(
        "Pre-visit summary job is already processing",
        409,
        "OUTBOX_JOB_PROCESSING"
      );
    }

    if (!appointment.symptoms?.trim()) {
      await failJob(
        tx,
        job.id,
        "Appointment symptoms are required for pre-visit summary",
        now,
        appointment.id
      );

      return {
        kind: "failed",
        jobId: job.id,
        appointmentId: appointment.id,
        error: "Appointment symptoms are required for pre-visit summary"
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
        "Pre-visit summary job is already processing",
        409,
        "OUTBOX_JOB_PROCESSING"
      );
    }

    await tx.appointment.update({
      where: {
        id: appointment.id
      },
      data: {
        preSummaryStatus: AiSummaryStatus.PENDING
      }
    });

    return {
      kind: "ready",
      jobId: job.id,
      appointmentId: appointment.id,
      symptoms: appointment.symptoms
    };
  });
}

export async function processPreVisitSummaryJob(
  jobId: string,
  options: ProcessPreVisitSummaryOptions = {}
): Promise<ProcessPreVisitSummaryResult> {
  const now = options.now ?? new Date();
  const provider = options.provider ?? createLlmProvider();
  const claimedJob = await claimPreVisitSummaryJob(jobId, now);

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
    const providerOutput = await provider.generatePreVisitSummary({
      symptoms: claimedJob.symptoms
    });
    const summary = toPreVisitSummary(providerOutput);

    await prisma.$transaction(async (tx) => {
      await tx.appointment.update({
        where: {
          id: claimedJob.appointmentId
        },
        data: {
          urgency: summary.urgency,
          preVisitSummary: summary,
          preSummaryStatus: AiSummaryStatus.COMPLETED
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
    const safeError = sanitizeLlmFailure(error);

    await prisma.$transaction(async (tx) => {
      await tx.appointment.update({
        where: {
          id: claimedJob.appointmentId
        },
        data: {
          preSummaryStatus: AiSummaryStatus.FAILED
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

export async function processPendingPreVisitSummaryJobs(
  limit = 10,
  options: ProcessPreVisitSummaryOptions = {}
) {
  const now = options.now ?? new Date();
  const jobs = await prisma.outboxJob.findMany({
    where: {
      type: preVisitSummaryJobType,
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

  const results: ProcessPreVisitSummaryResult[] = [];

  for (const job of jobs) {
    results.push(
      await processPreVisitSummaryJob(job.id, {
        ...options,
        now
      })
    );
  }

  return results;
}

export function getPreVisitSummaryFallback(preSummaryStatus: AiSummaryStatus) {
  if (preSummaryStatus === AiSummaryStatus.FAILED) {
    return "AI summary unavailable. Original patient symptoms remain available.";
  }

  return null;
}
