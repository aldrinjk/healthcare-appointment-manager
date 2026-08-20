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
