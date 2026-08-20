# Implementation Status

## Current Milestone

Milestone 14 - Email Notifications is next. Milestone 13 is complete.

## Completed

* Milestone 1 - Foundation.
* Milestone 2 - Database Schema.
* Milestone 3 - Authentication and RBAC.
* Milestone 4 - Doctor Administration.
* Milestone 5 - Doctor Search and Slot Generation.
* Milestone 6 - Slot Hold.
* Milestone 7 - Appointment Booking.
* Milestone 8 - Appointment Views, Cancellation and Rescheduling.
* Milestone 9 - Doctor Leave Conflict Handling.
* Milestone 10 - Pre-Visit AI Summary.
* Milestone 11 - Doctor Visit Completion.
* Milestone 12 - Post-Visit AI Summary.
* Milestone 13 - Medication Reminders.
* Extended admin-only `POST /api/admin/doctors/:id/leave` to handle existing booked appointments on the leave date.
* Leave creation now uses a PostgreSQL serializable Prisma transaction with bounded retry for serialization conflicts.
* Leave creation validates the doctor/date, prevents duplicate leave entries, creates the leave, cancels affected `BOOKED` appointments, releases linked `BOOKED` reservations as `RELEASED`, and creates durable outbox jobs atomically.
* Leave handling does not cancel already `CANCELLED` or `COMPLETED` appointments.
* Leave cancellation outbox jobs are `DOCTOR_LEAVE_CANCELLATION_PATIENT`, `DOCTOR_LEAVE_CANCELLATION_DOCTOR`, and `CALENDAR_DELETE`.
* Duplicate leave creation returns `409` and creates no duplicate cancellation jobs.
* Existing `DELETE /api/admin/doctors/:id/leave/:leaveId` still deletes only the leave record and does not restore cancelled appointments or reservations.
* Appointment booking confirmation now runs under serializable isolation with bounded retry, so booking-vs-leave races cannot leave both a leave record and an active booked appointment for the same doctor/date.
* Added a clean LLM abstraction under `server/src/integrations/llm`.
* Added a deterministic mock LLM provider for local development and automated tests.
* Added an OpenAI provider adapter using configurable `LLM_PROVIDER`, `LLM_MODEL`, and local-only `LLM_API_KEY` values.
* Added a reusable pre-visit prompt module with the assignment constraints: urgency, chief complaint, exactly three suggested questions, and no invented medical history/diagnoses.
* Added `processPreVisitSummaryJob` for direct/future-worker processing of `PRE_VISIT_SUMMARY` outbox jobs.
* Pre-visit summary processing validates provider output before saving.
* Successful pre-visit summary processing preserves original symptoms, stores structured JSON in `Appointment.preVisitSummary`, stores `Appointment.urgency`, sets `preSummaryStatus` to `COMPLETED`, and marks the outbox job `COMPLETED`.
* Provider failures, malformed output, invalid urgency, wrong question counts, and missing symptoms leave the appointment `BOOKED`, preserve symptoms, set `preSummaryStatus` to `FAILED`, and record a safe outbox failure.
* Completed `PRE_VISIT_SUMMARY` jobs are idempotent and do not regenerate or overwrite an existing summary.
* Failed `PRE_VISIT_SUMMARY` jobs are retryable and can later complete successfully.
* Tightened the doctor-leave rollback test to count outbox jobs scoped to the appointment under test, avoiding cross-file interference from legitimate Milestone 10 `PRE_VISIT_SUMMARY` jobs.
* Existing patient cancellation/rescheduling transaction tests were tightened to assert outbox rollback per appointment, avoiding unrelated concurrent test-suite outbox rows.
* Added `Appointment.followUpInstructions` through migration `20260820110000_add_follow_up_instructions`.
* Added doctor-only appointment routes under `/api/doctor/appointments`.
* Doctor appointment list/detail returns only appointments assigned to the authenticated doctor's profile.
* Doctor appointment responses include safe patient identity, appointment time/status, symptoms, urgency, pre-visit summary data/status, fallback text when pre-summary failed, clinical notes, follow-up instructions, post-summary status, and prescriptions where present.
* Added transactional doctor visit completion at `POST /api/doctor/appointments/:id/complete`.
* Visit completion verifies the assigned doctor owns the appointment, requires `BOOKED`, rejects `CANCELLED` and already `COMPLETED` appointments, stores clinical notes/follow-up instructions, creates prescription records, marks the appointment `COMPLETED`, sets `postSummaryStatus` to `PENDING`, and creates exactly one `POST_VISIT_SUMMARY` outbox job atomically.
* Completion still performs no post-visit LLM call inside the doctor request; the durable `POST_VISIT_SUMMARY` job is processed by the Milestone 12 job handler.
* Completion runs under PostgreSQL serializable isolation with guarded appointment status updates so simultaneous completion attempts produce exactly one completed visit, one prescription set, and one post-visit job.
* Tightened patient rescheduling concurrency: after a reschedule outbox job set exists, competing different-hold reschedules return `409`, while repeating the already-booked reservation remains idempotent. This prevents duplicate reschedule job sets under races.
* Server test files now run with `--test-concurrency=1` to keep database-backed integration tests deterministic against the shared Neon database; explicit in-test race scenarios still use simultaneous requests.
* Extended the shared LLM abstraction, mock provider, OpenAI provider adapter, and prompt module for post-visit summaries.
* Added `processPostVisitSummaryJob` and `processPendingPostVisitSummaryJobs` for direct/future-worker processing of `POST_VISIT_SUMMARY` outbox jobs.
* The post-visit prompt instructs the provider to use only doctor clinical notes, follow-up instructions, and prescriptions; not invent diagnosis, medications, dosage, duration, instructions, or extra medical advice; preserve medically important meaning; use patient-friendly language; and return structured data only.
* Post-visit provider output is validated before saving.
* The final stored `postVisitSummary` structure contains `visitSummary`, `medicationSchedule`, and `followUpSteps`.
* Medication safety uses the safer authoritative approach: the LLM does not provide the saved medication schedule. The saved `medicationSchedule` is constructed directly from persisted `Prescription` rows, so invented or altered AI medication data cannot change doctor-entered medication truth.
* Successful post-visit processing preserves appointment status `COMPLETED`, clinical notes, follow-up instructions, and prescription rows; stores structured JSON in `Appointment.postVisitSummary`; sets `postSummaryStatus` to `COMPLETED`; and marks the job `COMPLETED`.
* Provider failures, malformed output, missing required fields, incomplete appointment data, and unsafe AI output leave the appointment `COMPLETED`, preserve doctor-entered data, set `postSummaryStatus` to `FAILED`, and store a safe retryable job failure.
* Completed `POST_VISIT_SUMMARY` jobs are idempotent and do not call the provider or overwrite an existing valid summary.
* Failed `POST_VISIT_SUMMARY` jobs are retryable and can later complete successfully without duplicating prescriptions.
* Patient and doctor appointment response shaping now includes `postVisitSummaryFallback`, which returns `AI summary unavailable.` when `postSummaryStatus` is `FAILED`.
* Added migration `20260820133000_add_medication_reminder_uniqueness`.
* Added a database-level unique constraint on `MedicationReminder(prescriptionId, scheduledAt)` to prevent duplicate reminders for the same prescription and dose time.
* Added a dedicated medication reminder scheduling service with a centralized UTC frequency map:
  * `ONCE_DAILY` - `09:00` UTC.
  * `TWICE_DAILY` - `09:00` and `21:00` UTC.
  * `THREE_TIMES_DAILY` - `09:00`, `15:00`, and `21:00` UTC.
  * `AS_NEEDED` - no automatic scheduled reminders.
