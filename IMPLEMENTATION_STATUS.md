# Implementation Status

## Current Milestone

Milestone 10 - Pre-Visit AI Summary is next. Milestone 9 is complete.

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
* Extended admin-only `POST /api/admin/doctors/:id/leave` to handle existing booked appointments on the leave date.
* Leave creation now uses a PostgreSQL serializable Prisma transaction with bounded retry for serialization conflicts.
* Leave creation validates the doctor/date, prevents duplicate leave entries, creates the leave, cancels affected `BOOKED` appointments, releases linked `BOOKED` reservations as `RELEASED`, and creates durable outbox jobs atomically.
* Leave handling does not cancel already `CANCELLED` or `COMPLETED` appointments.
* Leave cancellation outbox jobs are `DOCTOR_LEAVE_CANCELLATION_PATIENT`, `DOCTOR_LEAVE_CANCELLATION_DOCTOR`, and `CALENDAR_DELETE`.
* Duplicate leave creation returns `409` and creates no duplicate cancellation jobs.
* Existing `DELETE /api/admin/doctors/:id/leave/:leaveId` still deletes only the leave record and does not restore cancelled appointments or reservations.
* Appointment booking confirmation now runs under serializable isolation with bounded retry, so booking-vs-leave races cannot leave both a leave record and an active booked appointment for the same doctor/date.
* Existing patient cancellation/rescheduling transaction tests were tightened to assert outbox rollback per appointment, avoiding unrelated concurrent test-suite outbox rows.

## In Progress

None.

## Tests Passing

Milestone 9 verification completed on 2026-08-20:

* `npm.cmd run test:server` - passed with 133 tests, 0 failures.
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
* `npm.cmd run build:client` - passed.
* `npm.cmd run typecheck:server` - passed.
* `npm.cmd run build:server` - passed.
* `npm.cmd audit --audit-level=moderate` - passed with 0 vulnerabilities.
* Compiled backend startup check with current local env - passed; `GET /api/health` returned `{"status":"ok"}`.
* Git hygiene check - no tracked `.env`, no tracked local secrets, and build artifacts remain ignored.

## Known Issues

* Database-backed tests require a reachable PostgreSQL database configured through local `server/.env`.
* Scheduling currently assumes a single application timezone: UTC.
* The frontend has not yet implemented slot hold, appointment booking, cancellation, rescheduling, or leave-management UI; Milestone 9 covers backend APIs only.
* No background cleanup worker exists yet; expired holds are handled lazily for exact-slot replacement.
* No outbox worker exists yet; Milestone 9 only creates durable outbox jobs transactionally.

## Blocked by Credentials / Human Action

None for Milestone 9.

## Next Action

Begin Milestone 10 - Pre-Visit AI Summary.
