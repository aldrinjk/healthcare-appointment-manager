# System Design

The system treats PostgreSQL as the source of truth for appointment state. External providers such as email, LLMs, and Google Calendar are never required to commit a booking, cancellation, reschedule, or doctor-leave change.

## Double-booking prevention

Slot availability checks are useful for user experience, but the database is the final concurrency guard. `SlotReservation` has a PostgreSQL partial unique index on `(doctorId, startAt)` for active reservation states, currently `HOLD` and `BOOKED`. A patient must first create a hold, and booking confirmation converts that hold to `BOOKED` inside a transaction.

The hold service does not rely on a simple “check then insert” flow. Before inserting a replacement hold it lazily expires an old conflicting expired hold, then attempts the insert and translates a Prisma unique-conflict error into HTTP `409`. Concurrent hold tests use the real database and verify exactly one active hold survives.

Booking confirmation also runs transactionally. It validates the patient-owned hold, doctor schedule, leave state, appointment conflicts, and future slot timing before creating the appointment, converting the reservation, and creating outbox jobs. Repeated or concurrent confirmation cannot create duplicate appointments.

## Doctor leave conflict handling

Doctor leave is recorded by admin-only APIs using UTC calendar dates. Leave creation runs in a serializable transaction. If booked appointments exist for that doctor/date, the same transaction creates the leave, cancels affected `BOOKED` appointments, releases linked booked reservations, and creates durable notification/calendar outbox jobs.

Booking confirmation rechecks leave inside its own serializable transaction. In a booking-vs-leave race, either the leave wins and booking fails, or booking wins and leave creation cancels that appointment. The final database state must not contain both leave and an active booked appointment for the same doctor/date.

## Slot hold mechanism

Patients hold slots through `POST /api/appointments/hold`. A hold expires after about five minutes. Expired holds are not allowed to block generated availability: slot generation ignores expired holds, and hold creation lazily marks an exact-slot expired hold as `EXPIRED` before attempting a new hold.

The same patient requesting an already active hold receives that existing reservation. Competing patients receive `409` if the active hold or booking already exists.

## Notification failure handling

Domain transactions create durable `OutboxJob` rows for external work instead of calling providers directly. Booking, cancellation, rescheduling, and leave conflict handling all commit appointment/reservation state together with the relevant notification jobs. If email, AI, or calendar processing fails later, the committed appointment state remains intact.

Milestone 14 adds email processing around this outbox pattern. Email jobs are claimed atomically from due `PENDING` or retryable `FAILED` states into `PROCESSING`, sent through an email provider abstraction, and then marked `COMPLETED` or `FAILED`. Retries are bounded with deterministic backoff and sanitized error storage. The mock provider is the default for development/tests; the SMTP adapter is enabled only with local SMTP environment variables.

Appointment reminder email jobs are created transactionally during booking, normally scheduled about 24 hours before the appointment. If the appointment is less than 24 hours away, the reminder is due immediately. Cancellation deactivates pending reminders, and rescheduling replaces the old reminder with one for the new time. Medication reminder delivery works from due `MedicationReminder` rows and marks them `SENT` or retryable `FAILED` without altering appointment or prescription truth.