* Reminder scheduling uses the UTC calendar date of visit completion, skips first-day reminder times before the completion timestamp, retains a dose exactly at the completion timestamp, and never schedules beyond `durationDays`.
* Doctor visit completion now creates prescription rows, medication reminder rows, and the `POST_VISIT_SUMMARY` outbox job inside the same PostgreSQL serializable transaction.
* Reminder scheduling failures during visit completion roll back the whole completion transaction, leaving the appointment `BOOKED`, no prescriptions, no reminders, and no post-summary job.
* Reminder scheduling creates `MedicationReminder` records only. Reminder email outbox jobs and delivery remain Milestone 14 work.
* Added `findDueMedicationReminders` for future worker use. It returns only `PENDING` reminders with `scheduledAt <= now`, ordered by scheduled time, and selects safe reminder/prescription/appointment identifiers without password hashes or secrets.

## In Progress

None.

## Tests Passing

Milestone 13 verification completed on 2026-08-20:

* `npx.cmd prisma migrate dev` - applied `20260820133000_add_medication_reminder_uniqueness` successfully against the configured Neon PostgreSQL database.
* `npx.cmd prisma migrate status` - passed; database schema is up to date.
* `npm.cmd run prisma:validate` - passed.
* `npm.cmd run prisma:generate` - passed.
* `node --import tsx --test --test-concurrency=1 "src/tests/medication-reminder.test.ts"` - passed with 32 tests, 0 failures.
  * `ONCE_DAILY`, `TWICE_DAILY`, and `THREE_TIMES_DAILY` create the correct reminder counts.
  * `AS_NEEDED` creates zero scheduled reminders.
  * `durationDays` is respected and no reminder falls outside the prescription duration.
  * Centralized UTC schedule tests passed for `09:00`, `15:00`, and `21:00` mappings.
  * First-day past reminder times are skipped, future first-day doses are retained, and an exact completion-time dose is retained.
  * Reminder rows reference the correct prescription.
  * Visit completion creates reminders atomically with prescriptions.
  * Multiple prescriptions create independent reminder schedules.
  * `AS_NEEDED` prescriptions create no reminders during completion.
  * Appointment completion, prescription persistence, reminder persistence, and exactly one `POST_VISIT_SUMMARY` job all passed together.
  * Rollback test passed: simulated reminder-generation failure left appointment `BOOKED`, no clinical notes/follow-up instructions, no prescriptions, no reminders, and no post-summary job.
  * Idempotency tests passed: scheduling the same prescription twice did not duplicate reminders, and repeated completion did not duplicate prescriptions or reminders.
  * Database unique protection test passed with Prisma `P2002` on duplicate `(prescriptionId, scheduledAt)`.
  * Due-reminder query returned only `PENDING` reminders with `scheduledAt <= now`, excluded future reminders, excluded `SENT` and `FAILED`, respected limit, and ordered predictably.
  * Reminder query/security tests passed: no `passwordHash`, secrets, API keys, database URLs, or development passwords were exposed in reminder results.
