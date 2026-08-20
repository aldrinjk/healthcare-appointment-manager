# Implementation Status

## Current Milestone

Milestone 7 - Appointment Booking is next. Milestone 7 has not been started.

## Completed

* Milestone 1 - Foundation.
* Milestone 2 - Database Schema.
* Milestone 3 - Authentication and RBAC.
* Milestone 4 - Doctor Administration.
* Milestone 5 - Doctor Search and Slot Generation.
* Milestone 6 - Slot Hold.
* Added patient-only `POST /api/appointments/hold`.
* Added reusable base slot-generation helper so hold validation uses the same UTC schedule rules as public slot generation.
* Added hold creation with approximately five-minute expiry.
* Added lazy expired-hold handling by marking exact-slot expired `HOLD` reservations as `EXPIRED` before attempting a replacement.
* Kept PostgreSQL partial unique index `SlotReservation_active_doctor_start_key` as the final active-slot concurrency guarantee.
* Added deterministic same-patient behavior: an already-held active slot returns the existing reservation with HTTP 200.
* Translated Prisma unique conflicts into HTTP 409.

## In Progress

None.

## Tests Passing

Milestone 6 verification completed on 2026-08-20:

* `npm.cmd run test:server` - passed with 64 tests, 0 failures.
  * 20 slot-hold tests passed.
  * Critical simultaneous hold test passed: 10 concurrent patient requests produced exactly 1 success, 9 conflicts, and exactly 1 active `HOLD` in PostgreSQL afterward.
  * Expired-hold replacement race test passed: 10 concurrent replacement requests produced exactly 1 success, 9 conflicts, and exactly 1 active `HOLD` in PostgreSQL afterward.
  * 17 doctor discovery/slot-generation tests still passed.
  * 15 admin doctor-management tests still passed.
  * 12 auth/RBAC tests still passed.
* `npm.cmd run build:client` - passed.
* `npm.cmd run typecheck:server` - passed.
* `npm.cmd run build:server` - passed.
* `npm.cmd audit --audit-level=moderate` - passed with 0 vulnerabilities.
* Compiled backend startup check with current local env - passed.
* Git hygiene check - no tracked `.env`, no tracked local secrets, and build artifacts remain ignored.

## Known Issues

* Database-backed tests require a reachable PostgreSQL database configured through local `server/.env`.
* Scheduling currently assumes a single application timezone: UTC.
* The frontend has not yet implemented slot hold UI; Milestone 6 covers backend APIs only.
* No background cleanup worker exists yet; expired holds are handled lazily for exact-slot replacement.

## Blocked by Credentials / Human Action

None for Milestone 6.

## Next Action

Begin Milestone 7 - Appointment Booking by converting valid patient-owned holds into confirmed appointments transactionally, preserving double-booking protection, storing symptoms, and creating durable outbox jobs without calling external APIs inside the booking transaction.
