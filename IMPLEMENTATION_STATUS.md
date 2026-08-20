# Implementation Status

## Current Milestone

Milestone 6 - Slot Hold is next. Milestone 6 has not been started.

## Completed

* Milestone 1 - Foundation.
* Milestone 2 - Database Schema.
* Milestone 3 - Authentication and RBAC.
* Milestone 4 - Doctor Administration.
* Milestone 5 - Doctor Search and Slot Generation.
* Added public doctor discovery routes under `/api/doctors`.
* Added case-insensitive specialization filtering.
* Added public doctor detail responses with profile, availability, and future leave data.
* Added UTC-based slot generation for `GET /api/doctors/:id/slots?date=YYYY-MM-DD`.
* Slot generation now considers weekday availability, slot duration, leave, active `HOLD` reservations, `BOOKED` reservations, non-cancelled appointments, expired holds, past times, and working-hours boundaries.
* Documented the UTC scheduling simplification in README.

## In Progress

None.

## Tests Passing

Milestone 5 verification completed on 2026-08-20:

* `npm.cmd run test:server` - passed with 44 tests, 0 failures.
  * 17 doctor discovery/slot-generation tests passed.
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
* The frontend has not yet implemented patient doctor-search screens; Milestone 5 covers backend APIs only.

## Blocked by Credentials / Human Action

None for Milestone 5.

## Next Action

Begin Milestone 6 - Slot Hold by implementing `POST /api/appointments/hold`, validating slots against doctor schedule/leave, creating expiring `HOLD` reservations, and relying on database uniqueness for conflict protection.
