# Implementation Status

## Current Milestone

Milestone 8 - Appointment Views, Cancellation and Rescheduling is next. Milestone 7 is complete.

## Completed

* Milestone 1 - Foundation.
* Milestone 2 - Database Schema.
* Milestone 3 - Authentication and RBAC.
* Milestone 4 - Doctor Administration.
* Milestone 5 - Doctor Search and Slot Generation.
* Milestone 6 - Slot Hold.
* Milestone 7 - Appointment Booking.
* Added patient-only `POST /api/appointments`.
* Added transactional conversion of patient-owned active `HOLD` reservations into `BOOKED` appointments.
* Booking stores trimmed patient symptoms and sets `preSummaryStatus` to `PENDING`.
* Booking calculates appointment `endAt` from the doctor's configured slot duration and revalidates the UTC schedule/leave state during confirmation.
* Booking atomically links the `SlotReservation` to the created `Appointment`.
* Booking atomically creates four durable `PENDING` outbox jobs: `BOOKING_CONFIRMATION_PATIENT`, `BOOKING_CONFIRMATION_DOCTOR`, `PRE_VISIT_SUMMARY`, and `CALENDAR_CREATE`.
* No email, LLM, or Google Calendar provider is called inside the booking transaction.
* Repeated confirmation of an already-booked patient-owned reservation returns the existing appointment without creating duplicates.
* Added rollback and simultaneous-confirmation tests proving no partial appointment/jobs remain on transaction failure and only one appointment/outbox set survives a race.

## In Progress

None.

## Tests Passing

Milestone 7 verification completed on 2026-08-20:

* `npm.cmd run test:server` - passed with 86 tests, 0 failures.
  * 22 appointment-booking tests passed.
  * Transaction rollback test passed: a simulated in-transaction failure left no partial appointment, no partial outbox jobs, and the reservation remained an active `HOLD`.
  * Simultaneous confirmation test passed: 10 concurrent confirmation requests for the same reservation resulted in exactly 1 appointment, exactly 1 `BOOKED` reservation linked to it, and exactly 4 booking outbox jobs.
  * 20 slot-hold tests still passed.
  * 17 doctor discovery/slot-generation tests still passed.
  * 15 admin doctor-management tests still passed.
  * 12 auth/RBAC tests still passed.
* `npm.cmd run build:client` - passed.
* `npm.cmd run typecheck:server` - passed.
* `npm.cmd run build:server` - passed.
* `npm.cmd audit --audit-level=moderate` - passed with 0 vulnerabilities.
* Compiled backend startup check with current local env - passed; `GET /api/health` returned `{"status":"ok"}`.
* Git hygiene check - no tracked `.env`, no tracked local secrets, and build artifacts remain ignored.

## Known Issues

* Database-backed tests require a reachable PostgreSQL database configured through local `server/.env`.
* Scheduling currently assumes a single application timezone: UTC.
* The frontend has not yet implemented slot hold or appointment booking UI; Milestone 7 covers backend APIs only.
* No background cleanup worker exists yet; expired holds are handled lazily for exact-slot replacement.
* No outbox worker exists yet; Milestone 7 only creates durable outbox jobs transactionally.

## Blocked by Credentials / Human Action

None for Milestone 7.

## Next Action

Begin Milestone 8 - Appointment Views, Cancellation and Rescheduling.
