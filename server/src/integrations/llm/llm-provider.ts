import type { PrescriptionFrequency, UrgencyLevel } from "@prisma/client";

export type PreVisitSummary = {
  urgency: UrgencyLevel;
  chiefComplaint: string;
  suggestedQuestions: [string, string, string];
};

export type PreVisitSummaryInput = {
  symptoms: string;
};

export type PostVisitPrescriptionInput = {
  medicine: string;
  dosage: string;
  frequency: PrescriptionFrequency;
  durationDays: number;
  instructions: string | null;
};

export type PostVisitSummary = {
  visitSummary: string;
  medicationSchedule: PostVisitPrescriptionInput[];
  followUpSteps: string[];
};

export type PostVisitSummaryInput = {
  clinicalNotes: string;
  followUpInstructions: string | null;
  prescriptions: PostVisitPrescriptionInput[];
};

export interface LlmProvider {
  generatePreVisitSummary(
    input: PreVisitSummaryInput
  ): Promise<unknown>;

  generatePostVisitSummary(
    input: PostVisitSummaryInput
  ): Promise<unknown>;
}

export class LlmProviderError extends Error {
  constructor(message = "LLM provider failed") {
    super(message);
  }
}
