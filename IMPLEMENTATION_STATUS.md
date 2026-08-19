# Implementation Status

## Current Milestone

Milestone 3 - Authentication and RBAC is next. Milestone 3 has not been started.

## Completed

* Milestone 1 - Foundation.
* Milestone 2 - Database Schema.
* Added Prisma enums for user roles, weekdays, appointment status, reservation status, AI summary status, urgency, prescription frequency, medication reminder status, and outbox job status.
* Added Prisma models: `User`, `DoctorProfile`, `DoctorAvailability`, `DoctorLeave`, `Appointment`, `SlotReservation`, `Prescription`, `MedicationReminder`, and `OutboxJob`.
* Added relations, timestamps, indexes, and basic database check constraints.
* Added PostgreSQL partial unique index `SlotReservation_active_doctor_start_key` for active `HOLD`/`BOOKED` reservations by doctor/start time.
* Created and applied initial migration `20260819214217_init_schema` against the configured PostgreSQL database.
* Added idempotent development seed script.
* Seeded one admin, one patient, three doctors, and weekday doctor availability schedules.
* Documented working migration, seed, and development credential instructions in README.

## In Progress

None.

## Tests Passing

Milestone 2 verification completed on 2026-08-20:

* `npm.cmd install` - passed.
* `npm.cmd run prisma:validate` - passed.
* `npm.cmd run prisma:generate` - passed.
* `npm.cmd run prisma:migrate --workspace server -- --name init_schema --create-only` - passed.
* `npm.cmd run prisma:migrate --workspace server` - passed and applied migration `20260819214217_init_schema`.
* `npm.cmd run db:seed` - passed with 5 users, 3 doctors, and 15 availability rules.
* Read-only database verification - passed with 1 admin, 1 patient, 3 doctors, 15 availability rules, and active slot index present.
* `npm.cmd run build:client` - passed.
* `npm.cmd run typecheck:server` - passed.
* `npm.cmd run build:server` - passed.
* `npm.cmd audit --audit-level=moderate` - passed with 0 vulnerabilities.

## Known Issues

* Prisma and seed commands require a valid local `server/.env` with `DATABASE_URL`.
* No automated application tests exist yet; critical tests begin after behavior is implemented in later milestones.

## Blocked by Credentials / Human Action

None for Milestone 2.

## Next Action

Begin Milestone 3 - Authentication and RBAC by implementing registration/login, JWT handling, bcrypt verification, authentication middleware, role middleware, and authorization tests.
