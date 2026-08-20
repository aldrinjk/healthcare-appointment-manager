export function buildPreVisitSummaryPrompt(symptoms: string) {
  return [
    "Analyze the patient's submitted symptoms for a doctor-facing pre-visit summary.",
    "Return structured data only with urgency, chief complaint, and exactly three suggested questions.",
    "Urgency must be one of LOW, MEDIUM, or HIGH.",
    "Use only information contained in the submitted symptoms.",
    "Do not invent medical history, diagnoses, medications, or certainty.",
    "",
    "Patient symptoms:",
    symptoms
  ].join("\n");
}

type PostVisitPromptPrescription = {
  medicine: string;
  dosage: string;
  frequency: string;
  durationDays: number;
  instructions: string | null;
};

type PostVisitPromptInput = {
  clinicalNotes: string;
  followUpInstructions: string | null;
  prescriptions: PostVisitPromptPrescription[];
};

export function buildPostVisitSummaryPrompt(input: PostVisitPromptInput) {
  return [
    "Create a patient-friendly post-visit summary from doctor-provided information.",
    "Return structured data only with visitSummary and followUpSteps.",
    "Medication schedule is constructed by the application from database prescriptions; do not invent, rewrite, add, remove, or alter medications.",
    "Use only the supplied doctor's notes, follow-up instructions, and prescription information.",
    "Do not invent a diagnosis.",
    "Do not invent medications.",
    "Do not invent dosage.",
    "Do not invent duration.",
    "Do not invent instructions.",
    "Do not add medical advice that was not provided by the doctor.",
    "Use patient-friendly language while preserving medically important meaning.",
    "",
    "Doctor clinical notes:",
    input.clinicalNotes,
    "",
    "Doctor follow-up instructions:",
    input.followUpInstructions ?? "None provided.",
    "",
    "Doctor prescriptions:",
    JSON.stringify(input.prescriptions)
  ].join("\n");
}
