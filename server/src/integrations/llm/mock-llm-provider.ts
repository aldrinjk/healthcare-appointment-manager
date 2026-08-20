import { UrgencyLevel } from "@prisma/client";

import type {
  LlmProvider,
  PreVisitSummaryInput
} from "./llm-provider.js";

function inferUrgency(symptoms: string) {
  const normalizedSymptoms = symptoms.toLowerCase();

  if (
    /\b(chest pain|difficulty breathing|trouble breathing|severe bleeding|fainting|stroke|suicidal)\b/.test(
      normalizedSymptoms
    )
  ) {
    return UrgencyLevel.HIGH;
  }

  if (
    /\b(fever|persistent|vomiting|dizziness|infection|pain|worsening)\b/.test(
      normalizedSymptoms
    )
  ) {
    return UrgencyLevel.MEDIUM;
  }

  return UrgencyLevel.LOW;
}

function chiefComplaintFromSymptoms(symptoms: string) {
  const firstSentence = symptoms
    .split(/[.!?]/)
    .map((part) => part.trim())
    .find(Boolean);

  return (firstSentence ?? symptoms.trim()).slice(0, 240);
}

export class MockLlmProvider implements LlmProvider {
  async generatePreVisitSummary(input: PreVisitSummaryInput) {
    return {
      urgency: inferUrgency(input.symptoms),
      chiefComplaint: chiefComplaintFromSymptoms(input.symptoms),
      suggestedQuestions: [
        "When did these symptoms start?",
        "Have the symptoms changed or worsened since they began?",
        "What makes the symptoms better or worse?"
      ]
    };
  }
}
