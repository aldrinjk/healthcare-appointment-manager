import {
  processDueEmailJobs,
  processDueMedicationReminderEmails
} from "../services/outbox-email.service.js";
import { prisma } from "../utils/prisma.js";

async function main() {
  const emailJobs = await processDueEmailJobs();
  const medicationReminders = await processDueMedicationReminderEmails();

  console.log(
    JSON.stringify({
      emailJobsProcessed: emailJobs.length,
      medicationRemindersProcessed: medicationReminders.length
    })
  );
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Email worker failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