* `node --import tsx --test --test-concurrency=1 "src/tests/doctor-visit-completion.test.ts"` - passed with 27 tests, 0 failures after reminder scheduling was added to the completion transaction.
* `node --import tsx --test --test-concurrency=1 "src/tests/post-visit-summary.test.ts"` - passed with 22 tests, 0 failures.
  * Valid completed appointment generated and stored a structured post-visit summary.
  * `visitSummary`, authoritative `medicationSchedule`, and `followUpSteps` persisted.
  * `postSummaryStatus` became `COMPLETED` and the `POST_VISIT_SUMMARY` job became `COMPLETED`.
  * Appointment status remained `COMPLETED`.
  * Clinical notes, follow-up instructions, and prescription rows remained unchanged.
  * Medication authority tests passed: provider-invented medication data was ignored, and saved dosage/frequency/duration/instructions matched persisted doctor prescriptions exactly.
  * Provider failure left the appointment `COMPLETED`, set `postSummaryStatus` to `FAILED`, marked the job `FAILED`, preserved doctor-entered data, and stored a safe `lastError`.
  * Malformed provider output and missing required fields failed safely.
  * Completed-job idempotency passed: no second provider call and no summary overwrite.
  * Failed-job retry passed: retry success updated summary and job status without duplicating prescriptions.
  * Incomplete appointment data failed safely.
  * Fallback helper returned `AI summary unavailable.` for failed post-summary status.
  * Deterministic mock provider test passed.
  * Post-visit prompt safety constraints test passed.
