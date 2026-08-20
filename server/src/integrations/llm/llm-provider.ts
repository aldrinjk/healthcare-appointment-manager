import type { UrgencyLevel } from "@prisma/client";

export type PreVisitSummary = {
  urgency: UrgencyLevel;
  chiefComplaint: string;
  suggestedQuestions: [string, string, string];
};

export type PreVisitSummaryInput = {
  symptoms: string;
};

export interface LlmProvider {
  generatePreVisitSummary(
    input: PreVisitSummaryInput
  ): Promise<unknown>;
}

export class LlmProviderError extends Error {
  constructor(message = "LLM provider failed") {
    super(message);
  }
}
