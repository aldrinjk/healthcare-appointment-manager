# Implementation Status

## Current Milestone

Milestone 4 - Doctor Administration is next. Milestone 4 has not been started.

## Completed

* Milestone 1 - Foundation.
* Milestone 2 - Database Schema.
* Milestone 3 - Authentication and RBAC.
* Implemented public patient registration at `POST /api/auth/register`.
* Implemented login at `POST /api/auth/login`.
* Implemented authenticated user lookup at `GET /api/auth/me`.
* Added bcrypt password hashing and verification.
* Added JWT signing and verification using local `JWT_SECRET`.
* Added `authenticate` middleware for Bearer tokens.
* Added `requireRole` middleware for role-based authorization.
* Added test-only RBAC probe routes mounted only when `NODE_ENV=test`.
* Added automated auth/RBAC tests for registration, duplicate registration, public role blocking, login, token rejection, role denial, admin access, and `/auth/me`.

## In Progress

None.

## Tests Passing

Milestone 3 verification completed on 2026-08-20:

* `npm.cmd run test:server` - passed with 12 tests, 0 failures.
* `npm.cmd run build:client` - passed.
* `npm.cmd run typecheck:server` - passed.
* `npm.cmd run build:server` - passed.
* `npm.cmd audit --audit-level=moderate` - passed with 0 vulnerabilities.
* Compiled backend startup check with current local env - passed.
* Git hygiene check - no tracked `.env`, no tracked local secrets, and build artifacts remain ignored.

## Known Issues

* Auth/RBAC tests require a reachable PostgreSQL database configured through local `server/.env`.
* The frontend has not yet implemented login or registration screens; Milestone 3 covers backend authentication and authorization behavior.

## Blocked by Credentials / Human Action

None for Milestone 3.

## Next Action

Begin Milestone 4 - Doctor Administration by implementing admin-only doctor profile and availability management APIs behind `authenticate` and `requireRole(UserRole.ADMIN)`.