* `npm.cmd run test:server` - passed with 234 tests, 0 failures.
  * 32 medication reminder tests passed.
  * 22 post-visit AI summary tests passed.
  * 27 doctor appointment view / visit completion tests passed.
  * Unauthenticated doctor appointment list returned `401`.
  * Patient/admin access to doctor endpoints returned `403`.
  * Doctor list returned only the authenticated doctor's appointments.
  * Assigned appointment detail returned safe patient identity, symptoms, pre-visit summary data, and failed-summary fallback.
  * Another doctor could not access or complete an appointment they do not own.
  * Assigned doctor completed a `BOOKED` appointment successfully.
  * Clinical notes and follow-up instructions persisted.
  * One and multiple prescription creation both persisted correctly.
  * Completion set appointment status to `COMPLETED`.
  * Completion set `postSummaryStatus` to `PENDING`.
  * Exactly one `POST_VISIT_SUMMARY` job was created with `PENDING` status and `attempts = 0`.
  * `CANCELLED` and already `COMPLETED` appointments could not be completed.
  * Missing clinical notes, invalid prescription data, invalid medication frequency, and non-positive duration returned validation errors.
  * Completion responses exposed no `passwordHash`, auth fields, or secrets.
  * Rollback test passed: simulated in-transaction failure left appointment `BOOKED`, no clinical notes/follow-up instructions, no prescriptions, and no post-visit job.
  * Simultaneous completion race passed: 10 concurrent completion requests produced exactly 1 success, 9 conflicts, one completed appointment, one prescription set, and one `POST_VISIT_SUMMARY` job.
  * Reschedule race test still passed after tightening the service to prevent duplicate reschedule job sets.
  * 20 pre-visit AI summary tests passed.
  * Valid symptoms generate and persist a structured pre-visit summary.
  * Urgency, chief complaint, and exactly three suggested questions are stored.
  * Original patient symptoms remain unchanged after success.
  * Successful processing sets `preSummaryStatus` to `COMPLETED` and marks the `PRE_VISIT_SUMMARY` job `COMPLETED`.
  * Provider failure leaves the appointment `BOOKED`, sets `preSummaryStatus` to `FAILED`, and records safe job failure information.
  * Malformed provider output, invalid urgency, fewer than three questions, and more than three questions are rejected safely.
  * Empty or missing symptoms fail safely without calling the provider.
  * Failed-summary fallback text is available for later doctor UI/API use.
  * Completed job idempotency test passed: a completed job did not regenerate or overwrite the stored summary.
  * Retry test passed: a failed job later completed successfully without corrupting the appointment.
  * Deterministic mock provider test passed.
  * Prompt constraint test passed.
  * 19 doctor leave conflict tests passed.
  * Leave with no appointments creates a leave record.
  * Leave with one or multiple `BOOKED` appointments cancels all affected booked appointments and releases linked booked reservations.
  * Already `CANCELLED` and `COMPLETED` appointments remain unchanged.
  * Duplicate leave returns `409` and creates no duplicate outbox jobs.
  * Deleting leave does not restore cancelled appointments or released reservations.
  * Booking after existing leave fails cleanly.
  * Slot generation returns `[]` on leave dates.
  * Leave rollback test passed: a simulated in-transaction failure left no partial leave, appointment cancellation, reservation release, or outbox jobs.
  * Booking-vs-leave race test passed across repeated simultaneous operations: final state never contained both a leave record and an active `BOOKED` appointment for the same doctor/date; no duplicate appointment, active booked reservation, leave, or cancellation job set remained.
  * 28 appointment-view/cancellation/rescheduling tests passed.
  * Cancellation rollback test passed: a simulated in-transaction failure left the appointment `BOOKED`, the old reservation `BOOKED` and linked, and created no partial outbox jobs.
  * Cancellation slot-availability test passed: cancelling a booking releases the slot and the existing public slot-generation endpoint returns it again.
  * Reschedule rollback test passed: a simulated in-transaction failure preserved the old appointment, old reservation, new hold, and outbox count.
  * Repeated reschedule test passed: repeating the same `newReservationId` returned the existing appointment with one linked `BOOKED` reservation and one set of reschedule outbox jobs.
  * Simultaneous competing reschedule test passed: 10 concurrent reschedule attempts left exactly one final `BOOKED` reservation linked to the appointment and exactly one set of reschedule outbox jobs.
  * 22 appointment-booking tests passed.
  * Transaction rollback test passed: a simulated in-transaction failure left no partial appointment, no partial outbox jobs, and the reservation remained an active `HOLD`.
  * Simultaneous confirmation test passed: 10 concurrent confirmation requests for the same reservation resulted in exactly 1 appointment, exactly 1 `BOOKED` reservation linked to it, and exactly 4 booking outbox jobs.
  * 20 slot-hold tests still passed.
  * 17 doctor discovery/slot-generation tests still passed.
  * 15 admin doctor-management tests still passed.
  * 12 auth/RBAC tests still passed.
* `npm.cmd run typecheck:server` - passed.
* `npm.cmd run build:client` - passed.
* `npm.cmd run build:server` - passed.
* `npm.cmd audit --audit-level=moderate` - passed with 0 vulnerabilities.
* Compiled backend startup check with current local env - passed; `GET /api/health` returned `{"status":"ok"}`.
* Git hygiene check - no tracked `.env`, no tracked local secrets, and build artifacts remain ignored.

## Known Issues

* Database-backed tests require a reachable PostgreSQL database configured through local `server/.env`.
* Scheduling currently assumes a single application timezone: UTC.
* The frontend has not yet implemented slot hold, appointment booking, cancellation, rescheduling, leave-management UI, doctor visit completion UI, AI summary display, or medication reminder UI.
* No background cleanup worker exists yet; expired holds are handled lazily for exact-slot replacement.
* No full outbox worker loop exists yet; Milestones 10 and 12 provide directly invokable `PRE_VISIT_SUMMARY` and `POST_VISIT_SUMMARY` job handlers, and Milestone 13 provides a due-reminder query for future worker use.
* Medication reminder delivery is not implemented yet; Milestone 13 creates durable reminder rows only.
* Automated tests and local development use deterministic mock LLM mode unless local OpenAI credentials are explicitly configured.
* A prior unrelated Neon sample table drift involving `playing_with_neon` was removed manually. The latest read-only Prisma/database verification reported migrations up to date and no remaining schema drift.
* A post-application `prisma migrate deploy` recheck timed out acquiring Prisma's PostgreSQL advisory migration lock through the Neon pooler. The Milestone 13 migration had already applied successfully with `prisma migrate dev`, and `prisma migrate status` immediately afterward reported the database schema up to date.

## Blocked by Credentials / Human Action

None for Milestone 13.

## Next Action

Begin Milestone 14 - Email Notifications.
