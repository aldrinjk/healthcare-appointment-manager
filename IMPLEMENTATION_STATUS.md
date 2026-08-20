# Implementation Status

## Current Milestone

Milestone 9 - Doctor Leave Conflict Handling is next. Milestone 8 is complete.

## Completed

* Milestone 1 - Foundation.
* Milestone 2 - Database Schema.
* Milestone 3 - Authentication and RBAC.
* Milestone 4 - Doctor Administration.
* Milestone 5 - Doctor Search and Slot Generation.
* Milestone 6 - Slot Hold.
* Milestone 7 - Appointment Booking.
* Milestone 8 - Appointment Views, Cancellation and Rescheduling.
* Added patient-only `GET /api/appointments/me`.
* Added patient-only `GET /api/appointments/:id`.
* Added patient-only `DELETE /api/appointments/:id`.
* Added patient-only `PATCH /api/appointments/:id/reschedule`.
* Appointment view responses return only the authenticated patient's appointments with safe doctor/profile, status, symptoms, summary status, post-visit, and prescription data.
* Cancellation transactionally marks `BOOKED` appointments as `CANCELLED`, releases the linked `BOOKED` reservation as `RELEASED`, and creates three durable `PENDING` outbox jobs.
* Repeated cancellation returns `409` and does not create duplicate cancellation jobs.
* Rescheduling uses a patient-owned active `HOLD`, revalidates UTC schedule/leave/conflict rules, updates appointment doctor/time, books the new reservation, releases the old reservation, and creates three durable `PENDING` outbox jobs in one transaction.
* Rescheduling to a different doctor is allowed when the new held slot is valid.
* Repeated reschedule with the same already-booked reservation returns the existing appointment without duplicate state/jobs.
* Cancellation and rescheduling mutations use PostgreSQL serializable transactions to avoid unsafe concurrent state changes.
* Added rollback and race tests proving cancellation/rescheduling do not leave partial appointment, reservation, or outbox state.

## In Progress

None.

## Tests Passing

Milestone 8 verification completed on 2026-08-20:

* `npm.cmd run test:server` - passed with 114 tests, 0 failures.
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
* `npm.cmd run build:client` - passed.
* `npm.cmd run typecheck:server` - passed.
* `npm.cmd run build:server` - passed.
* `npm.cmd audit --audit-level=moderate` - passed with 0 vulnerabilities.
* Compiled backend startup check with current local env - passed; `GET /api/health` returned `{"status":"ok"}`.
* Git hygiene check - no tracked `.env`, no tracked local secrets, and build artifacts remain ignored.

## Known Issues

* Database-backed tests require a reachable PostgreSQL database configured through local `server/.env`.
* Scheduling currently assumes a single application timezone: UTC.
* The frontend has not yet implemented slot hold, appointment booking, cancellation, or rescheduling UI; Milestone 8 covers backend APIs only.
* No background cleanup worker exists yet; expired holds are handled lazily for exact-slot replacement.
* No outbox worker exists yet; Milestone 8 only creates durable outbox jobs transactionally.

## Blocked by Credentials / Human Action

None for Milestone 8.

## Next Action

Begin Milestone 9 - Doctor Leave Conflict Handling.
