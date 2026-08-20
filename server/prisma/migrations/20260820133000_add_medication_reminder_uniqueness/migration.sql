DROP INDEX IF EXISTS "MedicationReminder_prescriptionId_scheduledAt_idx";

CREATE UNIQUE INDEX "MedicationReminder_prescriptionId_scheduledAt_key" ON "MedicationReminder"("prescriptionId", "scheduledAt");
