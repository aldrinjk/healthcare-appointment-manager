# Implementation Status

## Current Milestone

Milestone 5 - Doctor Search and Slot Generation is next. Milestone 5 has not been started.

## Completed

* Milestone 1 - Foundation.
* Milestone 2 - Database Schema.
* Milestone 3 - Authentication and RBAC.
* Milestone 4 - Doctor Administration.
* Added admin-only doctor-management routes under `/api/admin/doctors`.
* Added transactional doctor creation that creates a `User` with role `DOCTOR` and a linked `DoctorProfile`.
* Added safe doctor list/detail responses without `passwordHash`.
* Added safe doctor updates for name, specialization, and slot duration.
* Added doctor availability creation with weekday/time validation and duplicate rejection.
* Added doctor leave creation/removal with date validation and duplicate rejection.
* Kept leave-triggered appointment cancellation out of scope for Milestone 4.

## In Progress

None.

## Tests Passing

Milestone 4 verification completed on 2026-08-20:

* `npm.cmd run test:server` - passed with 27 tests, 0 failures.
  * 15 admin doctor-management tests passed.
  * 12 existing auth/RBAC tests still passed.
* `npm.cmd run build:client` - passed.
* `npm.cmd run typecheck:server` - passed.
* `npm.cmd run build:server` - passed.
* `npm.cmd audit --audit-level=moderate` - passed with 0 vulnerabilities.
* Compiled backend startup check with current local env - passed.
* Git hygiene check - no tracked `.env`, no tracked local secrets, and build artifacts remain ignored.

## Known Issues

* Database-backed tests require a reachable PostgreSQL database configured through local `server/.env`.
* The frontend has not yet implemented admin dashboard screens; Milestone 4 covers backend APIs only.

## Blocked by Credentials / Human Action

None for Milestone 4.

## Next Action

Begin Milestone 5 - Doctor Search and Slot Generation by implementing patient-facing doctor list/detail and available-slot generation that considers working hours, leave, booked slots, and active holds.
